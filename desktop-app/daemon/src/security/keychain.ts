import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fallbackKeyPath } from "../paths.ts";

/**
 * The master key: 32 random bytes that unlock `secrets.enc`.
 *
 * Stored in the OS keychain via a **CLI shim** rather than a native module — Windows Credential
 * Manager through PowerShell, libsecret through `secret-tool`. A native dependency would mean
 * prebuilt binaries per platform and per Bun version, for two calls that happen once at startup.
 *
 * When no keychain is reachable — headless Linux, a minimal WM, no libsecret — we fall back to a
 * `0600` file **and say so loudly**, because a file-backed key is meaningfully weaker and the user
 * is entitled to know. It is not a crash: refusing to run would strand exactly the users who are
 * least able to fix it. See PLAN.md §1.2 and the risk register.
 */

const SERVICE = "vrc.zip";
/** Set to `file` to skip the OS keychain entirely. See `loadOrCreateMasterKey`. */
const BACKEND_ENV = "VRCZIP_KEY_BACKEND";
const ACCOUNT = "master-key";

export type KeyBackend = "windows-credential-manager" | "libsecret" | "file";

export interface MasterKey {
  readonly key: Buffer;
  readonly backend: KeyBackend;
  /** True when the key sits in a plain file. The UI must surface this persistently. */
  readonly degraded: boolean;
}

export const KEY_BYTES = 32;

/**
 * P/Invoke over advapi32's CredRead/CredWrite. There is no built-in PowerShell cmdlet for generic
 * credentials — `cmdkey` can write one but cannot read the secret back — and requiring the
 * community `CredentialManager` module would be an install step we cannot assume. This is ~40 lines
 * of C# compiled on demand, and it is the supported Win32 API underneath every alternative.
 */
const CRED_SHIM_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VrczCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr cred);

  public static string Read(string target) {
    IntPtr ptr;
    if (!CredReadW(target, 1, 0, out ptr)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, (int)c.CredentialBlobSize);
      return Encoding.UTF8.GetString(blob);
    } finally { CredFree(ptr); }
  }

  public static void Write(string target, string user, string secret) {
    byte[] blob = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1;                 // CRED_TYPE_GENERIC
    c.Persist = 2;              // CRED_PERSIST_LOCAL_MACHINE
    c.TargetName = target;
    c.UserName = user;
    c.CredentialBlobSize = (uint)blob.Length;
    c.CredentialBlob = Marshal.AllocCoTaskMem(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new Exception("CredWriteW failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
}
`;

function psScript(body: string): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CRED_SHIM_CS}
'@
${body}`;
}

async function runPowerShell(body: string): Promise<{ ok: boolean; stdout: string }> {
  // `-NoProfile` matters: a user profile that prints a banner would corrupt the output we parse.
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", psScript(body)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { ok: exitCode === 0, stdout: stdout.trim() };
}

async function windowsRead(): Promise<Buffer | null> {
  const result = await runPowerShell(
    `$v = [VrczCred]::Read('${SERVICE}/${ACCOUNT}'); if ($v -ne $null) { Write-Output $v }`,
  ).catch(() => null);
  if (!result?.ok || result.stdout === "") return null;
  return Buffer.from(result.stdout, "base64");
}

async function windowsWrite(key: Buffer): Promise<boolean> {
  const result = await runPowerShell(
    `[VrczCred]::Write('${SERVICE}/${ACCOUNT}', '${ACCOUNT}', '${key.toString("base64")}')`,
  ).catch(() => null);
  return result?.ok === true;
}

function secretToolAvailable(): boolean {
  return Bun.which("secret-tool") !== null;
}

async function libsecretRead(): Promise<Buffer | null> {
  const proc = Bun.spawn(["secret-tool", "lookup", "service", SERVICE, "account", ACCOUNT], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  return trimmed === "" ? null : Buffer.from(trimmed, "base64");
}

async function libsecretWrite(key: Buffer): Promise<boolean> {
  const proc = Bun.spawn(
    ["secret-tool", "store", "--label=vrc.zip master key", "service", SERVICE, "account", ACCOUNT],
    { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  );
  proc.stdin.write(key.toString("base64"));
  await proc.stdin.end();
  return (await proc.exited) === 0;
}

async function fileRead(env?: NodeJS.ProcessEnv): Promise<Buffer | null> {
  const raw = await readFile(fallbackKeyPath(env), "utf8").catch(() => null);
  if (raw === null) return null;
  const key = Buffer.from(raw.trim(), "base64");
  return key.length === KEY_BYTES ? key : null;
}

async function fileWrite(key: Buffer, env?: NodeJS.ProcessEnv): Promise<void> {
  const path = fallbackKeyPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  // `mode` on writeFile only applies at creation, so an existing file keeps its old permissions.
  // Setting it explicitly afterwards is what actually guarantees 0600 on a rewrite. No-op on
  // Windows, where the ACL inherited from %LOCALAPPDATA% is already user-scoped.
  await chmod(path, 0o600).catch(() => {});
}

/**
 * Loads the master key, creating it on first run.
 *
 * Tries the platform keychain first and falls back to a `0600` file. The returned `degraded` flag is
 * not advisory — the UI is expected to show a persistent warning while it is true.
 */
export async function loadOrCreateMasterKey(env?: NodeJS.ProcessEnv): Promise<MasterKey> {
  // Forces the file-backed key. Tests use it so a run never writes to the developer's real
  // keychain, and it is a genuine escape hatch on a locked-down machine where the platform store
  // is present but unusable — without it, such a user has no way to reach the fallback.
  if ((env ?? process.env)[BACKEND_ENV] === "file") {
    const existing = await fileRead(env);
    if (existing) return { key: existing, backend: "file", degraded: true };
    const key = randomKey();
    await fileWrite(key, env);
    return { key, backend: "file", degraded: true };
  }

  if (process.platform === "win32") {
    const existing = await windowsRead();
    if (existing?.length === KEY_BYTES) {
      return { key: existing, backend: "windows-credential-manager", degraded: false };
    }
    const key = randomKey();
    if (await windowsWrite(key)) {
      return { key, backend: "windows-credential-manager", degraded: false };
    }
    // Credential Manager is unavailable (locked-down policy, PowerShell blocked). Fall through.
  } else if (secretToolAvailable()) {
    const existing = await libsecretRead();
    if (existing?.length === KEY_BYTES) {
      return { key: existing, backend: "libsecret", degraded: false };
    }
    const key = randomKey();
    if (await libsecretWrite(key)) {
      return { key, backend: "libsecret", degraded: false };
    }
    // secret-tool exists but no keyring daemon is running — a normal headless state.
  }

  const existing = await fileRead(env);
  if (existing) return { key: existing, backend: "file", degraded: true };

  const key = randomKey();
  await fileWrite(key, env);
  return { key, backend: "file", degraded: true };
}

function randomKey(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}
