import { expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import { normaliseLogDirectories } from "./settings.ts";

/**
 * The log directory overrides are the one path in the app a user types by hand, so they arrive in
 * whatever shape a paste produced. Everything downstream — the settings list, `readdir`, the
 * filename joined onto them, `sessions.log_path` — reads back whatever is stored here.
 */

const ROOT = resolve(sep, "logs", "vrchat");

test("a pasted forward-slash path is stored the way the host spells paths", () => {
  const pasted = ROOT.replaceAll(sep, "/");
  expect(normaliseLogDirectories([pasted])).toEqual([ROOT]);
});

test("two spellings of one directory are one directory", () => {
  const same = [ROOT, ROOT.replaceAll(sep, "/"), `${ROOT}${sep}`, `${ROOT}${sep}.`];
  expect(normaliseLogDirectories(same)).toEqual([ROOT]);
});

test("blanks and non-strings are dropped rather than stored", () => {
  expect(normaliseLogDirectories([" ", "", 7, null, ROOT])).toEqual([ROOT]);
});

test("anything that is not a list is an empty list", () => {
  expect(normaliseLogDirectories(undefined)).toEqual([]);
  expect(normaliseLogDirectories(ROOT)).toEqual([]);
});
