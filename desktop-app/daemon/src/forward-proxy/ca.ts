import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tlsDir } from "../paths.ts";
import {
  bitString,
  boolean as derBoolean,
  explicit,
  implicit,
  integer,
  nullValue,
  octetString,
  oid,
  sequence,
  set,
  smallInteger,
  utcTime,
  utf8String,
} from "./der.ts";

/**
 * The local certificate authority the forward proxy terminates TLS with. See PLAN.md §Phase 2.
 *
 * An app configured with an HTTP proxy sends `CONNECT api.vrchat.cloud:443` and then speaks TLS to
 * whatever answers. Routing that to the plaintext mirror on `:7774` therefore means being the TLS
 * server for a hostname we do not own, which is only possible with a certificate the client
 * trusts — so the daemon issues its own, from a CA the user installs once.
 *
 * Three properties this is built to have, in order of how badly they bite when absent:
 *
 *  - **The CA private key never leaves the state directory, at `0600`.** Anyone holding it can
 *    impersonate every site the user's browser trusts, not merely VRChat. It is the most dangerous
 *    single file vrc.zip creates — more so than `secrets.enc`, whose blast radius stops at the
 *    user's own VRChat accounts.
 *  - **The leaf covers exactly the intercepted hosts and nothing else.** A wildcard, or a leaf
 *    carrying hosts we do not actually intercept, would let Chromium coalesce an unrelated origin
 *    onto this connection and hand us traffic we have no business decrypting.
 *  - **It is stable across restarts.** A CA regenerated on every boot is a CA the user must
 *    re-install on every boot, and the reflex that teaches — click through the warning — is exactly
 *    the one that makes the whole scheme unsafe.
 */

