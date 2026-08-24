/**
 * The nodes that act on **you**, rather than on somebody else.
 *
 * Everything in `actions.ts` reaches outward: an invite lands in a stranger's notifications, a
 * Discord post appears on somebody's server. Everything here changes the user's own account — the
 * status on their profile, who they are friends with, what they have favourited, which group badge
 * they wear. That is a different kind of act, and the palette says so: these are the **Me**
 * category, and `Wear an avatar`, `My friends` and `Who is here` moved here to join them.
 *
 * ## Why these exist when the API nodes already could
 *
 * All of this was reachable through the 286 generated `(API)` nodes, and that is exactly the
 * problem. `Update user (API)` wants a `json` body the author assembles by hand out of VRChat's
 * field names, hands back an untyped blob, and reports a refusal as the number 403. These are the
 * same calls with typed ports, a name somebody can find by searching the palette for the thing they
 * want to do, and VRChat's own sentence when it says no. The generated nodes remain the floor: the
 * endpoint nobody wrote a node for is still reachable.
 *
 * ## Dry-run rehearses, including the reads
 *
 * Every write here rehearses like any other action: a `graph.note` saying what it would have done,
 * and no request. The reads (`Me`, `My account`, `My notifications`, `My groups`) really run, for
 * the same reason a generated `GET` does — suppressing them leaves every node downstream with no
 * data, which turns the rehearsal into a test of a different graph than the one being armed.
 *
 * `Me` and `My account` cost **no request at all**: they read the `CurrentUser` the account already
 * holds. That is what makes it safe to put one at the top of a graph firing on every `player_join`
 * in a busy public instance.
 *
 * ## Two nodes for the current user, not one
 *
 * `MAX_NODE_PORTS` is 16 and the useful fields are about twenty, so the split is forced — but it
 * lands somewhere real. `Me` is identity and state, the ports a graph reaches for. `My account` is
 * counts and entitlements, the ports a graph *checks*. Both read the same cached record, so two
 * nodes is not two requests.
 */

