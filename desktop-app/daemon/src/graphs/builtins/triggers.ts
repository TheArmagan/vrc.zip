/**
 * Where a graph starts.
 *
 * All but two of these are the **same** node with a different subscription: one bus event trigger
 * that takes a pattern, and a handful of presets over it. The presets are not sugar — their value is
 * *typed outputs*. The generic trigger can only say `json`, so every edge out of it is untyped and
 * the lattice checks nothing; a preset knows that `friend.online` carries a friend id and can offer
 * a `friend` port, which is what makes the graph downstream type-check at all.
 *
 * A trigger **arms, it does not execute** (PLAN.md §Node type registration). Here that means it
 * subscribes to the bus and returns a teardown; the engine holds the subscription for as long as the
 * graph is enabled and drops it on reload.
 *
 * Filtering happens in the subscription rather than in the callback. `friend.location` fires for
 * every friend who moves and log tailing bursts forty player-joins on an instance transition, so an
 * irrelevant event has to cost one map lookup in the bus, not a wake-up per armed graph.
 */

import type {
  NodeConfigField,
  NodeConfigValues,
  NodeDefinition,
  PortValues,
} from "@vrcz/plugin-api/nodes";
import { BUS_EVENT_KINDS, EVENT_FAMILIES, isEventPatternString } from "@vrcz/shared";
import type { BusEvent, EventBus } from "../../bus/event-bus.ts";
import type { BuiltinArmRequest, BuiltinNode } from "./types.ts";

/**
 * The two questions a trigger asks about the world at the moment it fires.
 *
 * Satisfied by `wiring/trigger-context.ts`, the same arrangement `GraphSelf` and `GraphReads` use.
 * **Both are synchronous and free by contract**, and that is not a convenience: a map runs inside a
 * bus subscription, `gamelog.player_join` bursts forty times on an instance transition, and every
 * armed graph's map runs for each one. Anything that awaited here would stall a busy instance.
 *
 * Absent leaves the ports that depend on it unset and the filters that depend on it open, which is
 * the same rule the rest of this file follows: a missing answer is an unproduced port, never a
 * guessed one.
 */
export interface TriggerContext {
  location(accountId: string | null): string;
  isFriend(accountId: string | null, userId: string): boolean;
}

export interface TriggerDeps {
  readonly bus: EventBus;
  readonly now?: () => number;
  readonly context?: TriggerContext | undefined;
}

/** The account filter every trigger carries, and the one config field they all share. */
const ACCOUNT_FIELD: NodeConfigField = {
  kind: "account",
  id: "accountId",
  label: "Only this account",
  description: "Leave blank for every managed account.",
};

function accountFilter(config: NodeConfigValues): { accountId?: string } {
  const raw = config.accountId;
  return typeof raw === "string" && raw !== "" ? { accountId: raw } : {};
}

/**
 * Subscribes, maps, fires. The shape every trigger here shares.
 *
 * `map` returning null drops the event: a preset that cannot find what it promised in the payload
 * must not start a run with a missing port, because everything downstream would then run with
 * `undefined` where it expected a user.
 */
function busTrigger(
  deps: TriggerDeps,
  definition: NodeDefinition,
  kinds: (config: NodeConfigValues) => readonly string[],
  map: (event: BusEvent, config: NodeConfigValues) => PortValues | null,
): BuiltinNode {
  return {
    definition,
    arm: (request: BuiltinArmRequest) => {
      const patterns = kinds(request.config);
      if (patterns.length === 0) return;
      const subscription = deps.bus.subscribe(
        (event) => {
          const outputs = map(event, request.config);
          if (outputs !== null) request.fire(outputs);
        },
        { kinds: patterns, ...accountFilter(request.config) },
      );
      return () => {
        subscription.unsubscribe();
      };
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The generic one                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every family and every kind this build knows, as a picker.
 *
 * Families first and each marked, because `friend.*` is almost always the answer somebody wants and
 * an exact kind is the narrower, more fragile choice. The list is generated from the shared
 * vocabulary rather than typed out, so a kind added to `@vrcz/shared` appears here with no edit.
 */
const EVENT_KIND_OPTIONS = [
  ...EVENT_FAMILIES.filter((family) => family !== "other").map((family) => ({
    value: `${family}.*`,
    label: `${family}.* — anything in ${family}`,
  })),
  ...[...BUS_EVENT_KINDS].sort().map((kind) => ({ value: kind, label: kind })),
];

const ON_EVENT: NodeDefinition = {
  id: "on-event",
  kind: "trigger",
  title: "When something happens",
  description: "Fires on any event vrc.zip publishes. Name a kind, or a family with a star.",
  category: "Triggers",
  outputs: [
    { id: "event", label: "Event", type: "json" },
    { id: "kind", label: "Kind", type: "string" },
    { id: "at", label: "At", type: "number" },
  ],
  config: [
    /*
     * A picker *and* a free-text field, which is one more control than it looks like it needs.
     *
     * The picker is how anybody finds `instance.queue_ready` without reading the event catalog —
     * there are seventy-odd kinds and nobody remembers their spelling. The text field stays because
     * a picker cannot express two kinds at once, and cannot name a kind a newer daemon added that
     * this build has never heard of. The text field wins when both are set, since typing something
     * is the more deliberate act.
     */
    {
      kind: "select",
      id: "kind",
      label: "When",
      options: EVENT_KIND_OPTIONS,
      default: "friend.*",
    },
    {
      kind: "text",
      id: "kinds",
      label: "Or these, comma separated",
      placeholder: "friend.online, group.*",
      description: "Overrides the picker. A family pattern also matches kinds added later.",
    },
    ACCOUNT_FIELD,
  ],
  // Deliberately generous on fires: this is the escape hatch, and a user who points it at `*` on a
  // busy evening should be told by `graph.run.dropped` rather than quietly throttled to nothing.
  maxFiresPerMinute: 240,
};

/**
 * Patterns from a comma-separated config field, with the invalid ones dropped.
 *
 * Dropped rather than refused, and the difference matters at *this* layer: a graph whose only
 * pattern is a typo arms nothing and fires nothing, which is visible. A throw here would fail the
 * arm and take the rest of the graph's triggers with it.
 */
export function parsePatterns(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "" && isEventPatternString(entry)),
    ),
  ];
}

