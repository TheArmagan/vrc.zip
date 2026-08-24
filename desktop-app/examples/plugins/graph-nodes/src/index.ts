/**
 * Contributing node types to the graph.
 *
 * ## Declared in the manifest, defined in code
 *
 * The manifest lists node **ids**; the definition — ports, config, the body template — is
 * registered when you activate. Both halves are needed and they answer different questions: the
 * manifest is what the host knows while your plugin is *stopped*, which is what lets a saved graph
 * say "this node is paused" instead of showing a hole. Registering an id the manifest never
 * declared is refused.
 *
 * ## A trigger arms; it does not execute
 *
 * This is the inversion, and the type system enforces it: a trigger has no inputs and no execute
 * handler. The runtime tells you an instance is live with a given config, you hold whatever
 * subscription you need, and you call `fire()` when the world does something. The alternative —
 * the runtime asking you "has it happened yet?" — is both wrong for events and a rate-limit hazard
 * multiplied by every graph the user has saved.
 *
 * ## The port lattice has exactly four widening rules
 *
 * `friend <: user`, `X <: json`, `list<A> <: list<B>` when `A <: B`, and `id <: string` — a `user`
 * is a user id, and an id is a string. That is all. Every additional rule would be an explanation
 * you owe a user whose edge just got refused, so an output typed `user` flows into an input typed
 * `user`, `string` or `json`, and nothing else. None of them runs in reverse.
 *
 * **Phase 4 owns the editor.** Registration, arming and execution are real today; there is no
 * canvas yet to wire them on.
 */

import { definePlugin } from "@vrcz/plugin-api/runtime";

/** Armed trigger instances: the graph's id → how to stop watching. */
const armed = new Map<string, { close: () => Promise<void> }>();

definePlugin({
  async activate(ctx) {
    // A trigger. No inputs — it is where a graph starts.
    await ctx.nodes.register({
      id: "friend-came-online",
      kind: "trigger",
      title: "A friend came online",
      category: "Friends",
      description: "Fires once each time one of your friends appears online.",
      outputs: [{ id: "friend", label: "Who", type: "friend" }],
      config: [
        {
          kind: "boolean",
          id: "onlyFavourites",
          label: "Only favourites",
          description: "Ignore everyone who is not a favourite.",
          default: false,
        },
      ],
      // A body template is evaluated by the *host*, per frame, with no call into this process:
      // Svelte Flow re-renders on every pan and zoom, and RPC at 60Hz is not viable.
      body: [
        { kind: "literal", text: "when " },
        { kind: "port", port: "friend" },
        { kind: "literal", text: " comes online" },
      ],
      maxFiresPerMinute: 60,
    });

    // An action. Everything that is not a trigger has inputs and runs on demand.
    await ctx.nodes.register({
      id: "remember-friend",
      kind: "action",
      title: "Remember this friend",
      category: "Friends",
      // `friend` flows in here from the trigger above — that is the `friend <: user` rule at work
      // if the input were typed `user`, and an exact match as written.
      inputs: [{ id: "who", label: "Friend", type: "friend" }],
      outputs: [{ id: "seenCount", label: "Times seen", type: "number" }],
      config: [
        { kind: "text", id: "note", label: "Note", placeholder: "Why you are watching them" },
      ],
    });
  },

  /**
   * A graph armed the trigger. Returning means "armed", not "fired".
   *
   * `instanceId` identifies *this placement of the node in this graph* — the same node type armed
   * by three graphs is three instances, and `fire()` names which one went off.
   */
  async onNodeArm(instance, ctx) {
    const subscription = await ctx.events.subscribe(
      (event) => {
        const friendId = event.subjectId ?? "";
        if (friendId === "") return;
        void ctx.nodes.fire(instance.instanceId, { friend: friendId });
      },
      { filter: { kinds: ["friend.online"] }, delivery: { overflow: "drop-oldest" } },
    );
    armed.set(instance.instanceId, { close: () => subscription.close() });
  },

  /** Drop whatever arming set up. A graph that is disabled must stop costing anything. */
  async onNodeDisarm(instance) {
    const held = armed.get(instance.instanceId);
    armed.delete(instance.instanceId);
    await held?.close();
  },

  /**
   * The graph reached an action or a condition.
   *
   * Return the outputs keyed by port id. A condition answers the same way — the graph reads an
   * output either way, so there is no second shape to learn.
   */
  async onNodeExecute(call, ctx) {
    if (call.nodeId !== "remember-friend") return {};
    const who = String(call.inputs.who ?? "");
    if (who === "") return { seenCount: 0 };

    const key = `seen/${who}`;
    const previous = Number((await ctx.storage.kv.get(key)) ?? 0);
    const seenCount = previous + 1;
    await ctx.storage.kv.set(key, seenCount);
    await ctx.storage.records.append(`log/${who}`, {
      note: String(call.config.note ?? ""),
      seenCount,
    });
    return { seenCount };
  },
});
