import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTail, nextPollDelay, resolvePollSchedule } from "./tail.ts";

/** Every test writes into a throwaway tmp dir — never a real VRChat log directory. */
const temporary: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vrcz-tail-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("reads whole lines and carries a partial trailing line to the next read", async () => {
  const path = join(tempDir(), "output_log_00-00-00.txt");
  writeFileSync(path, "first\nsecond\npartial");
  const tail = new FileTail({ path });

  const first = await tail.read();
  expect(first.lines).toEqual(["first", "second"]);
  // The half line is held, not emitted.
  expect(tail.pending).toBe("partial");

  writeFileSync(path, "first\nsecond\npartial line\nthird\n");
  const second = await tail.read();
  expect(second.lines).toEqual(["partial line", "third"]);
  expect(tail.pending).toBe("");
});

test("flushPending releases the held line only when asked", async () => {
  const path = join(tempDir(), "output_log_00-00-00.txt");
  writeFileSync(path, "complete\nhalf");
  const tail = new FileTail({ path });

  expect((await tail.read()).lines).toEqual(["complete"]);
  expect(tail.flushPending()).toBe("half");
  expect(tail.flushPending()).toBeNull();
});

test("strips CRLF line endings", async () => {
  const path = join(tempDir(), "output_log_00-00-00.txt");
  writeFileSync(path, "one\r\ntwo\r\n");
  expect((await new FileTail({ path }).read()).lines).toEqual(["one", "two"]);
});

test("detects truncation and restarts from offset zero", async () => {
  const path = join(tempDir(), "output_log_00-00-00.txt");
  writeFileSync(path, "aaaa\nbbbb\ncccc\n");
  const tail = new FileTail({ path });
  expect((await tail.read()).lines).toHaveLength(3);

  writeFileSync(path, "new\n");
  const result = await tail.read();
  expect(result.truncated).toBe(true);
  expect(result.lines).toEqual(["new"]);
  expect(tail.byteOffset).toBe(4);
});

test("a multi-byte character split across a read boundary survives", async () => {
  const path = join(tempDir(), "output_log_00-00-00.txt");
  const text = "héllo wörld ünicode\n";
  const bytes = Buffer.from(text, "utf8");
  writeFileSync(path, bytes.subarray(0, 2));
  // 2 bytes lands mid-`é`.
  const tail = new FileTail({ path });
  expect((await tail.read()).lines).toEqual([]);

  writeFileSync(path, bytes);
  expect((await tail.read()).lines).toEqual(["héllo wörld ünicode"]);
});

test("a missing file is reported, not thrown", async () => {
  const result = await new FileTail({ path: join(tempDir(), "nope.txt") }).read();
  expect(result.missing).toBe(true);
  expect(result.lines).toEqual([]);
});

test("large files are read in bounded chunks and flagged hasMore", async () => {
  const path = join(tempDir(), "output_log_00-00-00.txt");
  writeFileSync(path, "0123456789\n".repeat(100));
  const tail = new FileTail({ path, maxChunkBytes: 33 });

  const first = await tail.read();
  expect(first.hasMore).toBe(true);
  expect(first.lines).toEqual(["0123456789", "0123456789", "0123456789"]);
});

test("poll delay backs off once a file stops growing", () => {
  const schedule = resolvePollSchedule({
    activeIntervalMs: 1_000,
    idleIntervalMs: 10_000,
    idleAfterMs: 30_000,
    jitterRatio: 0,
  });
  expect(nextPollDelay(schedule, 0, false)).toBe(1_000);
  expect(nextPollDelay(schedule, 29_999, false)).toBe(1_000);
  expect(nextPollDelay(schedule, 30_000, false)).toBe(10_000);
  // More bytes waiting: come straight back rather than sleeping.
  expect(nextPollDelay(schedule, 0, true)).toBe(0);
});

test("jitter spreads files across the tick without changing the mean much", () => {
  const schedule = resolvePollSchedule({
    activeIntervalMs: 1_000,
    jitterRatio: 0.2,
    random: () => 1,
  });
  expect(nextPollDelay(schedule, 0, false)).toBe(1_200);
  expect(nextPollDelay(resolvePollSchedule({ jitterRatio: 0.2, random: () => 0 }), 0, false)).toBe(
    800,
  );
});