import type {
  NodeConfigField,
  NodeConfigValues,
  NodeDefinition,
  PortValues,
} from "@vrcz/plugin-api/nodes";
import type { EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import type { BuiltinNode } from "./types.ts";

/** The category every node in this file lives under. Named once so it cannot drift. */
export const ME_CATEGORY = "Me";

/**
 * The pseudo node id the invisible/restore pair shares in `graph_state`.
 *
 * State is keyed `(graph, node, key)`, and a constant in the node slot is what lets two *different*
 * nodes read each other's row: `Go invisible` writes it, `Put my status back` reads it, and the key
 * is the account so one graph handling two accounts keeps them apart.
 *
 * It is graph-scoped and cannot be otherwise: `graph_state.graph_id` is a foreign key onto `graphs`
 * with a cascade, so there is no row a sentinel graph id could occupy. Two graphs going invisible on
 * one account therefore each remember their own status — see PROGRESS.md Gotchas.
 */
const STATUS_MEMORY_KEY = "previous-status";

/**
 * The moderations VRChat keeps against the user's own account.
 *
 * Structurally identical to `wiring/self-actions.ts`'s type and redeclared rather than imported,
 * which is the same arrangement `GraphSocialActions` and `GraphReads` use: `graphs/` states the
 * shape it needs, `wiring/` satisfies it, and neither module knows the other exists.
 */
export type GraphModeration = "block" | "mute" | "hideAvatar";

export type GraphFavoriteKind = "world" | "avatar" | "friend" | "group";

export interface GraphAccountSummary {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly online: boolean;
}

export interface GraphGameState {
  readonly running: boolean;
  readonly platform: string;
  readonly location: string;
}

/** What the Me nodes need. Satisfied by `wiring/self-actions.ts`; see the note on the types above. */
export interface GraphSelf {
  me(accountId: string, refresh?: boolean): Promise<Record<string, unknown>>;
  accounts(): GraphAccountSummary[];
  gameState(accountId: string | null): GraphGameState;

  updateProfile(accountId: string, patch: Record<string, unknown>): Promise<void>;

  unfriend(accountId: string, userId: string): Promise<void>;
  moderate(accountId: string, userId: string, type: GraphModeration, on: boolean): Promise<void>;

  favorite(
    accountId: string,
    kind: GraphFavoriteKind,
    targetId: string,
    group: string | null,
  ): Promise<void>;
  unfavorite(accountId: string, targetId: string): Promise<void>;

  notifications(accountId: string): Promise<Record<string, unknown>[]>;
  acceptNotification(accountId: string, notificationId: string): Promise<void>;
  declineNotification(accountId: string, notificationId: string): Promise<void>;
  markNotificationRead(accountId: string, notificationId: string): Promise<void>;
  clearNotifications(accountId: string): Promise<void>;
  respondToInvite(accountId: string, notificationId: string, responseSlot: number): Promise<void>;

  groups(accountId: string): Promise<Record<string, unknown>[]>;
  joinGroup(accountId: string, groupId: string): Promise<Record<string, unknown>>;
  leaveGroup(accountId: string, groupId: string): Promise<void>;
  representGroup(accountId: string, groupId: string, representing: boolean): Promise<void>;
  postToGroup(
    accountId: string,
    groupId: string,
    post: { title: string; text: string; notify: boolean; visibility: string },
  ): Promise<Record<string, unknown>>;

  inviteSelfTo(accountId: string, location: string): Promise<void>;
}

/**
 * Opening a `vrchat://` link, for `Show an instance in VRChat`.
 *
 * Satisfied by `os/open-url.ts`. Best-effort like every other opener there: a machine with no
 * VRChat installed, or a Linux box with no protocol handler, are normal environments and none of
 * them is a reason to fail the run. The boolean says whether the opener was launched, never whether
 * the client did anything.
 */
export type GraphLaunchVrchat = (location: string, attach: boolean) => Promise<boolean>;

/** Where the invisible/restore pair remembers things. The same seam `stateful.ts` declares. */
export interface GraphSelfMemory {
  get(graphId: string, nodeId: string, key: string): { value: string; updatedAt: number } | null;
  put(graphId: string, nodeId: string, key: string, value: string, now: number): void;
}

export interface MeDeps {
  readonly bus: EventBus;
  readonly self?: GraphSelf | undefined;
  readonly launch?: GraphLaunchVrchat | undefined;
  /** Absent leaves `Go invisible` unable to remember, which the node says rather than guessing. */
  readonly memory?: GraphSelfMemory | undefined;
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------------------------- */
/* Shared plumbing                                                                                */
/* -------------------------------------------------------------------------------------------- */

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function configText(config: NodeConfigValues, key: string): string {
  const raw = config[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function configNumber(config: NodeConfigValues, key: string, fallback: number): number {
  const raw = config[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Which account a node acts as.
 *
 * The `accountId` config field is the picker's value; blank falls back to the graph's own account,
 * which is what almost every graph wants. Neither present is an error with a sentence rather than
 * a silent guess: acting as the wrong person is the worst outcome available here.
 *
 * Note the engine has already folded the node's own account into `context.accountId` where it
 * could; this handles the field directly as well so a node picker set on a graph with no account
 * still works.
 */
function actingAccount(config: NodeConfigValues, context: ExecuteContext, doing: string): string {
  const picked = configText(config, "accountId");
  if (picked !== "") return picked;
  if (context.accountId === null || context.accountId === "") {
    throw new Error(`No account is set for this graph, so vrc.zip cannot ${doing}.`);
  }
  return context.accountId;
}

/**
 * Where this account is, or `""` when it is nowhere.
 *
 * The log first and VRChat's own `presence` second: the client on this machine knows where it is,
 * and VRChat knows what it was last told. They disagree constantly. `offline` is not a place, so it
 * comes back as nothing rather than flowing into an invite as a location.
 */
function whereAmI(me: Record<string, unknown>, game: GraphGameState): string {
  const presence = me.presence;
  const fallback =
    typeof presence === "object" && presence !== null
      ? presenceLocation(presence as Record<string, unknown>)
      : "";
  const location = game.location === "" ? fallback : game.location;
  return location === "offline" ? "" : location;
}

/**
 * VRChat's own answer about where this account is, as a location.
 *
 * The two halves live in two fields: `presence.world` is a **world id** and `presence.instance` is
 * the instance beside it (`CurrentUserPresence` in the pinned spec). Reading `world` alone handed a
 * bare `wrld_…` to `Invite myself`, which is not an instance and cannot be invited to. A world with
 * no instance is nowhere, and so is `private` or `offline` sitting where a world id belongs — both
 * come back as empty rather than as a place.
 */
function presenceLocation(presence: Record<string, unknown>): string {
  const world = text(presence.world);
  const instance = text(presence.instance);
  if (!world.startsWith("wrld_") || instance === "") return "";
  return `${world}:${instance}`;
}

/**
 * The world half of a location.
 *
 * `""` for `private` and for anything else that is not a world id — VRChat writes `private` where a
 * world would go when it will not say, and a graph must not receive that in a `world` port and then
 * spend a request looking it up.
 */
function worldOfLocation(location: string): string {
  const colon = location.indexOf(":");
  const world = colon === -1 ? location : location.slice(0, colon);
  return world.startsWith("wrld_") ? world : "";
}

/** "This is what I would have done." The same rehearsal note every other action emits. */
function rehearse(deps: MeDeps, context: ExecuteContext, what: string): void {
  deps.bus.emit({
    kind: "graph.note",
    accountId: context.accountId,
    ts: (deps.now ?? Date.now)(),
    subjectId: context.graphId,
    payload: { graphId: context.graphId, node: context.nodeId, dryRun: true, note: what },
  });
}

/** The account picker, on every node here. Blank means the graph's account. */
const ACT_AS: NodeConfigField = {
  kind: "account",
  id: "accountId",
  label: "Act as",
  description: "Leave blank to use the graph's account.",
};

/* -------------------------------------------------------------------------------------------- */
/* Reads                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const ME: NodeDefinition = {
  id: "me",
  kind: "action",
  title: "Me",
  description: "Who this account is and what it is doing right now. Costs no request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "user", label: "My user", type: "user" },
    { id: "name", label: "Name", type: "string" },
    { id: "status", label: "Status", type: "string" },
    { id: "statusMessage", label: "Status message", type: "string" },
    { id: "bio", label: "Bio", type: "string" },
    { id: "pronouns", label: "Pronouns", type: "string" },
    { id: "picture", label: "Picture", type: "string" },
    { id: "joined", label: "Joined", type: "string" },
    {
      id: "instance",
      label: "Where I am",
      type: "instance",
      description: "From the running game client's log, which is the only source that knows.",
    },
    { id: "platform", label: "Platform", type: "string", description: "vr or desktop." },
    { id: "playing", label: "Game is running", type: "boolean" },
    { id: "home", label: "Home world", type: "world" },
    { id: "avatar", label: "Wearing", type: "avatar" },
    { id: "me", label: "Everything", type: "json" },
  ],
  config: [
    ACT_AS,
    {
      kind: "boolean",
      id: "refresh",
      label: "Ask VRChat again",
      description: "Off reads what vrc.zip already holds, which costs nothing. On costs a request.",
      default: false,
    },
  ],
  body: [{ kind: "literal", text: "me" }],
};

const MY_ACCOUNT: NodeDefinition = {
  id: "my-account",
  kind: "action",
  title: "My account",
  description: "Counts and entitlements: friends, trust, VRC+, verification. Costs no request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "trust", label: "Trust", type: "string" },
    { id: "vrcPlus", label: "Has VRC+", type: "boolean" },
    { id: "friends", label: "Friends", type: "number" },
    { id: "onlineFriends", label: "Friends online", type: "number" },
    { id: "activeFriends", label: "Friends active", type: "number" },
    { id: "ageVerified", label: "Age verified", type: "boolean" },
    { id: "emailVerified", label: "Email verified", type: "boolean" },
    { id: "twoFactor", label: "Two-factor on", type: "boolean" },
    { id: "tags", label: "Tags", type: "list<string>" },
    { id: "me", label: "Everything", type: "json" },
  ],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my account" }],
};

const MY_ACCOUNTS: NodeDefinition = {
  id: "my-accounts",
  kind: "action",
  title: "My accounts",
  description: "Every account vrc.zip manages, and whether it is signed in.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "accounts", label: "Accounts", type: "list<string>", description: "Account ids." },
    { id: "names", label: "Names", type: "list<string>" },
    { id: "online", label: "How many online", type: "number" },
    { id: "count", label: "How many", type: "number" },
  ],
  body: [{ kind: "literal", text: "my accounts" }],
};

const MY_GAME: NodeDefinition = {
  id: "my-game",
  kind: "action",
  title: "Is my game running",
  description: "Whether a VRChat client is open on this machine, from its log.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "running", label: "Running", type: "boolean" },
    { id: "platform", label: "Platform", type: "string" },
    { id: "instance", label: "Where", type: "instance" },
  ],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "is my game running" }],
};

const MY_NOTIFICATIONS: NodeDefinition = {
  id: "my-notifications",
  kind: "action",
  title: "My notifications",
  description: "Pending invites, friend requests and the rest, as VRChat holds them.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "notifications", label: "Notifications", type: "json" },
    { id: "ids", label: "Ids", type: "list<string>" },
    { id: "senders", label: "From", type: "list<user>" },
    { id: "first", label: "Newest", type: "json" },
    { id: "count", label: "How many", type: "number" },
  ],
  config: [
    ACT_AS,
    {
      kind: "text",
      id: "type",
      label: "Only this type",
      placeholder: "friendRequest, invite, requestInvite…",
      description: "Optional. VRChat's own spelling.",
    },
  ],
  body: [{ kind: "literal", text: "my notifications" }],
};

/**
 * The five one-port reads: where I am, what I am wearing, where I live, whose badge I wear.
 *
 * `Me` already carries every one of these, and that is the point. A graph that only wants the world
 * it is standing in should not have to place a fourteen-port node and know which of them to pull —
 * it should place `My current world` and wire the one wire. They read the same cached record `Me`
 * does, so putting one of these beside a `Me` is not a second request.
 *
 * **They hand back an id, not an object.** Turning one into a name is `Look up a world`'s job, and
 * that is the node that spends the request. Keeping the split means a graph that just wants to
 * compare where it is against where it was costs nothing at all.
 *
 * The one exception is `My current group`, which VRChat does not put in the current-user record: the
 * representation lives on the membership list, so that node costs the same request `My groups` does
 * and says so.
 */
const MY_WORLD: NodeDefinition = {
  id: "my-world",
  kind: "action",
  title: "My current world",
  description: "The world this account is standing in, as an id. Costs no request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [{ id: "world", label: "World", type: "world" }],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my current world" }],
};

const MY_INSTANCE: NodeDefinition = {
  id: "my-instance",
  kind: "action",
  title: "My current instance",
  description: "The instance this account is in, as VRChat writes it. Costs no request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [{ id: "instance", label: "Instance", type: "instance" }],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my current instance" }],
};

const MY_AVATAR: NodeDefinition = {
  id: "my-avatar",
  kind: "action",
  title: "My current avatar",
  description: "The avatar this account is wearing, as an id. Costs no request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [{ id: "avatar", label: "Avatar", type: "avatar" }],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my current avatar" }],
};