/** OIDs, spelled once. */
const OID = {
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyIdentifier: "2.5.29.14",
  authorityKeyIdentifier: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

const DAY_MS = 86_400_000;

/** Ten years. The CA is installed by hand, so asking the user to do it again is a real cost. */
const CA_LIFETIME_DAYS = 3650;

/**
 * 397 days. Chromium caps publicly-trusted leaves at 398 and exempts locally-installed roots, but
 * staying inside the public limit costs nothing and removes a whole class of "works in curl, fails
 * in Chrome" question. Renewal is automatic — only the CA ever needs a human.
 */
const LEAF_LIFETIME_DAYS = 397;

/** Reissue this far ahead of expiry, so nothing expires while the daemon is running. */
const LEAF_RENEW_WINDOW_DAYS = 30;

/** Replace the CA this far ahead of expiry, while the user is still around to install it. */
const CA_RENEW_WINDOW_DAYS = 90;

export interface TlsMaterial {
  /** PEM for `tls.cert`: the leaf first, then the CA, which is the order a chain is sent in. */
  readonly chainPem: string;
  /** PEM PKCS#8, for `tls.key`. */
  readonly leafKeyPem: string;
  /** The CA certificate the user installs. Public — safe to serve and to copy anywhere. */
  readonly caCertPem: string;
  /** Where `ca.crt` was written, so the startup banner can name a path the user can act on. */
  readonly caCertPath: string;
  /** The hostnames the leaf is valid for, normalised and sorted. */
  readonly hosts: readonly string[];
  /** True when this run minted a new CA, which means the user has to install it (again). */
  readonly caIsNew: boolean;
}

interface StoredLeafMeta {
  hosts: string[];
  notAfter: number;
}

/**
 * Loads the CA and leaf from the state directory, minting whatever is missing, expiring, or no
 * longer covers the requested host set.
 *
 * The CA is only replaced when it is absent or actually unusable, never merely because the leaf
 * needed reissuing — replacing it silently would break the user's installed trust anchor, and the
 * only symptom would be certificate errors in an app they did not touch.
 */
export async function loadOrCreateTlsMaterial(
  hosts: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<TlsMaterial> {
  const wanted = normaliseHosts(hosts);
  if (wanted.length === 0) {
    throw new Error("the forward proxy needs at least one host to intercept");
  }

  const dir = tlsDir(env);
  await mkdir(dir, { recursive: true });

  const paths = {
    caKey: join(dir, "ca.key"),
    caCert: join(dir, "ca.crt"),
    leafKey: join(dir, "leaf.key"),
    leafCert: join(dir, "leaf.crt"),
    leafMeta: join(dir, "leaf.json"),
  };

  const now = new Date();
  const existing = await readCa(paths.caKey, paths.caCert, now);
  const caIsNew = existing === null;
  const ca = existing ?? mintCa(now);
  if (caIsNew) {
    await writeSecret(paths.caKey, ca.keyPem);
    await writeFile(paths.caCert, ca.certPem, "utf8");
  }

  const reusable = await readLeaf(paths, wanted, now, caIsNew);
  const leaf = reusable ?? mintLeaf(wanted, ca, now);
  if (reusable === null) {
    await writeSecret(paths.leafKey, leaf.keyPem);
    await writeFile(paths.leafCert, leaf.certPem, "utf8");
    const meta: StoredLeafMeta = {
      hosts: [...wanted],
      notAfter: now.getTime() + LEAF_LIFETIME_DAYS * DAY_MS,
    };
    await writeFile(paths.leafMeta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  return {
    chainPem: leaf.certPem + ca.certPem,
    leafKeyPem: leaf.keyPem,
    caCertPem: ca.certPem,
    caCertPath: paths.caCert,
    hosts: wanted,
    caIsNew,
  };
}

/** Lowercased, de-duplicated, sorted — so a settings reorder is not a certificate reissue. */
export function normaliseHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const host of hosts) {
    const trimmed = host.trim().toLowerCase();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen].sort();
}

// --- persistence ------------------------------------------------------------

interface Issuer {
  readonly keyPem: string;
  readonly certPem: string;
  readonly privateKey: KeyObject;
  readonly subject: Uint8Array;
  readonly keyIdentifier: Uint8Array;
}

async function readCa(keyPath: string, certPath: string, now: Date): Promise<Issuer | null> {
  const keyPem = await readFile(keyPath, "utf8").catch(() => null);
  const certPem = await readFile(certPath, "utf8").catch(() => null);
  if (keyPem === null || certPem === null) return null;

  try {
    const privateKey = createPrivateKey(keyPem);
    // Parsed back rather than trusted: a truncated or hand-edited file has to fail here, where the
    // answer is "mint a new one", instead of later and less legibly inside a TLS handshake.
    const cert = new X509Certificate(certPem);
    if (new Date(cert.validTo).getTime() - now.getTime() < CA_RENEW_WINDOW_DAYS * DAY_MS) {
      return null;
    }

    return {
      keyPem,
      certPem,
      privateKey,
      subject: caName(),
      keyIdentifier: keyIdentifierOf(createPublicKey(privateKey)),
    };
  } catch {
    return null;
  }
}

async function readLeaf(
  paths: { leafKey: string; leafCert: string; leafMeta: string },
  wanted: readonly string[],
  now: Date,
  caIsNew: boolean,
): Promise<{ keyPem: string; certPem: string } | null> {
  // A fresh CA invalidates every leaf it did not sign, so there is nothing to reuse.
  if (caIsNew) return null;

  const [keyPem, certPem, metaRaw] = await Promise.all([
    readFile(paths.leafKey, "utf8").catch(() => null),
    readFile(paths.leafCert, "utf8").catch(() => null),
    readFile(paths.leafMeta, "utf8").catch(() => null),
  ]);
  if (keyPem === null || certPem === null || metaRaw === null) return null;

  let meta: StoredLeafMeta;
  try {
    meta = JSON.parse(metaRaw) as StoredLeafMeta;
  } catch {
    return null;
  }
  if (!Array.isArray(meta.hosts) || typeof meta.notAfter !== "number") return null;

  const covers =
    meta.hosts.length === wanted.length && meta.hosts.every((host, i) => host === wanted[i]);
  if (!covers) return null;
  if (meta.notAfter - now.getTime() < LEAF_RENEW_WINDOW_DAYS * DAY_MS) return null;

  return { keyPem, certPem };
}

/**
 * `0600`, and the `chmod` after the write is not redundant — `writeFile`'s `mode` only applies when
 * the file is created, so overwriting a leftover from an older run would keep the old permissions.
 */
async function writeSecret(path: string, pem: string): Promise<void> {
  await writeFile(path, pem, { mode: 0o600, encoding: "utf8" });
  await chmod(path, 0o600).catch(() => {});
}

// --- minting ----------------------------------------------------------------

function mintCa(now: Date): Issuer {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const subject = caName();
  const keyIdentifier = keyIdentifierOf(publicKey);

  const certificate = signCertificate({
    subject,
    issuer: subject,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + CA_LIFETIME_DAYS * DAY_MS),
    subjectPublicKey: publicKey,
    issuerPrivateKey: privateKey,
    extensions: [
      // `pathLenConstraint: 0` — this CA may sign leaves and never another CA. It is the one line
      // that stops a stolen key from being used to mint a *second* trusted issuer.
      extension(OID.basicConstraints, true, sequence(derBoolean(true), smallInteger(0))),
      // keyCertSign (bit 5) | cRLSign (bit 6), so seven bits are meaningful and one is padding.
      extension(OID.keyUsage, true, bitString(new Uint8Array([0x06]), 1)),
      extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier)),
    ],
  });

  return {
    keyPem: pkcs8Pem(privateKey),
    certPem: certificatePem(certificate),
    privateKey,
    subject,
    keyIdentifier,
  };
}

