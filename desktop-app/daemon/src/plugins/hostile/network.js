/**
 * Tries to reach the network directly, and to evaluate a string.
 *
 * **There is no deny-scan rule for `fetch`, `WebSocket` or `XMLHttpRequest` at all**, and a
 * string-literal `eval("…")` is explicitly allowed by the `eval` rule's carve-out. Both of those are
 * correct decisions and both are correct **only for exactly as long as the prelude really removes
 * the globals** — a rule that duplicated the scrub would be a second thing to keep in agreement, and
 * a scan rule cannot stop `globalThis["fet" + "ch"]` anyway.
 *
 * That makes this file the standing check on the load-bearing assumption underneath the absent
 * rules. Network belongs to the host: every VRChat call is a call against the *user's* account and
 * has to pass the rate limiter, the scope check and the dry-run gate, so a plugin that opens its own
 * socket bypasses all three and, worse, can exfiltrate anything it has learned to a host of its
 * choosing. If any line here comes back with a callable function, the scan's silence about network
 * globals has stopped being safe and a rule has to be written.
 *
 * The literal `eval` is here for the same reason: the carve-out argues that `eval("a literal")` is
 * exactly as powerful as writing the literal out. That is true of the *string*, and it says nothing
 * about the `eval` binding still existing, so this asks whether it does.
 */

const host = globalThis.__vrczHost;

function probe(name, read) {
  try {
    return [name, String(read())];
  } catch (error) {
    return [name, `threw: ${String(error?.message || error)}`];
  }
}

function survey() {
  return Object.fromEntries([
    probe("fetch", () => typeof globalThis.fetch),
    // The computed spelling, because a rule over the identifier would never have caught it.
    probe("computed-fetch", () => typeof globalThis[`fet${"ch"}`]),
    probe("WebSocket", () => typeof globalThis.WebSocket),
    probe("XMLHttpRequest", () => typeof globalThis.XMLHttpRequest),
    probe("EventSource", () => typeof globalThis.EventSource),
    probe("Worker", () => typeof globalThis.Worker),
    probe("navigator", () => typeof globalThis.navigator),
    probe("Bun.connect", () => typeof globalThis.Bun.connect),
    probe("Bun.serve", () => typeof globalThis.Bun.serve),
    // The scan's carve-out: a string-literal eval is allowed through, so it reaches the runtime.
    // This file is the adversary — the literal `eval` is the exact construct the deny-scan permits,
    // and the question is whether the binding still exists once the prelude has run.
    // biome-ignore lint/security/noGlobalEval: the adversary is the point; see above.
    probe("eval-literal", () => eval("1 + 1")),
    probe("indirect-eval", () => {
      const indirect = globalThis[`ev${"al"}`];
      return typeof indirect === "function" ? indirect("1 + 1") : typeof indirect;
    }),
    // The one that would matter most if any of the above came back callable.
    probe("actually-fetch", () => {
      if (typeof globalThis.fetch !== "function") return "unreachable";
      // Never resolved and never awaited; reaching the call at all is the failure.
      globalThis.fetch("http://127.0.0.1:9/vrczip-hostile-exfiltration");
      return "reached";
    }),
  ]);
}

host.log(`NETWORK ${JSON.stringify(survey())}`);

export function activate() {
  return survey();
}
