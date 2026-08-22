/**
 * The `INPUT_RECORD` decoder.
 *
 * A console cannot be typed into from a test, which is exactly why the decoding is a pure function
 * over bytes: the layout — a `WORD` event type, two bytes of padding, a four-byte `BOOL`, and the
 * character at offset fourteen — is the part that silently produces nonsense when it is wrong, and
 * a buffer built by hand exercises all of it.
 */

import { describe, expect, test } from "bun:test";
import { decodeKeyPresses, INPUT_RECORD_BYTES } from "./console.ts";

const KEY_EVENT = 0x0001;
const MOUSE_EVENT = 0x0002;

/** Builds one `INPUT_RECORD` the way the console would hand it to us. */
function record({
  type = KEY_EVENT,
  keyDown = true,
  char = "",
}: { type?: number; keyDown?: boolean; char?: string } = {}): Uint8Array {
  const bytes = new Uint8Array(INPUT_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, true);
  view.setUint32(4, keyDown ? 1 : 0, true);
  view.setUint16(14, char === "" ? 0 : char.charCodeAt(0), true);
  return bytes;
}

function buffer(...records: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(INPUT_RECORD_BYTES * Math.max(records.length, 1));
  records.forEach((entry, index) => {
    out.set(entry, index * INPUT_RECORD_BYTES);
  });
  return out;
}

describe("decodeKeyPresses", () => {
  test("reads the character out of a key-down event", () => {
    expect(decodeKeyPresses(buffer(record({ char: "o" })), 1)).toEqual(["o"]);
  });

  /**
   * The one that matters: every press produces a down *and* an up. Acting on both would open two
   * browser tabs for one keystroke, which is the kind of bug that only shows up in someone's hands.
   */
  test("ignores the key-up half of a press", () => {
    const records = buffer(record({ char: "f" }), record({ char: "f", keyDown: false }));
    expect(decodeKeyPresses(records, 2)).toEqual(["f"]);
  });

  test("ignores events that are not key events", () => {
    const records = buffer(record({ type: MOUSE_EVENT, char: "x" }), record({ char: "o" }));
    expect(decodeKeyPresses(records, 2)).toEqual(["o"]);
  });

  /** Shift, Ctrl and the arrows arrive as key events carrying no character. */
  test("ignores keys with no character", () => {
    expect(decodeKeyPresses(buffer(record({ char: "" })), 1)).toEqual([]);
  });

  test("reads only as many records as the console said it wrote", () => {
    // The buffer is reused between polls, so stale records sit past `count` and must not be read.
    const records = buffer(record({ char: "a" }), record({ char: "b" }));
    expect(decodeKeyPresses(records, 1)).toEqual(["a"]);
  });

  test("never reads past the end of the buffer", () => {
    // A count larger than the buffer would be a console bug, and reading on it would be ours.
    expect(decodeKeyPresses(buffer(record({ char: "a" })), 99)).toEqual(["a"]);
  });
});