function mintLeaf(
  hosts: readonly string[],
  ca: Issuer,
  now: Date,
): { keyPem: string; certPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  const certificate = signCertificate({
    // The CN is cosmetic — every modern client reads `subjectAltName` and ignores it entirely — but
    // it is what a certificate viewer shows, so it says who issued this rather than repeating a
    // hostname vrc.zip does not own.
    subject: name("vrc.zip local mirror"),
    issuer: ca.subject,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + LEAF_LIFETIME_DAYS * DAY_MS),
    subjectPublicKey: publicKey,
    issuerPrivateKey: ca.privateKey,
    extensions: [
      // An empty SEQUENCE: `cA` is DEFAULT FALSE, and DER forbids encoding a field at its default.
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature (bit 0) | keyEncipherment (bit 2), so three bits are meaningful.
      extension(OID.keyUsage, true, bitString(new Uint8Array([0xa0]), 5)),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      // The extension that actually decides whether the client accepts us.
      extension(
        OID.subjectAltName,
        false,
        sequence(...hosts.map((host) => implicit(2, new TextEncoder().encode(host)))),
      ),
      extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifierOf(publicKey))),
      extension(OID.authorityKeyIdentifier, false, sequence(implicit(0, ca.keyIdentifier))),
    ],
  });

  return { keyPem: pkcs8Pem(privateKey), certPem: certificatePem(certificate) };
}

interface CertificateSpec {
  readonly subject: Uint8Array;
  readonly issuer: Uint8Array;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly subjectPublicKey: KeyObject;
  readonly issuerPrivateKey: KeyObject;
  readonly extensions: readonly Uint8Array[];
}

/**
 * `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }`.
 *
 * The algorithm identifier appears twice on purpose — once inside the signed body and once beside
 * the signature — and RFC 5280 requires the two to match. Emitting both from one expression is what
 * keeps that true if the algorithm ever changes.
 */
function signCertificate(spec: CertificateSpec): Uint8Array {
  const algorithm = sequence(oid(OID.sha256WithRsa), nullValue());

  const tbs = sequence(
    explicit(0, smallInteger(2)), // v3
    integer(new Uint8Array(randomBytes(16))),
    algorithm,
    spec.issuer,
    sequence(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    spec.subject,
    // `node:crypto` emits a complete `SubjectPublicKeyInfo`, which is exactly this field.
    new Uint8Array(spec.subjectPublicKey.export({ format: "der", type: "spki" })),
    explicit(3, sequence(...spec.extensions)),
  );

  const signature = createSign("SHA256").update(tbs).sign(spec.issuerPrivateKey);
  return sequence(tbs, algorithm, bitString(new Uint8Array(signature)));
}

/** `Extension ::= SEQUENCE { extnID, critical DEFAULT FALSE, extnValue OCTET STRING }`. */
function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  // DER omits a field sitting at its DEFAULT, so `critical: false` must be absent, not encoded.
  return critical
    ? sequence(oid(id), derBoolean(true), octetString(value))
    : sequence(oid(id), octetString(value));
}

function caName(): Uint8Array {
  return name("vrc.zip local proxy CA", "vrc.zip (UNOFFICIAL)");
}

function name(commonName: string, organization?: string): Uint8Array {
  const rdns = [set(sequence(oid(OID.commonName), utf8String(commonName)))];
  if (organization !== undefined) {
    rdns.unshift(set(sequence(oid(OID.organizationName), utf8String(organization))));
  }
  return sequence(...rdns);
}

/**
 * A key identifier: SHA-1 over the encoded `SubjectPublicKeyInfo`.
 *
 * RFC 5280 §4.2.1.2 describes hashing the public key BIT STRING and then adds that other methods
 * are acceptable — the field only has to be a stable, unique label linking a leaf to its issuer,
 * and nothing verifies how it was derived. Hashing the whole SPKI avoids parsing DER back, which is
 * the only reason this module would need a decoder at all.
 */
function keyIdentifierOf(publicKey: KeyObject): Uint8Array {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return new Uint8Array(createHash("sha1").update(spki).digest());
}

function pkcs8Pem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

function certificatePem(der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
