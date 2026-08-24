import { describe, expect, test } from "bun:test";
import { commandLine, quoteArgument, startDetached } from "./detached.ts";

/**
 * The quoting, and one real launch.
 *
 * The quoting is the part that can be wrong silently: `CreateProcessW` takes a command line, the
 * child un-parses it with `CommandLineToArgvW`, and a mistake here does not fail — it hands the
 * program a different argument list than the one that was asked for. These cases are the documented
 * rules, which are not the obvious ones.
 */

describe("quoteArgument", () => {
  test("leaves an ordinary argument alone", () => {
    // Quoting everything would work too and would make every command line unreadable in Task
    // Manager, which is where somebody looks when they want to know what was started.
    expect(quoteArgument("--hidden")).toBe("--hidden");
    expect(quoteArgument("C:\\Users\\a\\vrc.zip.exe")).toBe("C:\\Users\\a\\vrc.zip.exe");
  });

  test("quotes anything with a space", () => {
    expect(quoteArgument("C:\\Program Files\\vrc.zip\\vrc.zip.exe")).toBe(
      '"C:\\Program Files\\vrc.zip\\vrc.zip.exe"',
    );
  });

  test("an empty argument is a real, empty argument", () => {
    // `--name ""` says "this one, deliberately blank". Dropping the quotes drops the argument.
    expect(quoteArgument("")).toBe('""');
  });

  test("a backslash is literal except before a quote, where it doubles", () => {
    /*
     * The rule that catches everybody. `C:\dir\` inside quotes ends with a backslash that would
     * otherwise escape the closing quote, so the run is doubled; a backslash in the middle of a
     * path is not.
     */
    expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArgument("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteArgument('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
  });

  test("shell syntax is just text", () => {
    // The security property of `run-program.ts`, now that its Windows path builds a command line:
    // there is no shell to interpret any of this, and quoting keeps each one a single argument.
    expect(commandLine("app.exe", ["&&", "calc.exe", "%APPDATA%", "*.txt"])).toBe(
      "app.exe && calc.exe %APPDATA% *.txt",
    );
    expect(commandLine("C:\\a b\\app.exe", ["x y"])).toBe('"C:\\a b\\app.exe" "x y"');
  });
});

describe("startDetached", () => {
  test.if(process.platform === "win32")("starts a process and reports its pid", () => {
    // A real launch, of something that exits on its own immediately. What cannot be asserted here
    // is the property the function exists for — surviving this process — since the test runner is
    // still alive at the end of it. That was measured by hand; see the note on the module.
    const pid = startDetached({ path: "cmd.exe", args: ["/c", "exit", "0"] });
    expect(pid).not.toBe(null);
    expect(pid).toBeGreaterThan(0);
  });

  test.if(process.platform === "win32")("reports a program that is not there", () => {
    expect(startDetached({ path: "vrczip-does-not-exist.exe" })).toBe(null);
  });

  test.if(process.platform !== "win32")("is Windows only", () => {
    expect(startDetached({ path: "/bin/true" })).toBe(null);
  });
});
