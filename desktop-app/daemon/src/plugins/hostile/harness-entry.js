/**
 * The entry point every hostile bundle is built around, and the smallest thing that can stand in for
 * the plugin-side runtime step 3.6 has not shipped yet.
 *
 * **Why this file has to exist at all.** The prelude answers `ping` and nothing else; every other
 * host frame is handed to whatever registered itself through `__vrczHost.onFrame`. Nothing registers
 * one today, so a `lifecycle: activate` frame reaches a plugin that has no way to answer it — which
 * means *every* plugin, hostile or polite, is reported as `activate-hung`. A suite built on that
 * would prove only that the activation deadline works, and would report the same verdict for
 * `polite.js` as for `hang.js`. The control has to be able to pass.
 *
 * So this is deliberately the *thinnest possible honest* bridge: it turns a lifecycle frame into a
 * call on the attack module's export and answers on the same id. It adds no timeout, no error
 * translation beyond `E_INTERNAL`, and no protection of any kind — a real runtime will do more, and
 * anything it did here would be a defence the suite was measuring instead of the host's.
 *
 * It is bundled as the plugin's `main`, importing the attack as `./attack.js`, so the attacks
 * themselves stay one-file-one-attack and say nothing about lifecycle plumbing.
 */

import * as attack from "./attack.js";

const host = globalThis.__vrczHost;

host.onFrame((frame) => {
  if (frame.t !== "lifecycle") return;

  const answer = (result) => {
    host.send({ t: "res", id: frame.id, result: result === undefined ? null : result });
  };
  const refuse = (error) => {
    host.send({
      t: "err",
      id: frame.id,
      error: { code: "E_INTERNAL", message: String(error?.message || error) },
    });
  };

  const hook = frame.phase === "activate" ? attack.activate : attack.deactivate;
  if (typeof hook !== "function") {
    answer(null);
    return;
  }

  try {
    // `Promise.resolve` rather than `await`, so a hook that returns a forever-pending promise never
    // settles here either — which is the whole of what `hang.js` is testing.
    Promise.resolve(hook(host)).then(
      (result) => {
        // A result a plugin returns is arbitrary and the wire only carries JSON, so anything that
        // will not encode is reported as having activated rather than as having failed.
        try {
          answer(JSON.parse(JSON.stringify(result ?? null)));
        } catch {
          answer(null);
        }
      },
      (error) => {
        refuse(error);
      },
    );
  } catch (error) {
    refuse(error);
  }
});