function baseOutputs(event: BusEvent): PortValues {
  return { event: event.payload ?? null, kind: event.kind, at: event.ts };
}

/* -------------------------------------------------------------------------------------------- */
/* The presets                                                                                    */
/* -------------------------------------------------------------------------------------------- */

interface Preset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly kinds: readonly string[];
  readonly outputs: NodeDefinition["outputs"];
  readonly map: (event: BusEvent, config: NodeConfigValues) => PortValues | null;
  readonly maxFiresPerMinute?: number;
  /**
   * Extra config beyond the account filter, which every preset gets for free.
   *
   * Filtering happens inside {@link Preset.map} rather than in a separate predicate, because a
   * preset that filters almost always wants to *also* put the thing it filtered on onto a port —
   * "only friends" and an `Is a friend` output are one question asked twice.
   */
  readonly config?: readonly NodeConfigField[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function payloadOf(event: BusEvent): Record<string, unknown> {
  const payload = event.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The who-filter the two player triggers share.
 *
 * `anyone` is the default and it is the behaviour these nodes have always had, so an author who
 * never opens the picker sees no change. The `only` field narrows further and wins over nothing —
 * both apply, so "a friend, and specifically this one" is expressible.
 */
const WHO_FIELDS: readonly NodeConfigField[] = [
  {
    kind: "select",
    id: "who",
    label: "Only",
    options: [
      { value: "anyone", label: "Anyone" },
      { value: "friends", label: "Friends" },
      { value: "strangers", label: "People who are not friends" },
    ],
    default: "anyone",
  },
  {
    kind: "user",
    id: "only",
    label: "Only this person",
    description: "Optional, and narrows the choice above further.",
  },
];

/**
 * Does this person pass the who-filter?
 *
 * The friendship answer comes from the presence service's live map through {@link TriggerContext},
 * which is in memory and free — see that file for why it cannot be a table read or an await. With
 * no context the filter is **open** rather than closed: a build that cannot tell who is a friend
 * should fire for everybody, not silently for nobody.
 */
function passesWho(
  deps: TriggerDeps,
  config: NodeConfigValues,
  accountId: string | null,
  userId: string | null,
): boolean {
  const only = typeof config.only === "string" ? config.only.trim() : "";
  if (only !== "" && userId !== only) return false;

  const who = typeof config.who === "string" ? config.who : "anyone";
  if (who === "anyone" || deps.context === undefined) return true;
  // No id, no verdict. The log names some people without one, and refusing them under a *friends*
  // filter is right — but refusing them under *strangers* would be too, so the honest answer is to
  // treat an unidentifiable person as not passing either narrowing.
  if (userId === null) return false;

  const friend = deps.context.isFriend(accountId, userId);
  return who === "friends" ? friend : !friend;
}

/**
 * A function rather than a constant, because several presets now consult {@link TriggerContext} —
 * the friend check on the player triggers, the "where I was" port on the profile ones. The shape is
 * otherwise unchanged: a preset is still a subscription, a mapping, and typed outputs.
 */
function presets(deps: TriggerDeps): readonly Preset[] {
  return [
    {
      id: "on-friend-online",
      title: "When a friend comes online",
      description: "Fires when a friend's presence goes from offline to online.",
      kinds: ["friend.online"],
      outputs: [
        { id: "friend", label: "Friend", type: "friend" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event) => {
        const friend = text(event.subjectId);
        return friend === null ? null : { friend, at: event.ts, event: event.payload ?? null };
      },
    },
    {
      id: "on-friend-offline",
      title: "When a friend goes offline",
      description: "Fires when a friend's presence goes from online to offline.",
      kinds: ["friend.offline"],
      outputs: [
        { id: "friend", label: "Friend", type: "friend" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event) => {
        const friend = text(event.subjectId);
        return friend === null ? null : { friend, at: event.ts, event: event.payload ?? null };
      },
    },
    {
      id: "on-player-join",
      title: "When someone joins your instance",
      description: "From the game log, so it covers everyone in the room and not only friends.",
      kinds: ["gamelog.player_join"],
      outputs: [
        { id: "name", label: "Name", type: "string" },
        { id: "user", label: "User", type: "user" },
        { id: "location", label: "Instance", type: "instance" },
        {
          id: "isFriend",
          label: "Is a friend",
          type: "boolean",
          description: "From the friend list vrc.zip already holds. No request, and briefly stale.",
        },
        { id: "at", label: "At", type: "number" },
      ],
      config: WHO_FIELDS,
      // A busy public instance is the case this has to survive. The ceiling is the graph's, not the
      // instance's: forty joins in a burst is normal, four hundred a minute is a graph nobody wants.
      maxFiresPerMinute: 120,
      map: (event, config) => {
        const payload = payloadOf(event);
        const name = text(payload.displayName) ?? text(event.subjectId);
        if (name === null) return null;
        const user = text(event.subjectId);
        if (!passesWho(deps, config, event.accountId, user)) return null;
        // `user` may be absent: VRChat has shipped this log line with and without an id, which is
        // exactly why the name is the required half and the id is offered separately.
        return {
          name,
          ...(user === null ? {} : { user }),
          ...(text(event.location) === null ? {} : { location: event.location }),
          isFriend: user !== null && (deps.context?.isFriend(event.accountId, user) ?? false),
          at: event.ts,
        };
      },
    },
    {
      id: "on-player-leave",
      title: "When someone leaves your instance",
      description: "From the game log.",
      kinds: ["gamelog.player_leave"],
      outputs: [
        { id: "name", label: "Name", type: "string" },
        { id: "user", label: "User", type: "user" },
        { id: "isFriend", label: "Is a friend", type: "boolean" },
        { id: "at", label: "At", type: "number" },
      ],
      config: WHO_FIELDS,
      maxFiresPerMinute: 120,
      map: (event, config) => {
        const payload = payloadOf(event);
        const name = text(payload.displayName) ?? text(event.subjectId);
        if (name === null) return null;
        const user = text(event.subjectId);
        if (!passesWho(deps, config, event.accountId, user)) return null;
        return {
          name,
          ...(user === null ? {} : { user }),
          isFriend: user !== null && (deps.context?.isFriend(event.accountId, user) ?? false),
          at: event.ts,
        };
      },
    },
    {
      id: "on-notification",
      title: "When a notification arrives",
      description: "Friend requests, invites, invite requests — anything VRChat sends you.",
      kinds: ["notification.received", "notification.received_v2"],
      outputs: [
        { id: "type", label: "Type", type: "string" },
        { id: "from", label: "From", type: "user" },
        { id: "message", label: "Message", type: "string" },
        {
          id: "id",
          label: "Notification id",
          type: "string",
          description: "What Accept a notification and Decline a notification take.",
        },
        { id: "notification", label: "Notification", type: "json" },
      ],
      config: [
        {
          kind: "select",
          id: "type",
          label: "Only this type",
          options: [
            { value: "", label: "Anything" },
            { value: "friendRequest", label: "Friend request" },
            { value: "invite", label: "Invite" },
            { value: "requestInvite", label: "Invite request" },
            { value: "message", label: "Message" },
          ],
          default: "",
        },
      ],
      map: (event, config) => {
        const payload = payloadOf(event);
        const type = text(payload.type);
        if (type === null) return null;
        // Filtered here rather than in the subscription, because the kind is the same for all of them
        // — the type is a payload field, so the bus cannot narrow it and this is the only layer that
        // can. Notifications arrive at human speed, so the cost is nothing.
        const wanted = typeof config.type === "string" ? config.type.trim() : "";
        if (wanted !== "" && type !== wanted) return null;
        return {
          type,
          ...(text(payload.senderUserId) === null ? {} : { from: payload.senderUserId }),
          message: text(payload.message) ?? "",
          // The id is what the Me family's accept and decline nodes take, and it was missing: a graph
          // could see an invite arrive and had no way to hand it to the node that answers it.
          ...(text(payload.id) === null ? {} : { id: payload.id }),
          notification: event.payload ?? null,
        };
      },
    },
    {
      id: "on-world-enter",
      title: "When you enter a world",
      description: "From the game log, for the account whose client it was.",
      kinds: ["gamelog.world_enter", "gamelog.location_join"],
      outputs: [
        { id: "world", label: "World", type: "world" },
        { id: "location", label: "Instance", type: "instance" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event) => {
        const payload = payloadOf(event);
        const world = text(payload.worldId) ?? text(event.subjectId);
        if (world === null) return null;
        return {
          world,
          ...(text(event.location) === null ? {} : { location: event.location }),
          at: event.ts,
        };
      },
    },

    ...profilePresets(deps),
    ...selfPresets(),
    ...gameLogPresets(),
  ];
}

/* -------------------------------------------------------------------------------------------- */
/* Me: what VRChat says about your own account                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The eight aspects of your own profile, as eight triggers.
 *
 * ## Why eight nodes and not one with a picker
 *
 * "When my status changes" is a thing somebody searches the palette for. A single node called
 * "When my profile changes" with a multi-select is one entry that nobody finds by typing *status*,
 * and its ports would have to be the lowest common denominator of eight different fields.
 *
 * ## Why each one subscribes to two kinds
 *
 * The daemon refines `user-update` into `user.updated.status` and friends **only when exactly one
 * aspect moved** — a frame that changed three things keeps the generic `user.updated` kind, because
 * picking one of the three to be the headline would be arbitrary (see `wiring/pipeline-bridge.ts`).
 * So an exact-kind subscription silently misses every multi-aspect frame, which is the common case
 * when somebody edits their profile properly. Each node therefore watches both and, on the generic
 * kind, checks whether its own aspect is named in the payload's `changes` list. Fires exactly once
 * either way: the two kinds are mutually exclusive for any one frame.
 *
 * ## The value port is typed from the payload, not from the change record
 *
 * `FieldChange` carries *rendered* strings — a trust rank arrives as a tag list and leaves as
 * `"trusted"`. But the payload is the whole user object beside it, so `currentAvatar` is a real
 * avatar id and the avatar node can offer an `avatar` port that flows into `Look up an avatar`.
 * Where the field genuinely is a string, the port is a string, which is honest rather than clever.
 */
interface ProfileAspect {
  readonly aspect: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The port carrying the new value, and the payload field it reads. */
  readonly port: {
    readonly id: string;
    readonly label: string;
    readonly type: "string" | "avatar";
  };
  readonly field: string;
}

const PROFILE_ASPECTS: readonly ProfileAspect[] = [
  {
    aspect: "status",
    id: "on-my-status-change",
    title: "When my status changes",
    description: "The dot: join me, online, ask me, do not disturb, invisible.",
    port: { id: "status", label: "Status", type: "string" },
    field: "status",
  },
  {
    aspect: "status_message",
    id: "on-my-status-message-change",
    title: "When my status message changes",
    description: "The free-text line under your status.",
    port: { id: "message", label: "Message", type: "string" },
    field: "statusDescription",
  },
  {
    aspect: "avatar",
    id: "on-my-avatar-change",
    title: "When my avatar changes",
    description: "Fires whenever you put on a different avatar, however you switched.",
    port: { id: "avatar", label: "Avatar", type: "avatar" },
    field: "currentAvatar",
  },
  {
    aspect: "icon",
    id: "on-my-icon-change",
    title: "When my profile picture changes",
    description: "The picture shown for you, which VRC+ lets you set apart from the avatar.",
    port: { id: "icon", label: "Picture", type: "string" },
    field: "userIcon",
  },
  {
    aspect: "bio",
    id: "on-my-bio-change",
    title: "When my bio changes",
    description: "The text on your profile.",
    port: { id: "bio", label: "Bio", type: "string" },
    field: "bio",
  },
  {
    aspect: "name",
    id: "on-my-name-change",
    title: "When my display name changes",
    description: "Rare, and worth knowing about when it is not you who did it.",
    port: { id: "name", label: "Name", type: "string" },
    field: "displayName",
  },
  {
    aspect: "trust",
    id: "on-my-trust-change",
    title: "When my trust rank changes",
    description: "Visitor, new, user, known, trusted.",
    port: { id: "trust", label: "Trust", type: "string" },
    field: "",
  },
  {
    aspect: "platform",
    id: "on-my-platform-change",
    title: "When my platform changes",
    description: "Which device VRChat last saw you on.",
    port: { id: "platform", label: "Platform", type: "string" },
    field: "last_platform",
  },
];

/** The `changes` list a refined update event carries, as aspect names. */
function changedAspects(payload: Record<string, unknown>): string[] {
  const changes = payload.changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .map((entry) =>
      typeof entry === "object" && entry !== null && "aspect" in entry
        ? (entry as { aspect: unknown }).aspect
        : null,
    )
    .filter((aspect): aspect is string => typeof aspect === "string");
}

/** One aspect's before and after out of the `changes` list, or nulls when it is not named. */
function changeFor(
  payload: Record<string, unknown>,
  aspect: string,
): { from: string | null; to: string | null } {
  const changes = payload.changes;
  if (!Array.isArray(changes)) return { from: null, to: null };
  for (const entry of changes) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { aspect?: unknown; from?: unknown; to?: unknown };
    if (record.aspect !== aspect) continue;
    return {
      from: typeof record.from === "string" ? record.from : null,
      to: typeof record.to === "string" ? record.to : null,
    };
  }
  return { from: null, to: null };
}

function profilePresets(deps: TriggerDeps): Preset[] {
  return PROFILE_ASPECTS.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    kinds: [`user.updated.${entry.aspect}`, "user.updated"],
    outputs: [
      { id: entry.port.id, label: entry.port.label, type: entry.port.type },
      {
        id: "from",
        label: "Was",
        type: "string",
        description: "Empty when vrc.zip had no previous value, which is not the same as blank.",
      },
      { id: "to", label: "Now", type: "string" },
      {
        id: "where",
        label: "Where I was",
        type: "instance",
        description: "From the running client's log. Unset when no client is open.",
      },
      { id: "at", label: "At", type: "number" },
      { id: "event", label: "Event", type: "json" },
    ],
    map: (event: BusEvent): PortValues | null => {
      const payload = payloadOf(event);
      // The generic kind reaches here too. Fire only when this node's own aspect is one of the
      // things that moved; the exact kind is self-evidently about this aspect and needs no check.
      if (event.kind === "user.updated" && !changedAspects(payload).includes(entry.aspect)) {
        return null;
      }
      const change = changeFor(payload, entry.aspect);
      const value = entry.field === "" ? null : text(payload[entry.field]);
      const where = deps.context?.location(event.accountId) ?? "";
      return {
        // The typed port carries the payload's own field where there is one. Trust has none — it is
        // computed from a tag list — so it falls back to the rendered `to`, which is the rank name.
        ...(value === null
          ? change.to === null
            ? {}
            : { [entry.port.id]: change.to }
          : { [entry.port.id]: value }),
        from: change.from ?? "",
        to: change.to ?? value ?? "",
        ...(where === "" || where === "offline" ? {} : { where }),
        at: event.ts,
        event: event.payload ?? null,
      };
    },
  }));
}

/**
 * The rest of what VRChat says about your own account: entitlements, groups, queues, sign-ins.
 *
 * These are all pipeline events the daemon already publishes and nothing offered a typed way into.
 * Reaching them meant `When VRChat pushes an event` and a `Read field` per port, which works and
 * teaches nobody anything.
 */
function selfPresets(): Preset[] {
  return [
    /* --- where I am ------------------------------------------------------------------------- */
    {
      id: "on-my-location-change",
      title: "When I go somewhere",
      description: "Fires when you arrive in an instance.",
      kinds: ["gamelog.location_join", "user.location"],
      outputs: [
        { id: "location", label: "Instance", type: "instance" },
        { id: "world", label: "World", type: "world" },
        { id: "source", label: "Source", type: "string", description: "log or vrchat." },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      config: [
        {
          /*
           * The two sources genuinely disagree and neither is wrong.
           *
           * The log is what the client on *this machine* is doing: it is immediate, it works for an
           * account vrc.zip does not manage, and it says nothing about a client running elsewhere.
           * VRChat's own `user.location` is what it was last told: it arrives wherever the client
           * is, and it lags. Defaulting to the log matches every other "where am I" answer in this
           * project; the picker is there because the other answer is the right one on a second PC.
           */
          kind: "select",
          id: "source",
          label: "According to",
          options: [
            { value: "log", label: "The game on this computer" },
            { value: "vrchat", label: "VRChat" },
            { value: "both", label: "Either, whichever says so first" },
          ],
          default: "log",
        },
      ],
      map: (event, config): PortValues | null => {
        const want = typeof config.source === "string" ? config.source : "log";
        const fromLog = event.kind === "gamelog.location_join";
        if (want === "log" && !fromLog) return null;
        if (want === "vrchat" && fromLog) return null;

        const payload = payloadOf(event);
        const location =
          text(event.location) ??
          text(payload.location) ??
          text((payload.location as Record<string, unknown> | undefined)?.raw);
        if (location === null || location === "offline") return null;
        const world = text(payload.worldId) ?? text(event.subjectId) ?? worldOf(location);
        return {
          location,
          ...(world === null ? {} : { world }),
          source: fromLog ? "log" : "vrchat",
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },

    /* --- entitlements ----------------------------------------------------------------------- */
    {
      id: "on-my-vrc-plus-change",
      title: "When my VRC+ changes",
      description: "Fires when a subscription starts or lapses.",
      kinds: ["economy.update.vrchat_plus"],
      outputs: [
        { id: "active", label: "Active", type: "boolean" },
        { id: "from", label: "Was", type: "string" },
        { id: "to", label: "Now", type: "string" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues => {
        const change = changeFor(payloadOf(event), "vrchat_plus");
        // The refined event renders a boolean as its digits or words, so "is it on now" is read off
        // the string rather than assumed from the direction of travel.
        const active = change.to === "true" || change.to === "1" || change.to === "yes";
        return {
          active,
          from: change.from ?? "",
          to: change.to ?? "",
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },
    {
      id: "on-my-balance-change",
      title: "When my balance changes",
      description: "Your VRChat credit balance moved. The noisiest thing VRChat says about you.",
      kinds: ["economy.update.wallet_balance"],
      outputs: [
        { id: "balance", label: "Balance", type: "number" },
        { id: "was", label: "Was", type: "number" },
        { id: "delta", label: "Changed by", type: "number" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      // Lower than the default on purpose: this is the one event that can tick repeatedly while
      // nothing interesting is happening, and a graph that posts each one is a graph nobody wants.
      maxFiresPerMinute: 30,
      map: (event): PortValues => {
        const change = changeFor(payloadOf(event), "wallet_balance");
        const balance = digits(change.to) ?? 0;
        // `from` null means vrc.zip held no previous value, which is **not** a balance of zero —
        // and `Number(null)` is 0, so a plain coercion here reported the whole balance as a gain
        // the first time it ever saw one. The distinction is the one `FieldChange` documents.
        const was = digits(change.from);
        return {
          balance,
          ...(was === null ? {} : { was, delta: balance - was }),
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },

    /* --- my accounts ------------------------------------------------------------------------ */
    {
      id: "on-account-signed-in",
      title: "When an account signs in",
      description: "One of your accounts finished signing in and is live.",
      kinds: ["account.ready"],
      outputs: [
        { id: "account", label: "Account", type: "string" },
        { id: "name", label: "Name", type: "string" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues | null => {
        const payload = payloadOf(event);
        const account = text(payload.id) ?? text(event.accountId);
        if (account === null) return null;
        return {
          account,
          name: text(payload.displayName) ?? text(payload.username) ?? "",
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },
    {
      id: "on-account-problem",
      title: "When an account has a problem",
      description:
        "It dropped, hit a two-factor challenge, or errored. The one worth a phone push.",
      kinds: ["account.state"],
      outputs: [
        { id: "account", label: "Account", type: "string" },
        { id: "name", label: "Name", type: "string" },
        { id: "state", label: "State", type: "string" },
        { id: "error", label: "Error", type: "string" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues | null => {
        const payload = payloadOf(event);
        const state = text(payload.state);
        // `account.state` fires on every transition including the good ones. This node is the bad
        // half; `on-account-signed-in` is the good half, and between them nothing is missed.
        if (state === null || state === "online" || state === "connecting") return null;
        const account = text(payload.id) ?? text(event.accountId);
        if (account === null) return null;
        return {
          account,
          name: text(payload.displayName) ?? text(payload.username) ?? "",
          state,
          error: text(payload.lastError) ?? "",
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },

    /* --- groups ----------------------------------------------------------------------------- */
    {
      id: "on-i-joined-a-group",
      title: "When I join a group",
      description:
        "Fires when a group membership becomes yours, including one you were approved for.",
      kinds: ["group.joined"],
      outputs: [
        { id: "group", label: "Group", type: "group" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues | null => groupOutputs(event),
    },
    {
      id: "on-i-left-a-group",
      title: "When I leave a group",
      description: "Fires when you leave a group, or are removed from one.",
      kinds: ["group.left"],
      outputs: [
        { id: "group", label: "Group", type: "group" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues | null => groupOutputs(event),
    },
    {
      id: "on-my-group-membership-change",
      title: "When my group membership changes",
      description: "Something about your membership moved: visibility, notifications, a ban.",
      kinds: ["group.member_updated"],
      outputs: [
        { id: "group", label: "Group", type: "group" },
        { id: "member", label: "Membership", type: "json" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues | null => {
        const member = payloadOf(event).member;
        const record = typeof member === "object" && member !== null ? member : {};
        const group = text((record as Record<string, unknown>).groupId) ?? text(event.subjectId);
        return {
          ...(group === null ? {} : { group }),
          member: record as PortValues[string],
          at: event.ts,
        };
      },
    },
    {
      id: "on-my-group-role-change",
      title: "When my group role changes",
      description: "You were given a role in a group, or one was taken away.",
      kinds: ["group.role_updated"],
      outputs: [
        { id: "group", label: "Group", type: "group" },
        { id: "role", label: "Role", type: "string" },
        { id: "roleId", label: "Role id", type: "string" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues => {
        const role = payloadOf(event).role;
        const record = (typeof role === "object" && role !== null ? role : {}) as Record<
          string,
          unknown
        >;
        const group = text(record.groupId) ?? text(event.subjectId);
        return {
          ...(group === null ? {} : { group }),
          role: text(record.name) ?? "",
          ...(text(record.id) === null ? {} : { roleId: record.id }),
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },

    /* --- queues ----------------------------------------------------------------------------- */
    {
      id: "on-i-joined-a-queue",
      title: "When I join a queue",
      description: "You entered the queue for a full instance.",
      kinds: ["instance.queue_joined"],
      outputs: [
        { id: "location", label: "Instance", type: "instance" },
        { id: "position", label: "Position", type: "number" },
        { id: "size", label: "Queue size", type: "number" },
        { id: "wait", label: "Estimated wait", type: "number", description: "Seconds." },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues | null => {
        const payload = payloadOf(event);
        const location = text(payload.instanceLocation) ?? text(event.location);
        if (location === null) return null;
        return {
          location,
          ...(numberOf(payload.position) === null ? {} : { position: payload.position }),
          ...(numberOf(payload.queueSize) === null ? {} : { size: payload.queueSize }),
          ...(numberOf(payload.estimatedTotalWaitTime) === null
            ? {}
            : { wait: payload.estimatedTotalWaitTime }),
          at: event.ts,
        };
      },
    },
    {
      id: "on-my-queue-ready",
      title: "When my queue is ready",
      description: "You reached the front and can go in. The one you have seconds to act on.",
      kinds: ["instance.queue_ready"],
      outputs: [
        { id: "location", label: "Instance", type: "instance" },
        { id: "expires", label: "Expires", type: "string" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues | null => {
        const payload = payloadOf(event);
        const location = text(payload.instanceLocation) ?? text(event.location);
        if (location === null) return null;
        return {
          location,
          expires: text(payload.expiryTime) ?? "",
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },
  ];
}

/* -------------------------------------------------------------------------------------------- */
/* The game log, as named triggers                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * The log lines that had no preset, now that somebody has asked for them.
 *
 * `When the game log says something` still exists and still reaches every one of these. What these
 * buy is the same thing every preset buys: typed ports and a name you can find. "A portal appeared"
 * is a thing people build graphs about; `gamelog.portal_spawn` is a thing people look up.
 *
 * **A missing field is an unset port, never a filled-in guess.** VRChat writes these lines with and
 * without their details depending on version and circumstance, and an unproduced port kills only
 * the branch that needed it — so a graph wired through "a portal appeared" still runs on a line
 * that never said where the portal went.
 */
function gameLogPresets(): Preset[] {
  return [
    {
      id: "on-portal-spawn",
      title: "When a portal appears",
      description: "Somebody dropped a portal in your instance.",
      kinds: ["gamelog.portal_spawn"],
      outputs: [
        {
          id: "by",
          label: "Dropped by",
          type: "string",
          description: "A display name, when the line carries one.",
        },
        { id: "destination", label: "Goes to", type: "instance" },
        { id: "world", label: "To world", type: "world" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      maxFiresPerMinute: 60,
      map: (event): PortValues => {
        const payload = payloadOf(event);
        const destination = text(payload.destination) ?? text(payload.destinationLocation);
        const world = destination === null ? null : worldOf(destination);
        return {
          ...(text(payload.spawnerDisplayName) === null ? {} : { by: payload.spawnerDisplayName }),
          ...(destination === null ? {} : { destination }),
          ...(world === null ? {} : { world }),
          at: event.ts,
          event: event.payload ?? null,
        };
      },
    },
    {
      id: "on-destination-set",
      title: "When I pick somewhere to go",
      description: "The client resolved a destination, just before travelling there.",
      kinds: ["gamelog.destination_set"],
      outputs: [
        { id: "location", label: "Instance", type: "instance" },
        { id: "world", label: "World", type: "world" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues | null => {
        const location = text(event.location) ?? locationOfPayload(payloadOf(event));
        if (location === null) return null;
        const world = worldOf(location);
        return { location, ...(world === null ? {} : { world }), at: event.ts };
      },
    },
    {
      id: "on-left-room",
      title: "When I leave an instance",
      description: "Your client left the room it was in.",
      kinds: ["gamelog.left_room"],
      outputs: [{ id: "at", label: "At", type: "number" }],
      map: (event): PortValues => ({ at: event.ts }),
    },
    {
      id: "on-join-failed",
      title: "When I cannot get in",
      description: "A join was refused, with VRChat's reason. Full instance, banned, gone.",
      kinds: ["gamelog.join_failed"],
      outputs: [
        { id: "reason", label: "Reason", type: "string" },
        { id: "at", label: "At", type: "number" },
        { id: "event", label: "Event", type: "json" },
      ],
      map: (event): PortValues => ({
        reason: text(payloadOf(event).reason) ?? "",
        at: event.ts,
        event: event.payload ?? null,
      }),
    },
    {
      id: "on-screenshot",
      title: "When I take a screenshot",
      description: "With the file's path on disk, so a graph can move or post it.",
      kinds: ["gamelog.screenshot"],
      outputs: [
        { id: "path", label: "Path", type: "string" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues | null => {
        const path = text(payloadOf(event).path);
        return path === null ? null : { path, at: event.ts };
      },
    },
    {
      id: "on-game-start",
      title: "When the game starts",
      description: "A VRChat client opened on this computer. Fires before it knows who you are.",
      kinds: ["session.start"],
      outputs: [
        { id: "session", label: "Session", type: "number" },
        { id: "account", label: "Account", type: "string" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues => ({
        ...(event.sessionId === null || event.sessionId === undefined
          ? {}
          : { session: event.sessionId }),
        ...(text(event.accountId) === null ? {} : { account: event.accountId }),
        at: event.ts,
      }),
    },
    {
      id: "on-game-quit",
      title: "When the game quits",
      description: "The client shut down cleanly. A crash ends the session without this line.",
      kinds: ["gamelog.app_quit"],
      outputs: [{ id: "at", label: "At", type: "number" }],
      map: (event): PortValues => ({ at: event.ts }),
    },
    {
      id: "on-vr-mode-change",
      title: "When I switch between VR and desktop",
      description: "The client reported which way it is running.",
      kinds: ["gamelog.vr_mode"],
      outputs: [
        { id: "mode", label: "Mode", type: "string", description: "vr or desktop." },
        { id: "inVr", label: "In VR", type: "boolean" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues | null => {
        const mode = text(payloadOf(event).vrMode);
        return mode === null ? null : { mode, inVr: mode === "vr", at: event.ts };
      },
    },
    {
      id: "on-client-authenticated",
      title: "When a client signs in",
      description: "The log named the account a running client belongs to.",
      kinds: ["gamelog.authenticated"],
      outputs: [
        { id: "user", label: "User", type: "user" },
        { id: "name", label: "Name", type: "string" },
        { id: "at", label: "At", type: "number" },
      ],
      map: (event): PortValues | null => {
        const payload = payloadOf(event);
        const name = text(payload.displayName);
        if (name === null) return null;
        return {
          ...(text(payload.userId) === null ? {} : { user: payload.userId }),
          name,
          at: event.ts,
        };
      },
    },
  ];
}

/* -------------------------------------------------------------------------------------------- */
/* Small shared readers                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** The world half of `wrld_x:12345~region(eu)`, or null. Splits at the first colon, as ever. */
function worldOf(location: string): string | null {
  const colon = location.indexOf(":");
  if (colon <= 0) return null;
  const world = location.slice(0, colon);
  return world.startsWith("wrld_") ? world : null;
}

/** A parsed location out of a game-log payload, which nests it under `location`. */
function locationOfPayload(payload: Record<string, unknown>): string | null {
  const location = payload.location;
  if (typeof location === "string") return location === "" ? null : location;
  if (typeof location === "object" && location !== null) {
    return text((location as Record<string, unknown>).raw);
  }
  return null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A rendered number back out of a {@link FieldChange} string, or null.
 *
 * Null-safe on purpose and not a `Number()` call: `Number(null)` is `0` and `Number("")` is `0`,
 * so both of the ways "there is no value here" is spelled would come back as a real balance.
 */
function digits(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The two group triggers that carry nothing but a group id. */
function groupOutputs(event: BusEvent): PortValues | null {
  const group = text(payloadOf(event).groupId) ?? text(event.subjectId);
  return group === null ? null : { group, at: event.ts, event: event.payload ?? null };
}

function presetDefinition(preset: Preset): NodeDefinition {
  return {
    id: preset.id,
    kind: "trigger",
    title: preset.title,
    description: preset.description,
    category: "Triggers",
    outputs: preset.outputs,
    config: [ACCOUNT_FIELD, ...(preset.config ?? [])],
    ...(preset.maxFiresPerMinute === undefined
      ? {}
      : { maxFiresPerMinute: preset.maxFiresPerMinute }),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The game log                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * One trigger for the whole game log, with a picker.
 *
 * `on-player-join` and `on-world-enter` are presets over two of these kinds and stay, because their
 * *typed* outputs are what make a graph downstream check. This node is the other half: everything
 * the log can say, including the lines nobody has written a preset for — a portal dropped, a join
 * refused, a screenshot taken.
 *
 * Its outputs are deliberately plain. A `displayName` is a `string` here rather than a `user`,
 * because most game-log lines carry a name and only some carry an id, and a port that is sometimes
 * a real user id and sometimes empty is worse than one that says what it is.
 */
const ON_GAMELOG: NodeDefinition = {
  id: "on-gamelog",
  kind: "trigger",
  title: "When the game log says something",
  description: "Fires on one kind of line from a running VRChat client.",
  category: "Triggers",
  outputs: [
    { id: "kind", label: "Kind", type: "string" },
    { id: "name", label: "Who", type: "string", description: "Empty for lines about nobody." },
    { id: "user", label: "User", type: "user", description: "Only when the log named an id." },
    { id: "location", label: "Instance", type: "instance" },
    { id: "at", label: "At", type: "number" },
    { id: "event", label: "Everything", type: "json" },
  ],
  config: [
    {
      kind: "select",
      id: "kind",
      label: "Line",
      options: [
        { value: "gamelog.*", label: "anything in the log" },
        ...BUS_EVENT_KINDS.filter((kind) => kind.startsWith("gamelog.")).map((kind) => ({
          value: kind,
          label: kind.slice("gamelog.".length).replaceAll("_", " "),
        })),
      ],
      default: "gamelog.*",
    },
    ACCOUNT_FIELD,
  ],
  maxFiresPerMinute: 120,
};

function gamelogKinds(config: NodeConfigValues): readonly string[] {
  const chosen = typeof config.kind === "string" ? config.kind : "gamelog.*";
  return isEventPatternString(chosen) && chosen.startsWith("gamelog.") ? [chosen] : ["gamelog.*"];
}

function gamelogOutputs(event: BusEvent): PortValues {
  const payload = payloadOf(event);
  return {
    kind: event.kind,
    name: text(payload.displayName) ?? "",
    ...(text(event.subjectId) === null ? {} : { user: event.subjectId }),
    ...(text(event.location) === null ? {} : { location: event.location }),
    at: event.ts,
    event: event.payload ?? null,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The pipeline                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * VRChat's own event vocabulary, and the bus kind each one becomes.
 *
 * The pipeline is the WebSocket VRChat pushes friend presence, notifications and group changes down.
 * `wiring/pipeline-bridge.ts` normalises every frame onto the bus, so a graph could already react to
 * all of this through `on-event` — but only by knowing vrc.zip's names for things. Somebody who has
 * read VRChat's documentation, or watched the socket, thinks in `friend-location` and
 * `notification-v2`, and this trigger lets them say that.
 *
 * **Kept here rather than imported from the bridge**, which would point `graphs/` at `wiring/` — the
 * dependency direction the whole layout exists to avoid. `triggers.test.ts` asserts this table
 * agrees with `busKindFor` exactly, so the copy cannot drift without a failing test.
 */
export const PIPELINE_EVENT_KINDS: Readonly<Record<string, string>> = {
  notification: "notification.received",
  "notification-v2": "notification.received_v2",
  "notification-v2-update": "notification.updated",
  "notification-v2-delete": "notification.deleted",
  "response-notification": "notification.responded",
  "see-notification": "notification.seen",
  "hide-notification": "notification.hidden",
  "clear-notification": "notification.cleared",
  "friend-add": "friend.added",
  "friend-delete": "friend.removed",
  "friend-online": "friend.online",
  "friend-active": "friend.active",
  "friend-offline": "friend.offline",
  "friend-update": "friend.updated",
  "friend-location": "friend.location",
  "user-update": "user.updated",
  "user-location": "user.location",
  "user-badge-assigned": "user.badge_assigned",
  "user-badge-unassigned": "user.badge_unassigned",
  "content-refresh": "content.refresh",
  "economy-update": "economy.update",
  "modified-image-update": "content.image_updated",
  "instance-queue-joined": "instance.queue_joined",
  "instance-queue-ready": "instance.queue_ready",
  "group-joined": "group.joined",
  "group-left": "group.left",
  "group-member-updated": "group.member_updated",
  "group-role-updated": "group.role_updated",
};

/** Shared by the picker node and the twenty-eight generated ones, so they cannot describe
 * different ports for the same frame. */
const PIPELINE_OUTPUTS: NodeDefinition["outputs"] = [
  { id: "type", label: "Type", type: "string", description: "VRChat's name for the frame." },
  { id: "kind", label: "Kind", type: "string", description: "vrc.zip's name for it." },
  { id: "subject", label: "About", type: "string", description: "The user, world or group." },
  { id: "user", label: "User", type: "user", description: "When the subject is a person." },
  { id: "at", label: "At", type: "number" },
  { id: "event", label: "Everything", type: "json" },
];

const ON_PIPELINE: NodeDefinition = {
  id: "on-pipeline",
  kind: "trigger",
  title: "When VRChat pushes an event",
  description: "Fires on one kind of frame from VRChat's live socket, by its own name for it.",
  category: "Triggers",
  outputs: PIPELINE_OUTPUTS,
  config: [
    {
      kind: "select",
      id: "type",
      label: "Frame",
      options: Object.keys(PIPELINE_EVENT_KINDS)
        .sort()
        .map((type) => ({ value: type, label: type })),
      default: "friend-online",
    },
    ACCOUNT_FIELD,
  ],
  // Same ceiling as the game-log trigger: `friend-location` fires for every friend who moves, and a
  // busy evening is hundreds of frames.
  maxFiresPerMinute: 120,
  body: [{ kind: "config", field: "type", fallback: "friend-online" }],
};

/**
 * The bus kinds one pipeline frame can arrive as.
 *
 * Two, not one, and the second is the reason this is a function. The bridge *refines* three of the
 * update frames — `friend-update` becomes `friend.updated.avatar` when it can tell what moved, and
 * plain `friend.updated` only when it cannot. Subscribing to the exact kind alone would miss every
 * frame the daemon understood well enough to describe, which is precisely the useful ones.
 */
function pipelineKinds(config: NodeConfigValues): readonly string[] {
  const chosen = typeof config.type === "string" ? config.type : "friend-online";
  const kind = PIPELINE_EVENT_KINDS[chosen];
  if (kind === undefined) return [];
  return [kind, `${kind}.*`];
}

function pipelineOutputs(event: BusEvent): PortValues {
  const type =
    Object.entries(PIPELINE_EVENT_KINDS).find(
      ([, kind]) => kind === event.kind || event.kind.startsWith(`${kind}.`),
    )?.[0] ?? "";
  const subject = text(event.subjectId);
  return {
    type,
    kind: event.kind,
    subject: subject ?? "",
    // A `user` port only when the subject really is a person. A world or group id in a `user` port
    // would flow straight into an invite node and produce a request about nobody.
    ...(subject?.startsWith("usr_") === true ? { user: subject } : {}),
    at: event.ts,
    event: event.payload ?? null,
  };
}

/**
 * One trigger per pipeline frame, generated from the table above.
 *
 * The same shape the VRChat API nodes take, and for the same reason: a picker is one more step
 * between "I want to react to `friend-location`" and a node on the canvas, and with a searchable
 * palette the node itself *is* the picker. Twenty-eight of them, in their own group.
 *
 * `on-pipeline` stays. It is the one to reach for when the frame is chosen by config rather than by
 * which node you dragged — and it is the only one that still works if VRChat ships a frame type
 * this build has never heard of, since its picker is data rather than a node per value.
 */
function pipelineEventNodes(deps: TriggerDeps): BuiltinNode[] {
  return Object.entries(PIPELINE_EVENT_KINDS).map(([type, kind]) => {
    const definition: NodeDefinition = {
      // The type is already lowercase and hyphenated, which is exactly what a node id must be.
      id: `on-pipeline-${type}`,
      kind: "trigger",
      // VRChat's own name, not a humanised one: somebody reaching for these is reading VRChat's
      // documentation or watching the socket, and translating would make them guess.
      title: `${type} (pipeline)`,
      description: `Fires when VRChat pushes a ${type} frame. Arrives as ${kind}.`,
      category: "Pipeline",
      outputs: PIPELINE_OUTPUTS,
      config: [ACCOUNT_FIELD],
      maxFiresPerMinute: 120,
      body: [{ kind: "literal", text: type }],
    };
    return busTrigger(deps, definition, () => [kind, `${kind}.*`], pipelineOutputs);
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Schedule and run-now                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** The floor on a schedule. A graph that wants to run every second wants an event, not a timer. */
export const MIN_SCHEDULE_MS = 60_000;

const ON_SCHEDULE: NodeDefinition = {
  id: "on-schedule",
  kind: "trigger",
  title: "Every so often",
  description: "Fires on a timer while vrc.zip is running.",
  category: "Triggers",
  outputs: [{ id: "at", label: "At", type: "number" }],
  config: [
    {
      kind: "number",
      id: "everyMs",
      label: "Every (ms)",
      min: MIN_SCHEDULE_MS,
      default: 3_600_000,
      required: true,
    },
  ],
  body: [
    { kind: "literal", text: "every " },
    { kind: "config", field: "everyMs" },
  ],
};

const RUN_NOW: NodeDefinition = {
  // The id the control API looks for; `RUN_NOW_TYPE` in `intrinsics.ts` is the qualified form.
  id: "run-now",
  kind: "trigger",
  title: "Run now",
  description: "Only fires when you press the button. The way to try a graph without waiting.",
  category: "Triggers",
  outputs: [{ id: "at", label: "At", type: "number" }],
};

function scheduleTrigger(deps: TriggerDeps): BuiltinNode {
  const now = deps.now ?? Date.now;
  return {
    definition: ON_SCHEDULE,
    arm: (request) => {
      const raw = request.config.everyMs;
      const every = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
      // Clamped rather than refused: a graph saved with 5 seconds should run every minute, not stop
      // working with an error the author only sees if they go looking for it.
      const period = Math.max(MIN_SCHEDULE_MS, every);
      const timer = setInterval(() => {
        request.fire({ at: now() });
      }, period);
      // A graph's timer must never be the reason the daemon refuses to exit.
      timer.unref?.();
      return () => {
        clearInterval(timer);
      };
    },
  };
}

/**
 * The manual trigger arms nothing.
 *
 * Its fires come from `POST /api/graphs/:id/run`, which calls the engine's own `fire` — the same
 * door a plugin trigger comes through, so a manual run is subject to every ceiling and every
 * concurrency mode rather than being a special path that bypasses them.
 */
function runNowTrigger(): BuiltinNode {
  return { definition: RUN_NOW, arm: () => undefined };
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function triggerNodes(deps: TriggerDeps): BuiltinNode[] {
  return [
    busTrigger(
      deps,
      ON_EVENT,
      (config) => {
        const typed = parsePatterns(config.kinds);
        if (typed.length > 0) return typed;
        return typeof config.kind === "string" && isEventPatternString(config.kind)
          ? [config.kind]
          : [];
      },
      baseOutputs,
    ),
    busTrigger(deps, ON_GAMELOG, (config) => gamelogKinds(config), gamelogOutputs),
    busTrigger(deps, ON_PIPELINE, (config) => pipelineKinds(config), pipelineOutputs),
    ...pipelineEventNodes(deps),
    ...presets(deps).map((preset) =>
      busTrigger(deps, presetDefinition(preset), () => preset.kinds, preset.map),
    ),
    scheduleTrigger(deps),
    runNowTrigger(),
  ];
}
