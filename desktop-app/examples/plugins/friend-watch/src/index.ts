/**
 * Subscribing to events, and the one thing that makes event handling survivable.
 *
 * ## The events you get are the intersection of two things
 *
 * Your **scopes** decide what you may see at all, and your manifest's **events** decide which of
 * that you asked to be told about. The narrower always wins, so declaring `"*"` does not widen a
 * scope, and holding a scope does not deliver events you never declared. Both are shown on the
 * consent sheet, and both are enforced.
 *
 * ## `friend.location` is the reason `coalesce` exists
 *
 * One instance transition can move forty friends at once, and a hundred friends moving around an
 * evening is thousands of events. `overflow: "coalesce"` with a `keyPath` keeps **each friend's
 * most recent** event and drops the ones it superseded — so a slow handler sees the world as it is
 * now rather than a backlog of where everyone used to be.
 *
 * Without a `keyPath` the host cannot know what "the same thing" means, so it refuses rather than
 * quietly behaving like `drop-oldest`.
 */

import { definePlugin } from "@vrcz/plugin-api/runtime";

/** Most recent event per friend, newest first when rendered. */
const seen = new Map<string, { name: string; what: string; ts: number }>();

function panel() {
  const rows = [...seen.entries()]
    .sort((left, right) => right[1].ts - left[1].ts)
    .slice(0, 50)
    .map(([userId, entry]) => ({ id: userId, who: userId, what: entry.what }));

  return {
    type: "card",
    title: "Friend Watch",
    children: [
      rows.length === 0
        ? { type: "empty", key: "rows", title: "Nothing yet", description: "Waiting for friends to move." }
        : {
            type: "table",
            key: "rows",
            rowKey: "id",
            filterable: true,
            columns: [
              // `userRef` makes the host draw its own user affordance — the hover card, the menu,
              // the trust colour — from an id. You do not need to fetch a profile to show a name.
              { id: "who", header: "Friend", cell: "userRef" },
              { id: "what", header: "What happened", sortable: true },
            ],
            rows,
          },
    ],
  };
}

definePlugin({
  async activate(ctx) {
    await ctx.ui.setPanel("watch", panel());

    await ctx.events.subscribe(
      (event) => {
        const userId = event.subjectId ?? "";
        if (userId === "") return;
        seen.set(userId, {
          name: userId,
          what: event.kind.replace("friend.", ""),
          ts: event.ts,
        });
        // Redraw on the next tick rather than per event: a batch of forty arrives as forty calls
        // into this handler, and forty panel pushes for one visible change is forty frames.
        schedule(ctx);
      },
      {
        filter: { kinds: ["friend.online", "friend.offline", "friend.location"] },
        delivery: {
          credits: 256,
          maxBatch: 32,
          overflow: "coalesce",
          // "the same thing" = the same friend. A path whose first segment is not an event field is
          // resolved against the payload, so `userId` and `payload.userId` both work.
          keyPath: "userId",
        },
        // The host tells you when it shed load. Ignoring this is how a plugin comes to believe it
        // saw everything.
        onDropped: (info) => {
          ctx.log(`missed ${String(info.count)} events (${info.reason})`);
        },
      },
    );
  },
});

let pending: ReturnType<typeof setTimeout> | null = null;

function schedule(ctx: { ui: { setPanel(id: string, tree: unknown): Promise<void> } }): void {
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    void ctx.ui.setPanel("watch", panel());
  }, 250);
}