const MY_HOME_WORLD: NodeDefinition = {
  id: "my-home-world",
  kind: "action",
  title: "My home world",
  description: "The world this account spawns into, as an id. Costs no request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [{ id: "world", label: "World", type: "world" }],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my home world" }],
};

const MY_GROUP: NodeDefinition = {
  id: "my-group",
  kind: "action",
  title: "My current group",
  description: "The group badge on your profile right now. Costs a request.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "group", label: "Group", type: "group" },
    { id: "name", label: "Name", type: "string" },
  ],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my current group" }],
};

const MY_GROUPS: NodeDefinition = {
  id: "my-groups",
  kind: "action",
  title: "My groups",
  description: "The groups this account is in, and its role in each.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "groups", label: "Groups", type: "list<group>" },
    { id: "names", label: "Names", type: "list<string>" },
    { id: "count", label: "How many", type: "number" },
    { id: "all", label: "Everything", type: "json" },
  ],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "my groups" }],
};

/* -------------------------------------------------------------------------------------------- */
/* Profile                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const STATUS_OPTIONS = [
  { value: "", label: "Leave it alone" },
  { value: "join me", label: "Join me" },
  { value: "active", label: "Online" },
  { value: "ask me", label: "Ask me" },
  { value: "busy", label: "Do not disturb" },
  { value: "offline", label: "Invisible" },
] as const;

const SET_STATUS: NodeDefinition = {
  id: "set-status",
  kind: "action",
  title: "Set my status",
  description: "Changes the status dot, the message beside it, or both.",
  category: ME_CATEGORY,
  inputs: [
    {
      id: "message",
      label: "Status message",
      type: "string",
      description: "Leave unwired to keep the current one.",
    },
  ],
  outputs: [{ id: "set", label: "Set", type: "boolean" }],
  config: [
    ACT_AS,
    { kind: "select", id: "status", label: "Status", options: [...STATUS_OPTIONS], default: "" },
  ],
  body: [
    { kind: "literal", text: "status " },
    { kind: "config", field: "status", fallback: "message" },
  ],
};

const GO_INVISIBLE: NodeDefinition = {
  id: "go-invisible",
  kind: "action",
  title: "Go invisible",
  description: "Sets the status to offline and remembers what it was, for Put my status back.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "was", label: "Was", type: "string" },
    { id: "set", label: "Set", type: "boolean" },
  ],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "go invisible" }],
};

const RESTORE_STATUS: NodeDefinition = {
  id: "restore-status",
  kind: "action",
  title: "Put my status back",
  description: "Restores whatever Go invisible replaced. Does nothing if it never ran.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "status", label: "Restored to", type: "string" },
    { id: "set", label: "Set", type: "boolean" },
  ],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "put my status back" }],
};

const SET_BIO: NodeDefinition = {
  id: "set-bio",
  kind: "action",
  title: "Set my bio",
  description: "Rewrites the bio on your profile, and optionally its links.",
  category: ME_CATEGORY,
  inputs: [
    { id: "bio", label: "Bio", type: "string" },
    {
      id: "links",
      label: "Links",
      type: "list<string>",
      description: "Leave unwired to keep the current ones. An empty list clears them.",
    },
  ],
  outputs: [{ id: "set", label: "Set", type: "boolean" }],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "set my bio" }],
};

const SET_PRONOUNS: NodeDefinition = {
  id: "set-pronouns",
  kind: "action",
  title: "Set my pronouns",
  description: "Changes the pronouns shown on your profile.",
  category: ME_CATEGORY,
  inputs: [{ id: "pronouns", label: "Pronouns", type: "string", required: true }],
  outputs: [{ id: "set", label: "Set", type: "boolean" }],
  config: [ACT_AS],
  body: [
    { kind: "literal", text: "pronouns " },
    { kind: "port", port: "pronouns" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Friends and moderation                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * The five one-input nodes that act on somebody, from your side.
 *
 * `Unfriend` takes a `friend` rather than a `user` on purpose, and it is the clearest thing the
 * port lattice buys: a graph wiring a stranger into it is refused **in the editor**, not at 3 AM.
 * Blocking and muting take a `user`, because you can block somebody you were never friends with.
 */
