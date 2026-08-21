import { expect, test } from "bun:test";
import rootManifest from "../../../package.json" with { type: "json" };
import { APP_VERSION } from "./version.ts";

test("APP_VERSION matches the workspace root package.json", () => {
  // Guards the duplication documented in version.ts. If this fails, bump one to match the other —
  // do not delete the test, or the shipped User-Agent silently stops naming the real version.
  expect(APP_VERSION).toBe(rootManifest.version);
});
