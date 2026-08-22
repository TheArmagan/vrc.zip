import { describe, expect, test } from "bun:test";
import { embeddedUiFrom } from "./embedded-ui.ts";

/** The shape `Bun.embeddedFiles` hands back: a `File` whose name is its build-time path. */
function embedded(name: string, body = "x"): File {
  return new File([body], name);
}

describe("embeddedUiFrom", () => {
  test("keys files by their path under the bundle", () => {
    const map = embeddedUiFrom([
      embedded("dist/index.html"),
      embedded("dist/assets/app-abc123.js"),
    ]);
    expect([...map.keys()].sort()).toEqual(["assets/app-abc123.js", "index.html"]);
  });

  test("ignores embedded files that are not part of the bundle", () => {
    const map = embeddedUiFrom([embedded("tools/assets/vrczip.ico"), embedded("index.html")]);
    expect(map.size).toBe(0);
  });

  test("a backslash-separated path still resolves", () => {
    // Bun writes forward slashes on Windows too, so this one cannot come from a real build — and
    // `new File()` strips separators out of a name, so it cannot come from the helper above either.
    const windowsish = { name: "dist\\assets\\app.css" } as unknown as Blob;
    expect([...embeddedUiFrom([windowsish]).keys()]).toEqual(["assets/app.css"]);
  });

  test("running from source yields an empty map rather than an error", () => {
    expect(embeddedUiFrom([]).size).toBe(0);
  });
});
