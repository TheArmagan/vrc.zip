import { describe, expect, test } from "bun:test";
import { runProgram, splitArguments, steamRunUrl } from "./run-program.ts";

describe("splitting a line of arguments", () => {
  test("whitespace separates, and runs of it collapse", () => {
    expect(splitArguments("--no-vr   --fps=90")).toEqual(["--no-vr", "--fps=90"]);
    expect(splitArguments("  a\tb\nc  ")).toEqual(["a", "b", "c"]);
    expect(splitArguments("")).toEqual([]);
    expect(splitArguments("     ")).toEqual([]);
  });

  test("quotes group, both kinds", () => {
    expect(splitArguments('--log "C:\\Program Files\\log.txt"')).toEqual([
      "--log",
      "C:\\Program Files\\log.txt",
    ]);
    expect(splitArguments("--name 'two words'")).toEqual(["--name", "two words"]);
    // Quotes inside a word, which is how `--name="a b"` is usually typed.
    expect(splitArguments('--name="a b"')).toEqual(["--name=a b"]);
  });

  test("an empty pair of quotes is a real, empty argument", () => {
    // `--name ""` says "this one, deliberately blank", which is not the same as leaving it out.
    expect(splitArguments('--name ""')).toEqual(["--name", ""]);
  });

  test("a backslash escapes a quote and nothing else", () => {
    expect(splitArguments('--say \\"hi\\"')).toEqual(["--say", '"hi"']);
    // The important half: a Windows path is full of backslashes and none of them may be eaten.
    expect(splitArguments("C:\\Users\\me\\vrc.exe")).toEqual(["C:\\Users\\me\\vrc.exe"]);
    expect(splitArguments("C:\\\\server\\share")).toEqual(["C:\\server\\share"]);
  });

  test("nothing that looks like shell syntax is interpreted", () => {
    // Every one of these is one argument's worth of text, because the list goes to `Bun.spawn` and
    // there is no shell anywhere on the path. This is the whole security property of the file.
    expect(splitArguments("--x && calc.exe")).toEqual(["--x", "&&", "calc.exe"]);
    expect(splitArguments("$HOME %APPDATA% *.txt | tee")).toEqual([
      "$HOME",
      "%APPDATA%",
      "*.txt",
      "|",
      "tee",
    ]);
  });

  test("an unclosed quote keeps what it has, because somebody is still typing", () => {
    expect(splitArguments('--log "C:\\half')).toEqual(["--log", "C:\\half"]);
  });
});

describe("the steam link", () => {
  test("no arguments is the bare form", () => {
    expect(steamRunUrl("438100", [])).toBe("steam://run/438100");
  });

  test("arguments are encoded into the documented slot", () => {
    expect(steamRunUrl("438100", ["--no-vr", "--fps=90"])).toBe(
      "steam://run/438100//--no-vr%20--fps%3D90/",
    );
  });

  test("nothing a protocol handler or a shell reads survives encoding", () => {
    // The URL reaches the operating system, which is somebody else's parser. `&` would end the
    // argument list; a quote or a space would split it somewhere the author did not mean.
    const url = steamRunUrl("438100", ['--x "a b"', "&calc"]);
    expect(url).not.toContain("&");
    expect(url).not.toContain('"');
    expect(url).not.toContain(" ");
  });
});

describe("running a program", () => {
  test("a path that is not there is a reason, not a throw", async () => {
    const result = await runProgram({ path: "./no-such-program-here", args: [] });
    expect(result.started).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.reason).toBeDefined();
  });

  test("an empty path says so rather than spawning something", async () => {
    const result = await runProgram({ path: "   ", args: [] });
    expect(result).toEqual({ started: false, pid: null, reason: "no program was named" });
  });

  test("it starts a real process and answers with its pid", async () => {
    // Bun itself, exiting immediately: the one executable a test can be sure is on this machine.
    const result = await runProgram({ path: process.execPath, args: ["-e", ""] });
    expect(result.started).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
  });
});
