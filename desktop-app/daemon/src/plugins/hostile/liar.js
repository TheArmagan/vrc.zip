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
 *
 * **Every lie is told twice, because there are two channels and they answer differently.** Through
 * `__vrczHost.send` the prelude refuses `pong` and `hello` locally and passes everything else on, so
 * the host's own direction check is what has to catch the forged `event`, `dropped` and `lifecycle`.
 * Through `process.stdout.write` nothing arrives at all: the prelude has replaced that function with
 * a write to stderr, so the raw lies land in the log. Both paths are asserted, because "the plugin
 * could not reach the wire" and "the host rejected what reached it" are different guarantees and
 * only one of them survives a change to the prelude.
 */

const host = globalThis.__vrczHost;

function forge(frame) {
  // Returns false when the prelude refused it locally.
  const accepted = host.send(frame);
  // The raw channel, which the prelude has already taken away.
  process.stdout.write(`${JSON.stringify(frame)}\n`);
  return accepted;
}

// Host-only tags.
forge({ t: "event", sub: "forged", seq: 1, events: [{ kind: "friend.online", ts: Date.now() }] });
forge({ t: "dropped", sub: "forged", count: 9999, reason: "overflow", seq: 2 });
forge({ t: "lifecycle", id: "forged", deadline: Date.now() + 1000, phase: "activate" });

// A pong for a ping that was never sent, with a nonce it could not have been given.
forge({ t: "pong", nonce: "made-up" });
// And a `hello`, which the host is entitled to treat as arriving exactly once.
forge({ t: "hello", protocol: 0, pluginId: "someone.else" });

// Not JSON at all, and JSON that is not a frame.
process.stdout.write("}{ this is not json\n");
forge({ hello: "there" });
forge({ t: "nonexistent-tag" });

export function activate() {
  return { lied: true };
}
