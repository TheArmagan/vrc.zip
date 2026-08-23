import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cookie } from "../accounts/cookie-jar.ts";
import { secretsPath } from "../paths.ts";
import { KEY_BYTES, type MasterKey } from "./keychain.ts";

/**
 * `secrets.enc` — AES-256-GCM over the per-account credential blob, unlocked by the master key from
 * the OS keychain. See PLAN.md §1.2.
 *
 * File layout, all binary, no encoding overhead:
 *
 *   magic "VRCZSEC\0" (8) | version (1) | iv (12) | tag (16) | ciphertext (rest)
 *
 * The magic and version bytes are passed to GCM as additional authenticated data, so a file whose
 * header has been edited fails authentication rather than being decrypted into something
 * unexpected. There is no KDF because there is no password: the key is 32 random bytes from the
 * keychain, already full-entropy.
 */

const MAGIC = Buffer.from("VRCZSEC\0", "latin1");
const VERSION = 1;
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for.
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1;

/** What we hold for one account. Everything here is a credential. */
export interface AccountSecret {
  /** The VRChat username or email used to log in. Not the display name. */
  username: string;
  /**
   * Optional by design. A user who would rather re-enter it than store it gets that choice, and the
   * daemon still works from cookies alone until they expire.
   */
  password?: string;
  /** Base32 TOTP seed, when the user opted into automatic 2FA. */
  totpSecret?: string;
  /** Both `auth` and `twoFactorAuth` must survive a restart. See PLAN.md §1.2. */
  cookies: Cookie[];
}

export interface SecretsFile {
  version: number;
  /** Keyed by VRChat user id (`usr_…`) once known, otherwise by a local id. */
  accounts: Record<string, AccountSecret>;
  /**
   * Values a node graph needs and the graph document must not carry — a webhook URL, a topic, a
   * token. Keyed by {@link graphSecretKey}.
   *
   * **Optional, and the version was deliberately not bumped for it.** `open` refuses a payload
   * whose version it does not know, so bumping would turn every existing install's credential store
   * into a hard error on the next start. An absent field reads as an empty map and appears on the
   * next flush, which is what a backwards-compatible addition looks like here.
   */
  graphSecrets?: Record<string, string>;
}

const EMPTY: SecretsFile = { version: VERSION, accounts: {} };

/**
 * The key one graph secret is stored under.
 *
 * Newlines as the separator because none of the three parts can contain one: a graph id is a uuid
 * and the other two are node and field ids from a definition. A separator a part could contain is
 * how two different secrets end up sharing a key.
 */
export function graphSecretKey(graphId: string, nodeId: string, fieldId: string): string {
  return `${graphId}\n${nodeId}\n${fieldId}`;
}

export class SecretsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SecretsError";
  }
}

export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new SecretsError(`master key must be ${KEY_BYTES} bytes`);

  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.of(VERSION)]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(file: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new SecretsError(`master key must be ${KEY_BYTES} bytes`);
  if (file.length < HEADER_BYTES + IV_BYTES + TAG_BYTES) {
    throw new SecretsError("secrets file is truncated");
  }

  const magic = file.subarray(0, MAGIC.length);
  // timingSafeEqual on a public magic number is not about secrecy — it keeps the comparison
  // uniform with the rest of this file so nobody later copies a `===` from here onto a tag.
  if (magic.length !== MAGIC.length || !timingSafeEqual(magic, MAGIC)) {
    throw new SecretsError("secrets file is not a vrc.zip secrets store");
  }

  const version = file[MAGIC.length];
  if (version !== VERSION) {
    throw new SecretsError(`unsupported secrets file version ${String(version)}`);
  }

  const header = file.subarray(0, HEADER_BYTES);
  const iv = file.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const tag = file.subarray(HEADER_BYTES + IV_BYTES, HEADER_BYTES + IV_BYTES + TAG_BYTES);
  const ciphertext = file.subarray(HEADER_BYTES + IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    // Wrong key, or the file was tampered with. These are indistinguishable and that is correct.
    throw new SecretsError("secrets file failed authentication (wrong key or corrupt file)", {
      cause,
    });
  }
}

/**
 * The credential store.
 *
 * Held decrypted in memory for the process lifetime — the alternative is round-tripping the
 * keychain on every request, and the plaintext would be in memory during that call anyway.
 */
