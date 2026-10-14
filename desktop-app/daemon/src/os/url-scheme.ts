/**
 * Registering `vrczip://` with Windows, so a click on one starts this executable with the link.
 *
 * ## Per-user, under `HKCU\Software\Classes`
 *
 * That key is merged into `HKEY_CLASSES_ROOT` for the user who wrote it, which is how an app that
 * installed itself without elevation owns a URL scheme. The shape is the documented one: a
 * `URL Protocol` value marks the key as a scheme, and `shell\open\command` is the command line, with
 * `%1` replaced by the whole link.
 *
 * ## Which executable it names
 *
 * The installed copy when there is one, and this one otherwise. A portable run from Downloads while
 * an installed copy exists must not take the scheme over: the installed copy is the one that starts
 * with Windows, so it is the one most likely to be running when a link arrives, and a link that
 * starts a second vrc.zip from a folder Storage Sense empties is a link that stops working.
 *
 * ## Re-checked on every packaged start
 *
 * vrc.zip is a single file people move around, the same reason `startup.ts` repairs its `Run`
 * value. The write only happens when the command differs, so an ordinary start reads three values
 * and writes nothing.
 */

import { APP_NAME } from "@vrcz/shared";
import { executablePath } from "../paths.ts";
// A cycle with `install.ts`, which calls back in here to register and remove the scheme. Safe,
// because neither module touches the other at load time; only function bodies do.
import { installExists, installTarget, isInstalled } from "./install.ts";
import { deleteKey, readString, registryAvailable, writeString } from "./registry.ts";

/** The scheme, without the colon. `wiring/deeplink.ts` parses what arrives under it. */
export const DEEP_LINK_SCHEME = "vrczip";

const CLASSES = "Software\\Classes";
const SCHEME_KEY = `${CLASSES}\\${DEEP_LINK_SCHEME}`;
const COMMAND_KEY = `${SCHEME_KEY}\\shell\\open\\command`;
const ICON_KEY = `${SCHEME_KEY}\\DefaultIcon`;

/**
 * The command line Windows runs for a link.
 *
 * `%1` is quoted, so a link is always one argument however it was written. Browsers percent-encode
 * spaces and quotes before handing a link over, and `index.ts` treats the link as the only argument
 * that matters whenever one is present, so no flag can ride in on it.
 */
export function schemeCommand(target: string): string {
  return `"${target}" "%1"`;
}

/** Which executable should own the scheme. See the note at the top. */
export function schemeTarget(): string {
  if (isInstalled()) return executablePath();
  const installed = installTarget();
  if (installed !== null && installExists()) return installed;
  return executablePath();
}

/** Writes the scheme so it starts `target`. True when every value landed. */
export function registerUrlScheme(target: string): boolean {
  if (!registryAvailable()) return false;
  let ok = true;
  if (!writeString(SCHEME_KEY, "", `URL:${APP_NAME}`)) ok = false;
  if (!writeString(SCHEME_KEY, "URL Protocol", "")) ok = false;
  if (!writeString(ICON_KEY, "", `"${target}",0`)) ok = false;
  if (!writeString(COMMAND_KEY, "", schemeCommand(target))) ok = false;
  return ok;
}

/**
 * Makes sure the scheme points where it should, and writes only when it does not.
 *
 * Returns whether it wrote anything, so the caller can say so. Windows only; a no-op elsewhere.
 */
export function ensureUrlScheme(target: string = schemeTarget()): boolean {
  if (!registryAvailable()) return false;
  if (readString(COMMAND_KEY, "") === schemeCommand(target)) return false;
  return registerUrlScheme(target);
}

/**
 * Removes the scheme, leaf first, because `RegDeleteKeyW` will not remove a key with children.
 *
 * True when it is gone. The keys are only ever ones `registerUrlScheme` wrote, so there is nothing
 * of anybody else's under them to protect.
 */
export function removeUrlScheme(): boolean {
  if (!registryAvailable()) return false;
  deleteKey(`${SCHEME_KEY}\\shell\\open`, "command");
  deleteKey(`${SCHEME_KEY}\\shell`, "open");
  deleteKey(SCHEME_KEY, "shell");
  deleteKey(SCHEME_KEY, "DefaultIcon");
  deleteKey(CLASSES, DEEP_LINK_SCHEME);
  return readString(SCHEME_KEY, "") === null;
}
