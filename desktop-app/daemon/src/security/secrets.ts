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
}

const EMPTY: SecretsFile = { version: VERSION, accounts: {} };

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