export class SecretsStore {
  #data: SecretsFile;

  private constructor(
    private readonly masterKey: MasterKey,
    private readonly path: string,
    data: SecretsFile,
  ) {
    this.#data = data;
  }

  static async open(masterKey: MasterKey, env?: NodeJS.ProcessEnv): Promise<SecretsStore> {
    const path = secretsPath(env);
    const raw = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new SecretsError(`could not read ${path}`, { cause: error });
    });

    if (raw === null) {
      // First run. Don't write anything yet — an empty store on disk is indistinguishable from one
      // whose accounts were lost, and writing it would make a later "why is this empty?" harder.
      return new SecretsStore(masterKey, path, structuredClone(EMPTY));
    }

    const plaintext = decrypt(raw, masterKey.key);
    const parsed = JSON.parse(plaintext.toString("utf8")) as SecretsFile;
    if (parsed.version !== VERSION) {
      throw new SecretsError(`unsupported secrets payload version ${String(parsed.version)}`);
    }
    return new SecretsStore(masterKey, path, parsed);
  }

  get backend(): MasterKey["backend"] {
    return this.masterKey.backend;
  }

  /** True when the master key is in a plain file. The UI shows a persistent warning while set. */
  get degraded(): boolean {
    return this.masterKey.degraded;
  }

  accountIds(): string[] {
    return Object.keys(this.#data.accounts);
  }

  get(accountId: string): AccountSecret | undefined {
    return this.#data.accounts[accountId];
  }

  async put(accountId: string, secret: AccountSecret): Promise<void> {
    this.#data.accounts[accountId] = secret;
    await this.flush();
  }

  async remove(accountId: string): Promise<void> {
    delete this.#data.accounts[accountId];
    await this.flush();
  }

  /* -- graph secrets ------------------------------------------------------- */

  /**
   * One graph secret, or undefined.
   *
   * The **only** reader is the graph engine, on its way to a node handler. There is deliberately no
   * route that returns one: a secret field is write-only in the UI, so a value that went in cannot
   * come back out through the API that put it there.
   */
  graphSecret(graphId: string, nodeId: string, fieldId: string): string | undefined {
    return this.#data.graphSecrets?.[graphSecretKey(graphId, nodeId, fieldId)];
  }

  async putGraphSecret(
    graphId: string,
    nodeId: string,
    fieldId: string,
    value: string,
  ): Promise<void> {
    this.#data.graphSecrets ??= {};
    this.#data.graphSecrets[graphSecretKey(graphId, nodeId, fieldId)] = value;
    await this.flush();
  }

  async removeGraphSecret(graphId: string, nodeId: string, fieldId: string): Promise<void> {
    if (this.#data.graphSecrets === undefined) return;
    delete this.#data.graphSecrets[graphSecretKey(graphId, nodeId, fieldId)];
    await this.flush();
  }

  /**
   * Drops every secret belonging to one graph. Called when the graph is deleted.
   *
   * Without it, deleting a graph would leave its webhook URLs and tokens in the credential store
   * forever, keyed to an id nothing will ever ask for again — invisible, unreachable, and still
   * there in a file the user believes holds their accounts.
   */
  async removeGraphSecrets(graphId: string): Promise<void> {
    const secrets = this.#data.graphSecrets;
    if (secrets === undefined) return;
    const prefix = `${graphId}\n`;
    let removed = false;
    for (const key of Object.keys(secrets)) {
      if (key.startsWith(prefix)) {
        delete secrets[key];
        removed = true;
      }
    }
    if (removed) await this.flush();
  }

  /**
   * Re-keys an account id, for when a locally-added account learns its real `usr_…` id after the
   * first successful login.
   */
  async rename(fromId: string, toId: string): Promise<void> {
    const secret = this.#data.accounts[fromId];
    if (!secret) throw new SecretsError(`no account ${fromId}`);
    delete this.#data.accounts[fromId];
    this.#data.accounts[toId] = secret;
    await this.flush();
  }

  /**
   * Writes atomically: encrypt to a temp file in the same directory, then rename over the target.
   * A crash mid-write must never leave a half-written credential store, because the failure mode is
   * "every account has to log in again," which costs sessions against an undisclosed cap.
   */
  async flush(): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(this.#data), "utf8");
    const encrypted = encrypt(plaintext, this.masterKey.key);

    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, encrypted, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, this.path);
  }
}
