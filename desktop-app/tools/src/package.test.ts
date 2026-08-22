import { describe, expect, test } from "bun:test";
import { windowsVersion } from "./package.ts";

describe("windowsVersion", () => {
  test("pads a semver out to the four fields Windows wants", () => {
    expect(windowsVersion("0.1.0")).toBe("0.1.0.0");
    expect(windowsVersion("1.2.3")).toBe("1.2.3.0");
  });

  test("zeroes what does not fit rather than inventing a number", () => {
    // The field is four 16-bit integers. `rc` has no representation there, and guessing one would
    // put a version on the file that no release ever had.
    expect(windowsVersion("0.2.0-rc.1")).toBe("0.2.0.0");
    expect(windowsVersion("not-a-version")).toBe("0.0.0.0");
  });

  test("an overflowing field zeroes in place, and does not slide the rest left", () => {
    // Dropping it would print this as version 1.3, which is a different release.
    expect(windowsVersion("1.70000.3")).toBe("1.0.3.0");
  });
});
