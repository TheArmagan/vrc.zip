/**
 * The smallest plugin that does something you can see.
 *
 * Three ideas, and every other example builds on them:
 *
 *  1. `definePlugin` registers your hooks. It claims the single frame handler the host installs, so
 *     it is called **once**, at module scope.
 *  2. `activate` receives `ctx` — everything you were granted, and nothing you were not.
 *  3. A panel is a JSON tree you send; the host draws it with its own components. You never get a
 *     DOM node, which is why a plugin cannot read the page's session token.
 */

import { definePlugin } from "@vrcz/plugin-api/runtime";

/** Plugin state is ordinary module state. It lives as long as the process does. */
let waves = 0;

/**
 * The panel, rebuilt from state.
 *
 * Note the `key` on the line that changes. A keyed node can be replaced on its own with
 * `patchPanel`, which is cheaper on the wire *and* keeps everything around it from being
 * re-created — scroll position, focus and open dialogs all survive.
 */
function panel() {
  return {
    type: "card",
    title: "Hello from a plugin",
    description: "This tree came from another process.",
    children: [
      { type: "text", key: "count", value: `waved ${waves} time${waves === 1 ? "" : "s"}` },
      { type: "button", label: "Wave", onClick: { name: "wave" } },
    ],
  };
}

definePlugin({
  async activate(ctx) {
    await ctx.ui.setPanel("hello", panel());
  },

  /**
   * A user acted. Answer promptly — the host is waiting on this frame with a deadline — and push
   * whatever you decided to draw separately.
   */
  async onIntent(dispatch, ctx) {
    if (dispatch.intent.name !== "wave") return;
    waves += 1;
    await ctx.ui.patchPanel("hello", "count", {
      type: "text",
      key: "count",
      value: `waved ${waves} time${waves === 1 ? "" : "s"}`,
    });
    await ctx.ui.toast("👋", { tone: "success" });
  },

  /** Contributed commands reach here, whether or not a panel is open. */
  async onCommand(commandId, ctx) {
    if (commandId === "wave") await ctx.ui.toast("Hello from the palette");
  },
});
