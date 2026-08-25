import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultOutfile, hostTarget, isWindowsTarget, windowsVersion } from "./package.ts";

describe("isWindowsTarget", () => {
  test("splits the PE targets from the ELF ones", () => {
    expect(isWindowsTarget("bun-windows-x64")).toBe(true);
    expect(isWindowsTarget("bun-windows-x64-baseline")).toBe(true);
    expect(isWindowsTarget("bun-linux-x64")).toBe(false);
    expect(isWindowsTarget("bun-linux-arm64-musl")).toBe(false);
  });
});

describe("defaultOutfile", () => {
  test("names the file after what the platform will execute", () => {
    // Windows will not run a file without the extension; Linux should not be handed one that lies
    // about what the binary is.
    expect(defaultOutfile("bun-windows-x64")).toBe(join("dist", "vrc.zip.exe"));
    expect(defaultOutfile("bun-linux-x64")).toBe(join("dist", "vrc.zip"));
  });
});

describe("hostTarget", () => {
  test("builds for the machine doing the building", () => {
    expect(hostTarget("win32", "x64")).toBe("bun-windows-x64");
    expect(hostTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(hostTarget("linux", "arm64")).toBe("bun-linux-arm64");
  });

  test("has no answer where Bun publishes nothing, rather than a wrong one", () => {
    // The old default silently produced a Windows exe here, which is a file the host cannot run.
    expect(hostTarget("darwin", "arm64")).toBeNull();
    expect(hostTarget("win32", "arm64")).toBeNull();
    expect(hostTarget("linux", "ia32")).toBeNull();
  });
});

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
