import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_FORWARD_PROXY_PORT,
  DEFAULT_PROXY_PORT,
  DEFAULT_UI_PORT,
} from "@vrcz/shared";
import { DEFAULT_INTERCEPT_HOSTS } from "./forward-proxy/server.ts";
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
  ports: { ui: number; proxy: number; control: number; forward: number };
  forwardProxy: ForwardProxySettings;
  /** Overrides log discovery. Empty means "use what discovery found", which is shown in settings. */
  logDirectories: string[];
  openBrowserOnStart: boolean;
  /**
   * Whether an avatar image file id may be looked up against **avtr.zip**, a third-party service.
   *
   * This is the only outbound request vrc.zip makes to anything other than VRChat, so it gets a
   * switch of its own rather than riding along silently with everything else. See
   * `daemon/src/net/avatar-ids.ts` for exactly what leaves the machine: a file id such as
   * `file_d9ec5b06-6ea5-4ae0-ab67-78dfa3eea6df`, and nothing else — no account, no user id, no
   * cookie, and not the vrc.zip contact string either.
   *
   * On by default because without it an avatar change is unopenable. VRChat's user record carries
   * `currentAvatarImageUrl` and no avatar id at all, so the image file id is the only handle a
   * "changed avatar" row has, and turning it into an `avtr_…` is what a third party is needed for.
   * Off means the lookup route answers "not resolved", which is a normal answer rather than an
   * error.
   */
  resolveAvatarIds: boolean;
  /**
   * Whether the first-run "shall I install myself properly?" offer has been made.
   *
   * A remembered decision rather than a preference, and it is here rather than in the registry
   * because it is about this *installation's* conversation with the user, not about Windows. Note
   * what it does **not** record: whether they said yes. Somebody who declined has declined, and an
   * offer that comes back every start is nagware. The settings screen keeps the same actions
   * available for whenever they change their mind.
   *
   * Set only when the question was actually asked and answered. A daemon started by Windows at
   * sign-in has no console to ask in, and must not burn the offer by failing to make it.
   */
  installOffered: boolean;
  /**
   * The version whose update offer was declined, or empty for none.
   *
   * The *version* rather than a boolean, because that is what makes the offer stop nagging without
   * also making it stop working. Somebody who says no to updating to 0.2.0 should not be asked
   * again every time they run that same 0.2.0 executable — and should absolutely be asked when
   * 0.3.0 comes along.
   *
   * Note that this lives in the state directory, which the installed copy and a freshly extracted
   * one both share. That is the point: the two executables are having one conversation with the
   * user, not two.
   */
  updateDeclinedVersion: string;
}

/** See `daemon/src/forward-proxy/`. */
export interface ForwardProxySettings {
  /**
   * Off means the port is never bound and no CA is minted. Default on: the port is loopback-only
   * and, unlike the mirror, is inert until an app is deliberately configured to use it.
   */
  enabled: boolean;
  /**
   * Hosts whose TLS the proxy terminates so their traffic can be routed to the mirror. Everything
   * else is tunnelled through untouched.
   *
   * This is a setting rather than a constant because the mirror does not serve all of it yet:
   * dropping `pipeline.vrchat.cloud` here leaves an app's event socket pointed at real VRChat while
   * its REST calls come from vrc.zip, which is the useful posture until §2.9 lands.
   */
  interceptHosts: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  contact: "",
  ports: {
    ui: DEFAULT_UI_PORT,
    proxy: DEFAULT_PROXY_PORT,
    control: DEFAULT_CONTROL_PORT,
    forward: DEFAULT_FORWARD_PROXY_PORT,
  },
  forwardProxy: { enabled: true, interceptHosts: [...DEFAULT_INTERCEPT_HOSTS] },
  logDirectories: [],
  openBrowserOnStart: true,
  resolveAvatarIds: true,
  installOffered: false,
  updateDeclinedVersion: "",
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
      forwardProxy: {
        enabled: parsed.forwardProxy?.enabled ?? DEFAULT_SETTINGS.forwardProxy.enabled,
        interceptHosts: Array.isArray(parsed.forwardProxy?.interceptHosts)
          ? parsed.forwardProxy.interceptHosts
          : [...DEFAULT_SETTINGS.forwardProxy.interceptHosts],
      },
      logDirectories: Array.isArray(parsed.logDirectories) ? parsed.logDirectories : [],
      openBrowserOnStart: parsed.openBrowserOnStart ?? DEFAULT_SETTINGS.openBrowserOnStart,
      // `??` rather than a truthiness check, so a settings file that says `false` keeps saying
      // false while one written before this key existed inherits the default.
      resolveAvatarIds:
        typeof parsed.resolveAvatarIds === "boolean"
          ? parsed.resolveAvatarIds
          : DEFAULT_SETTINGS.resolveAvatarIds,
      installOffered:
        typeof parsed.installOffered === "boolean"
          ? parsed.installOffered
          : DEFAULT_SETTINGS.installOffered,
      updateDeclinedVersion:
        typeof parsed.updateDeclinedVersion === "string"
          ? parsed.updateDeclinedVersion
          : DEFAULT_SETTINGS.updateDeclinedVersion,
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
