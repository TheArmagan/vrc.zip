import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { settingsPath } from "./paths.ts";

/**
 * User settings, stored in the clear. **Nothing secret goes here** — credentials live in
 * `secrets.enc` and the master key lives in the OS keychain.
 */

export interface Settings {
  /**
   * The contact string in the User-Agent VRChat sees. Collected at first run and validated; the
   * daemon refuses to make requests without it. See PLAN.md §1.4.
   */
  contact: string;
  ports: { ui: number; proxy: number; control: number };
  /**
   * `local.vrc.zip` is opt-in. `127.0.0.1` is the runtime default because it has no external
   * dependency, no cert to renew, and nothing that can fail. See PLAN.md §1.8.
   */
  useLocalDomain: boolean;
  /** Overrides log discovery. Empty means "use what discovery found", which is shown in settings. */
  logDirectories: string[];
  openBrowserOnStart: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  contact: "",
  ports: { ui: 7773, proxy: 7774, control: 7775 },
  useLocalDomain: false,
  logDirectories: [],
  openBrowserOnStart: true,
};

/** True until the user has completed first-run setup. The UI blocks on this. */
export function needsFirstRun(settings: Settings): boolean {
  return settings.contact.trim() === "";
}

export async function loadSettings(env?: NodeJS.ProcessEnv): Promise<Settings> {
  const raw = await readFile(settingsPath(env), "utf8").catch(() => null);
  if (raw === null) return structuredClone(DEFAULT_SETTINGS);

  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merged field-by-field rather than spread wholesale, so a settings file written by an older
    // version — or hand-edited badly — gains new keys instead of leaving them undefined.
    return {
      contact: typeof parsed.contact === "string" ? parsed.contact : DEFAULT_SETTINGS.contact,
      ports: { ...DEFAULT_SETTINGS.ports, ...parsed.ports },
      useLocalDomain: parsed.useLocalDomain ?? DEFAULT_SETTINGS.useLocalDomain,
      logDirectories: Array.isArray(parsed.logDirectories) ? parsed.logDirectories : [],
      openBrowserOnStart: parsed.openBrowserOnStart ?? DEFAULT_SETTINGS.openBrowserOnStart,
    };
  } catch {
    // A corrupt settings file must not stop the daemon booting — the user would have no UI in
    // which to fix it. Fall back to defaults; first-run setup will ask again.
    console.warn("[settings] could not parse settings.json; using defaults");
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: Settings, env?: NodeJS.ProcessEnv): Promise<void> {
  const path = settingsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await Bun.write(path, Bun.file(tmp));
  await Bun.file(tmp)
    .delete()
    .catch(() => undefined);
}
