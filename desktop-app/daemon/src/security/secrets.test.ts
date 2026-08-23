import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_BYTES, type MasterKey } from "./keychain.ts";
import { decrypt, encrypt, SecretsError, SecretsStore } from "./secrets.ts";

function masterKey(key: Buffer = randomBytes(KEY_BYTES)): MasterKey {
  return { key, backend: "file", degraded: true };
}

describe("encrypt/decrypt", () => {
  test("round-trips", () => {
    const key = randomBytes(KEY_BYTES);
    const plaintext = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    expect(decrypt(encrypt(plaintext, key), key)).toEqual(plaintext);
  });

  test("rejects the wrong key", () => {
    const sealed = encrypt(Buffer.from("secret"), randomBytes(KEY_BYTES));
    expect(() => decrypt(sealed, randomBytes(KEY_BYTES))).toThrow(SecretsError);
  });

  test("rejects a tampered ciphertext", () => {
    const key = randomBytes(KEY_BYTES);
    const sealed = encrypt(Buffer.from("secret"), key);
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] as number) ^ 0xff;
    expect(() => decrypt(sealed, key)).toThrow(/failed authentication/);
  });

  test("rejects a tampered header, because it is authenticated as AAD", () => {
    const key = randomBytes(KEY_BYTES);
    const sealed = encrypt(Buffer.from("secret"), key);
    sealed[8] = 99; // the version byte
    expect(() => decrypt(sealed, key)).toThrow(SecretsError);
  });

  test("rejects a file that is not ours, and a truncated one", () => {
    const key = randomBytes(KEY_BYTES);
    expect(() => decrypt(Buffer.alloc(64), key)).toThrow(/not a vrc.zip secrets store/);
    expect(() => decrypt(Buffer.from("VRCZSEC\0"), key)).toThrow(/truncated/);
  });

  test("uses a fresh nonce every time", () => {
    // A repeated nonce under the same key is catastrophic for GCM.
    const key = randomBytes(KEY_BYTES);
    const plaintext = Buffer.from("same input");
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.equals(b)).toBe(false);
  });

  test("refuses a key of the wrong length", () => {
    expect(() => encrypt(Buffer.from("x"), randomBytes(16))).toThrow(SecretsError);
  });
});

