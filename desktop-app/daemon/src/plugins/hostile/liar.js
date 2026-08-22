/**
 * Sends frames it is not allowed to send.
 *
 * `FRAME_SENDERS` marks `event`, `dropped` and `lifecycle` as host-only, and this file sends all
 * three. Without direction checking the host has no reason to object, and a plugin could feed
 * itself a forged `event` frame's worth of bus data — inventing friend locations, sessions and
 * notifications that never happened, for any account, regardless of what it was granted.
 *
 * It also answers a `ping` it was never sent, which is the same attack aimed at the supervisor
 * rather than the dispatcher: unsolicited pongs would let a wedged plugin manufacture its own
 * evidence of health. The nonce is what makes that fail, and this is the file that proves it.
 *
 * And it sends outright garbage, because a malformed frame must be *counted* rather than processed:
 * the host's response to a peer that cannot speak the protocol is to stop trusting the process, not
 * to try harder to understand it.
 */
function say(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

// Host-only tags, forged.
say({ t: "event", sub: "forged", seq: 1, events: [{ kind: "friend.online", ts: Date.now() }] });
say({ t: "dropped", sub: "forged", count: 9999, reason: "overflow", seq: 2 });
say({ t: "lifecycle", id: "forged", deadline: Date.now() + 1000, phase: "activate" });

// A pong for a ping that was never sent, with a nonce it could not have been given.
say({ t: "pong", nonce: "made-up" });

// Not JSON at all, and JSON that is not a frame.
say("}{ this is not json");
say({ hello: "there" });
say({ t: "nonexistent-tag" });

export function activate() {
  return { lied: true };
}