const UNFRIEND: NodeDefinition = {
  id: "unfriend",
  kind: "action",
  title: "Unfriend",
  description: "Removes somebody from your friends list. There is no undo.",
  category: ME_CATEGORY,
  inputs: [{ id: "user", label: "Who", type: "friend", required: true }],
  outputs: [{ id: "done", label: "Done", type: "boolean" }],
  config: [ACT_AS],
  body: [
    { kind: "literal", text: "unfriend " },
    { kind: "port", port: "user" },
  ],
};

interface ModerationSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly type: GraphModeration;
  readonly on: boolean;
  readonly verb: string;
}

const MODERATIONS: readonly ModerationSpec[] = [
  {
    id: "block",
    title: "Block",
    description: "Blocks somebody. Mutual and immediate, and a mistake nobody can walk back.",
    type: "block",
    on: true,
    verb: "block",
  },
  {
    id: "unblock",
    title: "Unblock",
    description: "Lifts a block.",
    type: "block",
    on: false,
    verb: "unblock",
  },
  {
    id: "mute",
    title: "Mute",
    description: "Mutes somebody for you, everywhere.",
    type: "mute",
    on: true,
    verb: "mute",
  },
  {
    id: "unmute",
    title: "Unmute",
    description: "Lifts a mute.",
    type: "mute",
    on: false,
    verb: "unmute",
  },
  {
    id: "hide-avatar",
    title: "Hide their avatar",
    description: "Shows somebody as a fallback avatar for you.",
    type: "hideAvatar",
    on: true,
    verb: "hide the avatar of",
  },
  {
    id: "show-avatar",
    title: "Show their avatar",
    description: "Lifts an avatar hide.",
    type: "hideAvatar",
    on: false,
    verb: "show the avatar of",
  },
];