describe("SecretsStore", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vrczip-secrets-"));
    env = { VRCZIP_STATE_DIR: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("opens empty on first run without writing a file", () => {
    // An empty store on disk is indistinguishable from one whose accounts were lost.
    return SecretsStore.open(masterKey(), env).then(async (store) => {
      expect(store.accountIds()).toEqual([]);
      expect(await readFile(join(dir, "secrets.enc")).catch(() => null)).toBeNull();
    });
  });

  test("persists accounts across reopen", async () => {
    const key = masterKey();
    const store = await SecretsStore.open(key, env);
    await store.put("usr_a", {
      username: "alice@example.invalid",
      password: "hunter2",
      cookies: [
        { name: "auth", value: "authcookie_a", expiresAt: null },
        { name: "twoFactorAuth", value: "tfa_a", expiresAt: 4_102_444_800_000 },
      ],
    });

    const reopened = await SecretsStore.open(key, env);
    expect(reopened.accountIds()).toEqual(["usr_a"]);
    expect(reopened.get("usr_a")?.password).toBe("hunter2");
    // Both cookies must survive — losing twoFactorAuth means re-prompting 2FA on every restart.
    expect(reopened.get("usr_a")?.cookies.map((c) => c.name)).toEqual(["auth", "twoFactorAuth"]);
  });

  test("a different master key cannot open the store", async () => {
    const store = await SecretsStore.open(masterKey(), env);
    await store.put("usr_a", { username: "a", cookies: [] });
    await expect(SecretsStore.open(masterKey(), env)).rejects.toThrow(SecretsError);
  });

  test("the file on disk contains no plaintext credential", async () => {
    const store = await SecretsStore.open(masterKey(), env);
    await store.put("usr_a", {
      username: "alice@example.invalid",
      password: "correct-horse-battery-staple",
      totpSecret: "JBSWY3DPEHPK3PXP",
      cookies: [{ name: "auth", value: "authcookie_deadbeef", expiresAt: null }],
    });

    const raw = (await readFile(join(dir, "secrets.enc"))).toString("latin1");
    for (const secret of [
      "correct-horse-battery-staple",
      "JBSWY3DPEHPK3PXP",
      "authcookie_deadbeef",
      "alice@example.invalid",
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  test("keeps accounts isolated, and removes only what was asked for", async () => {
    const key = masterKey();
    const store = await SecretsStore.open(key, env);
    await store.put("usr_a", { username: "a", cookies: [] });
    await store.put("usr_b", { username: "b", cookies: [] });
    await store.remove("usr_a");

    const reopened = await SecretsStore.open(key, env);
    expect(reopened.accountIds()).toEqual(["usr_b"]);
  });

  test("renames a local id to the real usr_ id after first login", async () => {
    const key = masterKey();
    const store = await SecretsStore.open(key, env);
    await store.put("pending-1", { username: "a", cookies: [] });
    await store.rename("pending-1", "usr_real");

    const reopened = await SecretsStore.open(key, env);
    expect(reopened.accountIds()).toEqual(["usr_real"]);
    await expect(store.rename("nope", "x")).rejects.toThrow(SecretsError);
  });

  test("leaves no temp file behind after a flush", async () => {
    const store = await SecretsStore.open(masterKey(), env);
    await store.put("usr_a", { username: "a", cookies: [] });
    const leftovers = [...new Bun.Glob("*.tmp").scanSync({ cwd: dir })];
    expect(leftovers).toEqual([]);
  });
  test("graph secrets round-trip, and clear one at a time", async () => {
    const key = masterKey();
    const store = await SecretsStore.open(key, env);
    await store.putGraphSecret("g1", "n2", "token", "s3cret");
    await store.putGraphSecret("g1", "n3", "url", "https://example.invalid/hook");

    const reopened = await SecretsStore.open(key, env);
    expect(reopened.graphSecret("g1", "n2", "token")).toBe("s3cret");
    expect(reopened.graphSecret("g1", "n9", "token")).toBeUndefined();

    await reopened.removeGraphSecret("g1", "n2", "token");
    expect(reopened.graphSecret("g1", "n2", "token")).toBeUndefined();
    expect(reopened.graphSecret("g1", "n3", "url")).toBe("https://example.invalid/hook");
  });

  test("deleting a graph takes every secret it owns", async () => {
    // They live in `secrets.enc`, which has no foreign keys: without this, a deleted graph leaves
    // its webhook URLs in the credential store under an id nothing will ever ask for again.
    const store = await SecretsStore.open(masterKey(), env);
    await store.putGraphSecret("g1", "n1", "a", "one");
    await store.putGraphSecret("g1", "n2", "b", "two");
    await store.putGraphSecret("g2", "n1", "a", "other graph");

    await store.removeGraphSecrets("g1");

    expect(store.graphSecret("g1", "n1", "a")).toBeUndefined();
    expect(store.graphSecret("g1", "n2", "b")).toBeUndefined();
    expect(store.graphSecret("g2", "n1", "a")).toBe("other graph");
  });

  test("a store written before graph secrets existed still opens", async () => {
    // The payload version was deliberately not bumped for the new field: `open` refuses a version
    // it does not know, so bumping would turn every existing install into a hard error at start.
    const key = masterKey();
    const before = await SecretsStore.open(key, env);
    await before.put("usr_a", { username: "a", cookies: [] });

    const reopened = await SecretsStore.open(key, env);
    expect(reopened.graphSecret("g1", "n1", "token")).toBeUndefined();
    await reopened.putGraphSecret("g1", "n1", "token", "later");
    expect((await SecretsStore.open(key, env)).graphSecret("g1", "n1", "token")).toBe("later");
  });
});
