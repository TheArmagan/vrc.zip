/**
 * Reading VRChat, and the rules that come with it.
 *
 * ## You never call VRChat; the host does
 *
 * `ctx.vrchat` is a *semantic* API, not the byte-faithful mirror third-party apps use. Every call
 * goes out through the account's own request pipeline: the shared rate limiter, the mandatory
 * User-Agent, the cookie the plugin never sees. That is also why the surface is small and stable —
 * it is not coupled to VRChat's response shapes, and it will not change under you when they do.
 *
 * ## Which account?
 *
 * The user picks at consent. If they picked exactly one, calls resolve to it and you may omit
 * `accountId`. If they picked several, **omitting it is an error rather than a guess** — traffic
 * going out as whichever account happened to sort first is not something anyone consented to. Call
 * `ctx.vrchat.accounts.list()` to see what you were given.
 *
 * ## Rate limits are the user's, not yours
 *
 * A plugin that polls hard gets *the person running it* rate-limited or moderated. Every call is
 * tagged with this plugin's id, so the app can name who is spending the budget. Fetch on demand,
 * cache what you got, and treat `E_RATE_LIMIT`'s `retryAfterMs` as a floor — retrying before it is
 * a bug in your plugin, and a visible one.
 */

import { definePlugin, PluginCallError } from "@vrcz/plugin-api/runtime";

interface Friend {
  readonly id: string;
  readonly displayName?: string;
  readonly status?: string;
  readonly location?: string;
}

let friends: Friend[] = [];
let error: string | null = null;

function panel() {
  if (error !== null) {
    return {
      type: "card",
      title: "Friends Table",
      children: [
        { type: "alert", tone: "danger", title: "Could not read friends", description: error },
      ],
    };
  }

  return {
    type: "card",
    title: "Friends Table",
    description: `${friends.length} friends`,
    children: [
      friends.length === 0
        ? { type: "empty", key: "table", title: "Nobody yet", description: "No account is online." }
        : {
            type: "table",
            key: "table",
            rowKey: "id",
            filterable: true,
            columns: [
              { id: "id", header: "Friend", cell: "userRef" },
              { id: "status", header: "Status", sortable: true },
              { id: "location", header: "Where", sortable: true },
            ],
            rows: friends.map((friend) => ({
              id: friend.id,
              status: friend.status ?? "",
              // A location is `wrld_…:12345`, `private`, or `offline`. Shown raw here; a real
              // plugin would use a `worldRef` cell for the world half.
              location: friend.location ?? "",
            })),
          },
      { type: "button", label: "Refresh", onClick: { name: "refresh" } },
    ],
  };
}

async function load(ctx: {
  vrchat: { friends: { list(params?: { accountId?: string }): Promise<unknown> } };
  log(message: unknown): void;
}): Promise<void> {
  try {
    // No `accountId`: this manifest asks for `mode: "one"`, so the grant covers a single account
    // and the host resolves it. Ask for `many` and this call must name one.
    const answer = (await ctx.vrchat.friends.list()) as Friend[] | null;
    friends = Array.isArray(answer) ? answer : [];
    error = null;
  } catch (thrown) {
    if (thrown instanceof PluginCallError) {
      // Worth branching on: a scope you were not granted is permanent and needs a re-install, while
      // a rate limit is a "not now" carrying how long to wait.
      error =
        thrown.code === "E_RATE_LIMIT"
          ? `Rate limited. Try again in ${String(Math.ceil((thrown.retryAfterMs ?? 0) / 1000))}s.`
          : thrown.message;
      ctx.log(`friends.list failed: ${thrown.code}`);
      return;
    }
    throw thrown;
  }
}

definePlugin({
  async activate(ctx) {
    await load(ctx as never);
    await ctx.ui.setPanel("friends", panel());
  },

  async onIntent(dispatch, ctx) {
    if (dispatch.intent.name !== "refresh") return;
    await load(ctx as never);
    await ctx.ui.setPanel("friends", panel());
  },

  async onCommand(commandId, ctx) {
    if (commandId !== "refresh") return;
    await load(ctx as never);
    await ctx.ui.setPanel("friends", panel());
    await ctx.ui.toast(`${friends.length} friends`);
  },
});