function moderationDefinition(spec: ModerationSpec): NodeDefinition {
  return {
    id: spec.id,
    kind: "action",
    title: spec.title,
    description: spec.description,
    category: ME_CATEGORY,
    inputs: [{ id: "user", label: "Who", type: "user", required: true }],
    outputs: [{ id: "done", label: "Done", type: "boolean" }],
    config: [ACT_AS],
    body: [
      { kind: "literal", text: `${spec.id.replace("-", " ")} ` },
      { kind: "port", port: "user" },
    ],
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Favourites                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Four kinds, two directions, eight one-line nodes — and typed ports on every one.
 *
 * A single `Favorite` node with a kind picker was the alternative and it costs the thing the port
 * lattice is for: its input would have to be `json`, so a world wired into a friend favourite would
 * be a 400 at run time instead of a refused edge in the editor.
 *
 * **VRC+ limits are VRChat's to enforce and they are enforced upstream.** A full group answers 400
 * with a sentence about the user's own entitlements, and that sentence is what the node reports.
 * See PLAN.md §Guardrails: working around a paid limit is not something this project does.
 */
interface FavoriteSpec {
  readonly kind: GraphFavoriteKind;
  readonly port: "world" | "avatar" | "friend" | "group";
  readonly noun: string;
}

const FAVORITES: readonly FavoriteSpec[] = [
  { kind: "world", port: "world", noun: "world" },
  { kind: "avatar", port: "avatar", noun: "avatar" },
  { kind: "friend", port: "friend", noun: "friend" },
  { kind: "group", port: "group", noun: "group" },
];

function favoriteDefinition(spec: FavoriteSpec, add: boolean): NodeDefinition {
  return {
    id: `${add ? "favorite" : "unfavorite"}-${spec.kind}`,
    kind: "action",
    title: `${add ? "Favorite" : "Unfavorite"} a ${spec.noun}`,
    description: add
      ? `Adds a ${spec.noun} to your favourites. VRChat enforces your VRC+ limits.`
      : `Removes a ${spec.noun} from your favourites.`,
    category: ME_CATEGORY,
    inputs: [{ id: "target", label: titleCase(spec.noun), type: spec.port, required: true }],
    outputs: [{ id: "done", label: "Done", type: "boolean" }],
    config: add
      ? [
          ACT_AS,
          {
            kind: "text",
            id: "group",
            label: "Into group",
            placeholder: `${spec.kind}s1`,
            description: "Optional. One of your favourite group names.",
          },
        ]
      : [ACT_AS],
    body: [
      { kind: "literal", text: `${add ? "favorite" : "unfavorite"} ` },
      { kind: "port", port: "target" },
    ],
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* -------------------------------------------------------------------------------------------- */
/* Notifications                                                                                  */
/* -------------------------------------------------------------------------------------------- */

function notificationDefinition(
  id: string,
  title: string,
  description: string,
  verb: string,
): NodeDefinition {
  return {
    id,
    kind: "action",
    title,
    description,
    category: ME_CATEGORY,
    inputs: [
      {
        id: "notification",
        label: "Notification",
        type: "string",
        required: true,
        description: "A notification id, from My notifications or from a trigger.",
      },
    ],
    outputs: [{ id: "done", label: "Done", type: "boolean" }],
    config: [ACT_AS],
    body: [
      { kind: "literal", text: `${verb} ` },
      { kind: "port", port: "notification" },
    ],
  };
}

const CLEAR_NOTIFICATIONS: NodeDefinition = {
  id: "clear-notifications",
  kind: "action",
  title: "Clear my notifications",
  description: "Marks every pending notification as gone. There is no undo.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [{ id: "done", label: "Done", type: "boolean" }],
  config: [ACT_AS],
  body: [{ kind: "literal", text: "clear my notifications" }],
};

const RESPOND_INVITE: NodeDefinition = {
  id: "respond-invite",
  kind: "action",
  title: "Reply to an invite",
  description: "Answers an invite with one of your saved response messages.",
  category: ME_CATEGORY,
  inputs: [{ id: "notification", label: "Notification", type: "string", required: true }],
  outputs: [{ id: "done", label: "Done", type: "boolean" }],
  config: [
    ACT_AS,
    {
      kind: "number",
      id: "slot",
      label: "Response slot",
      min: 0,
      max: 11,
      default: 0,
      description: "Which of your saved response messages, as VRChat numbers them.",
    },
  ],
  body: [{ kind: "literal", text: "reply to an invite" }],
};

/* -------------------------------------------------------------------------------------------- */
/* Groups                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const JOIN_GROUP: NodeDefinition = {
  id: "join-group",
  kind: "action",
  title: "Join a group",
  description: "Joins a group, or asks to. Many groups need approval, so read the state back.",
  category: ME_CATEGORY,
  inputs: [{ id: "group", label: "Group", type: "group", required: true }],
  outputs: [
    {
      id: "state",
      label: "State",
      type: "string",
      description: "member when you are in, requested when the group has to approve you.",
    },
    { id: "joined", label: "Joined", type: "boolean" },
  ],
  config: [ACT_AS],
  body: [
    { kind: "literal", text: "join " },
    { kind: "port", port: "group" },
  ],
};

const LEAVE_GROUP: NodeDefinition = {
  id: "leave-group",
  kind: "action",
  title: "Leave a group",
  description: "Leaves a group, or cancels a pending request to join one.",
  category: ME_CATEGORY,
  inputs: [{ id: "group", label: "Group", type: "group", required: true }],
  outputs: [{ id: "done", label: "Done", type: "boolean" }],
  config: [ACT_AS],
  body: [
    { kind: "literal", text: "leave " },
    { kind: "port", port: "group" },
  ],
};

const REPRESENT_GROUP: NodeDefinition = {
  id: "represent-group",
  kind: "action",
  title: "Represent a group",
  description: "Sets which group badge shows on your profile, or clears it.",
  category: ME_CATEGORY,
  inputs: [{ id: "group", label: "Group", type: "group", required: true }],
  outputs: [{ id: "done", label: "Done", type: "boolean" }],
  config: [
    ACT_AS,
    {
      kind: "boolean",
      id: "stop",
      label: "Stop representing instead",
      description: "On clears the badge rather than setting it.",
      default: false,
    },
  ],
  body: [
    { kind: "literal", text: "represent " },
    { kind: "port", port: "group" },
  ],
};

const POST_TO_GROUP: NodeDefinition = {
  id: "post-to-group",
  kind: "action",
  title: "Post to a group",
  description: "Writes a group post. Needs a role in that group that may do it.",
  category: ME_CATEGORY,
  inputs: [
    { id: "group", label: "Group", type: "group", required: true },
    { id: "text", label: "Text", type: "string", required: true },
  ],
  outputs: [{ id: "post", label: "Post", type: "json" }],
  config: [
    ACT_AS,
    { kind: "text", id: "title", label: "Title", default: "vrc.zip" },
    {
      kind: "select",
      id: "visibility",
      label: "Visible to",
      options: [
        { value: "group", label: "The group" },
        { value: "public", label: "Everyone" },
      ],
      default: "group",
    },
    {
      kind: "boolean",
      id: "notify",
      label: "Notify members",
      description: "Off posts quietly. On puts it in every member's notifications.",
      default: false,
    },
  ],
  body: [
    { kind: "literal", text: "post to " },
    { kind: "port", port: "group" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Travel                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * The two ways to get yourself somewhere, and they are genuinely different acts.
 *
 * `Invite myself` costs a VRChat request and puts a notification in your own inbox, which a client
 * that is *already running* can act on. `Show an instance in VRChat` costs nothing upstream and
 * touches the machine instead: it fires the `vrchat://` handler, which with `attach=1` brings the
 * instance page up in a running client rather than starting a second one.
 *
 * Two clients on one account fight over it, which is why nothing here guesses between them.
 */
const INVITE_MYSELF: NodeDefinition = {
  id: "invite-myself",
  kind: "action",
  title: "Invite myself",
  description: "Puts an invite in your own notifications, so a running client can travel there.",
  category: ME_CATEGORY,
  inputs: [{ id: "instance", label: "Instance", type: "instance", required: true }],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [ACT_AS],
  body: [
    { kind: "literal", text: "invite myself to " },
    { kind: "port", port: "instance" },
  ],
};

const SHOW_IN_VRCHAT: NodeDefinition = {
  id: "show-in-vrchat",
  kind: "action",
  title: "Show an instance in VRChat",
  description: "Opens the instance page in the VRChat client on this machine, so you can join it.",
  category: ME_CATEGORY,
  inputs: [{ id: "instance", label: "Instance", type: "instance", required: true }],
  outputs: [
    {
      id: "opened",
      label: "Opened",
      type: "boolean",
      description: "Whether the handler was launched, not whether VRChat did anything.",
    },
  ],
  config: [
    {
      kind: "boolean",
      id: "attach",
      label: "Use the running client",
      description: "Off starts a fresh client instead, which fights with one already running.",
      default: true,
    },
  ],
  body: [
    { kind: "literal", text: "show " },
    { kind: "port", port: "instance" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function meNodes(deps: MeDeps): BuiltinNode[] {
  function self(): GraphSelf {
    if (deps.self === undefined) {
      throw new Error("This daemon cannot act on your VRChat account.");
    }
    return deps.self;
  }

  const clock = (): number => (deps.now ?? Date.now)();

  /**
   * A write, with the rehearsal branch every action here shares.
   *
   * The return type is spelled out rather than borrowed from `BuiltinNode["execute"]`, which is
   * optional and so includes `undefined` — under `exactOptionalPropertyTypes` that is not a handler.
   */
  function write(
    doing: string,
    note: (inputs: PortValues, config: NodeConfigValues) => string,
    run: (account: string, inputs: PortValues, config: NodeConfigValues) => Promise<void>,
    outputs: PortValues = { done: true },
  ): (
    inputs: PortValues,
    config: NodeConfigValues,
    context: ExecuteContext,
  ) => Promise<PortValues> {
    return async (inputs, config, context): Promise<PortValues> => {
      const account = actingAccount(config, context, doing);
      if (context.dryRun) {
        rehearse(deps, context, note(inputs, config));
        return Object.fromEntries(Object.keys(outputs).map((key) => [key, false]));
      }
      await run(account, inputs, config);
      return outputs;
    };
  }

  const nodes: BuiltinNode[] = [
    {
      definition: ME,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read your own profile");
        const me = await self().me(account, config.refresh === true);
        const game = self().gameState(account);
        const location = whereAmI(me, game);
        return {
          user: text(me.id),
          name: text(me.displayName),
          status: text(me.status),
          statusMessage: text(me.statusDescription),
          bio: text(me.bio),
          pronouns: text(me.pronouns),
          picture:
            text(me.userIcon) || text(me.profilePicOverride) || text(me.currentAvatarImageUrl),
          joined: text(me.date_joined),
          // Absent rather than empty: an empty `instance` flowing into an invite node would produce
          // a request about nowhere, which is the same reason `Look up a user` omits it.
          ...(location === "" ? {} : { instance: location }),
          platform: game.platform === "" ? text(me.last_platform) : game.platform,
          playing: game.running,
          ...(text(me.homeLocation) === "" ? {} : { home: me.homeLocation }),
          ...(text(me.currentAvatar) === "" ? {} : { avatar: me.currentAvatar }),
          me,
        };
      },
    },
    {
      definition: MY_ACCOUNT,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read your own account");
        const me = await self().me(account);
        const tags = stringList(me.tags);
        return {
          // The trust rank is a tag rather than a field, which is VRChat's own arrangement and the
          // reason `Look up a user` has a `trustLevel` and this does not.
          trust: trustFromTags(tags),
          vrcPlus: tags.includes("system_supporter"),
          friends: stringList(me.friends).length,
          onlineFriends: stringList(me.onlineFriends).length,
          activeFriends: stringList(me.activeFriends).length,
          ageVerified: me.ageVerified === true,
          emailVerified: me.emailVerified === true,
          twoFactor: me.twoFactorAuthEnabled === true,
          tags,
          me,
        };
      },
    },
    {
      definition: MY_ACCOUNTS,
      execute: (): PortValues => {
        const accounts = self().accounts();
        return {
          accounts: accounts.map((account) => account.id),
          names: accounts.map((account) => account.displayName),
          online: accounts.filter((account) => account.online).length,
          count: accounts.length,
        };
      },
    },
    {
      definition: MY_GAME,
      execute: (_inputs, config, context): PortValues => {
        // No account required: a client signed into an account vrc.zip does not manage is still a
        // running game, and the honest answer is about the machine rather than about the account.
        const picked = configText(config, "accountId");
        const account = picked === "" ? context.accountId : picked;
        const game = self().gameState(account);
        return {
          running: game.running,
          platform: game.platform,
          ...(game.location === "" ? {} : { instance: game.location }),
        };
      },
    },
    {
      definition: MY_NOTIFICATIONS,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read your notifications");
        const wanted = configText(config, "type");
        const all = await self().notifications(account);
        const notifications =
          wanted === "" ? all : all.filter((entry) => text(entry.type) === wanted);
        return {
          notifications,
          ids: notifications.map((entry) => text(entry.id)).filter((id) => id !== ""),
          senders: notifications.map((entry) => text(entry.senderUserId)).filter((id) => id !== ""),
          ...(notifications[0] === undefined ? {} : { first: notifications[0] }),
          count: notifications.length,
        };
      },
    },
    {
      definition: MY_WORLD,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read where you are");
        const me = await self().me(account);
        const world = worldOfLocation(whereAmI(me, self().gameState(account)));
        // Nothing rather than an empty id, which gates whatever is downstream. Not being in a world
        // is an ordinary state — the client is closed, or you are somewhere VRChat will not name.
        return world === "" ? {} : { world };
      },
    },
    {
      definition: MY_INSTANCE,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read where you are");
        const me = await self().me(account);
        const instance = whereAmI(me, self().gameState(account));
        return instance === "" ? {} : { instance };
      },
    },
    {
      definition: MY_AVATAR,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read what you are wearing");
        const me = await self().me(account);
        const avatar = text(me.currentAvatar);
        return avatar === "" ? {} : { avatar };
      },
    },
    {
      definition: MY_HOME_WORLD,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read your home world");
        const me = await self().me(account);
        // An account with no home set is a real state, and VRChat writes it as an empty string.
        const world = text(me.homeLocation);
        return world === "" ? {} : { world };
      },
    },
    {
      definition: MY_GROUP,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "read which group you represent");
        const groups = await self().groups(account);
        // VRChat keeps the representation on the membership rather than on the user, so this is the
        // one node here that costs a request. Representing nothing is the common case.
        const representing = groups.find((group) => group.isRepresenting === true);
        if (representing === undefined) return {};
        const id = text(representing.groupId) || text(representing.id);
        return id === "" ? {} : { group: id, name: text(representing.name) };
      },
    },
    {
      definition: MY_GROUPS,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "list your groups");
        const groups = await self().groups(account);
        return {
          groups: groups
            .map((group) => text(group.groupId) || text(group.id))
            .filter((id) => id !== ""),
          names: groups.map((group) => text(group.name)),
          count: groups.length,
          all: groups,
        };
      },
    },

    {
      definition: SET_STATUS,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "change your status");
        const status = configText(config, "status");
        const message = inputs.message === undefined ? null : text(inputs.message);
        if (status === "" && message === null) {
          // Nothing to change is not a failure, and it is not a request either.
          return { set: false };
        }
        if (context.dryRun) {
          rehearse(
            deps,
            context,
            `set status${status === "" ? "" : ` to ${status}`}${message === null ? "" : `: ${message.slice(0, 200)}`}`,
          );
          return { set: false };
        }
        await self().updateProfile(account, {
          ...(status === "" ? {} : { status }),
          ...(message === null ? {} : { statusDescription: message }),
        });
        return { set: true };
      },
    },
    {
      definition: GO_INVISIBLE,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "go invisible");
        if (deps.memory === undefined) {
          throw new Error("This daemon cannot remember what your status was.");
        }
        const me = await self().me(account);
        const was = text(me.status);
        if (context.dryRun) {
          rehearse(deps, context, `go invisible, remembering ${was === "" ? "nothing" : was}`);
          return { was, set: false };
        }
        // Remembered *before* the write, so a status change that half-succeeds still leaves
        // something for the restore node to put back. Keyed by account rather than by node: the
        // pair is one gesture across two nodes, and two graphs going invisible on one account are
        // talking about the same status.
        if (was !== "" && was !== "offline") {
          deps.memory.put(context.graphId, STATUS_MEMORY_KEY, account, was, clock());
        }
        await self().updateProfile(account, { status: "offline" });
        return { was, set: true };
      },
    },
    {
      definition: RESTORE_STATUS,
      execute: async (_inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "put your status back");
        if (deps.memory === undefined) {
          throw new Error("This daemon cannot remember what your status was.");
        }
        const saved = deps.memory.get(context.graphId, STATUS_MEMORY_KEY, account);
        if (saved === null || saved.value === "") {
          // Nothing remembered is a real answer: Go invisible never ran, or a restore already did.
          return { status: "", set: false };
        }
        if (context.dryRun) {
          rehearse(deps, context, `put status back to ${saved.value}`);
          return { status: saved.value, set: false };
        }
        await self().updateProfile(account, { status: saved.value });
        // Cleared, so a second restore does not put back a status from an hour ago.
        deps.memory.put(context.graphId, STATUS_MEMORY_KEY, account, "", clock());
        return { status: saved.value, set: true };
      },
    },
    {
      definition: SET_BIO,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "change your bio");
        const bio = inputs.bio === undefined ? null : text(inputs.bio);
        const links = inputs.links === undefined ? null : stringList(inputs.links);
        if (bio === null && links === null) return { set: false };
        if (context.dryRun) {
          rehearse(deps, context, `set bio${bio === null ? "" : `: ${bio.slice(0, 200)}`}`);
          return { set: false };
        }
        await self().updateProfile(account, {
          ...(bio === null ? {} : { bio }),
          ...(links === null ? {} : { bioLinks: links }),
        });
        return { set: true };
      },
    },
    {
      definition: SET_PRONOUNS,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "change your pronouns");
        const pronouns = text(inputs.pronouns);
        if (context.dryRun) {
          rehearse(deps, context, `set pronouns to ${pronouns}`);
          return { set: false };
        }
        await self().updateProfile(account, { pronouns });
        return { set: true };
      },
    },

    {
      definition: UNFRIEND,
      execute: write(
        "unfriend somebody",
        (inputs) => `unfriend ${text(inputs.user)}`,
        async (account, inputs) => {
          await self().unfriend(account, text(inputs.user));
        },
      ),
    },

    ...MODERATIONS.map((spec) => ({
      definition: moderationDefinition(spec),
      execute: write(
        `${spec.verb} somebody`,
        (inputs) => `${spec.verb} ${text(inputs.user)}`,
        async (account, inputs) => {
          await self().moderate(account, text(inputs.user), spec.type, spec.on);
        },
      ),
    })),

    ...FAVORITES.flatMap((spec) => [
      {
        definition: favoriteDefinition(spec, true),
        execute: write(
          `favourite that ${spec.noun}`,
          (inputs) => `favourite ${text(inputs.target)}`,
          async (account, inputs, config) => {
            const group = configText(config, "group");
            await self().favorite(
              account,
              spec.kind,
              text(inputs.target),
              group === "" ? null : group,
            );
          },
        ),
      },
      {
        definition: favoriteDefinition(spec, false),
        execute: write(
          `unfavourite that ${spec.noun}`,
          (inputs) => `unfavourite ${text(inputs.target)}`,
          async (account, inputs) => {
            await self().unfavorite(account, text(inputs.target));
          },
        ),
      },
    ]),

    {
      definition: notificationDefinition(
        "accept-notification",
        "Accept a notification",
        "Accepts a friend request or an invite by id.",
        "accept",
      ),
      execute: write(
        "accept that",
        (inputs) => `accept ${text(inputs.notification)}`,
        async (account, inputs) => {
          await self().acceptNotification(account, text(inputs.notification));
        },
      ),
    },
    {
      definition: notificationDefinition(
        "decline-notification",
        "Decline a notification",
        "Declines a friend request or an invite by id.",
        "decline",
      ),
      execute: write(
        "decline that",
        (inputs) => `decline ${text(inputs.notification)}`,
        async (account, inputs) => {
          await self().declineNotification(account, text(inputs.notification));
        },
      ),
    },
    {
      definition: notificationDefinition(
        "mark-notification-read",
        "Mark a notification read",
        "Marks one notification as seen, without accepting or declining it.",
        "mark read",
      ),
      execute: write(
        "mark that read",
        (inputs) => `mark ${text(inputs.notification)} read`,
        async (account, inputs) => {
          await self().markNotificationRead(account, text(inputs.notification));
        },
      ),
    },
    {
      definition: CLEAR_NOTIFICATIONS,
      execute: write(
        "clear your notifications",
        () => "clear every notification",
        async (account) => {
          await self().clearNotifications(account);
        },
      ),
    },
    {
      definition: RESPOND_INVITE,
      execute: write(
        "respond to that invite",
        (inputs, config) =>
          `reply to ${text(inputs.notification)} with slot ${String(configNumber(config, "slot", 0))}`,
        async (account, inputs, config) => {
          await self().respondToInvite(
            account,
            text(inputs.notification),
            configNumber(config, "slot", 0),
          );
        },
      ),
    },

    {
      definition: JOIN_GROUP,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "join that group");
        const group = text(inputs.group);
        if (context.dryRun) {
          rehearse(deps, context, `join ${group}`);
          return { state: "", joined: false };
        }
        const result = await self().joinGroup(account, group);
        // VRChat answers with the membership, whose `membershipStatus` is the difference between
        // "you are in" and "the group has to approve you". A graph that assumed the first would
        // announce a join that has not happened.
        const state = text(result.membershipStatus);
        return { state, joined: state === "member" };
      },
    },
    {
      definition: LEAVE_GROUP,
      execute: write(
        "leave that group",
        (inputs) => `leave ${text(inputs.group)}`,
        async (account, inputs) => {
          await self().leaveGroup(account, text(inputs.group));
        },
      ),
    },
    {
      definition: REPRESENT_GROUP,
      execute: write(
        "change which group you represent",
        (inputs, config) =>
          `${config.stop === true ? "stop representing" : "represent"} ${text(inputs.group)}`,
        async (account, inputs, config) => {
          await self().representGroup(account, text(inputs.group), config.stop !== true);
        },
      ),
    },
    {
      definition: POST_TO_GROUP,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const account = actingAccount(config, context, "post to that group");
        const group = text(inputs.group);
        const body = text(inputs.text);
        if (context.dryRun) {
          rehearse(deps, context, `post to ${group}: ${body.slice(0, 200)}`);
          return {};
        }
        const post = await self().postToGroup(account, group, {
          title: configText(config, "title") || "vrc.zip",
          text: body,
          notify: config.notify === true,
          visibility: configText(config, "visibility") || "group",
        });
        return { post };
      },
    },

    {
      definition: INVITE_MYSELF,
      execute: write(
        "invite you there",
        (inputs) => `invite myself to ${text(inputs.instance)}`,
        async (account, inputs) => {
          await self().inviteSelfTo(account, text(inputs.instance));
        },
        { sent: true },
      ),
    },
    {
      definition: SHOW_IN_VRCHAT,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const location = text(inputs.instance);
        if (context.dryRun) {
          rehearse(deps, context, `show ${location} in VRChat`);
          return { opened: false };
        }
        if (deps.launch === undefined) {
          throw new Error("This daemon cannot open VRChat.");
        }
        return { opened: await deps.launch(location, config.attach !== false) };
      },
    },
  ];

  return nodes;
}

/**
 * The trust rank out of the tag list.
 *
 * VRChat carries it as `system_trust_veteran` and friends rather than as a field, and the ranks are
 * ordered — somebody trusted holds every tag below theirs — so the **highest** match is the answer.
 * An account with none of them is new, which is what VRChat calls "visitor".
 */
export function trustFromTags(tags: readonly string[]): string {
  const ranks: readonly (readonly [string, string])[] = [
    ["system_trust_veteran", "trusted"],
    ["system_trust_trusted", "known"],
    ["system_trust_known", "user"],
    ["system_trust_basic", "new"],
  ];
  for (const [tag, rank] of ranks) if (tags.includes(tag)) return rank;
  return "visitor";
}
