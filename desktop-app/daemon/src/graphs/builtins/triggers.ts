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

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import { BUS_EVENT_KINDS, EVENT_FAMILIES, isEventPatternString } from "@vrcz/shared";
import type { BusEvent, EventBus } from "../../bus/event-bus.ts";
import type { BuiltinArmRequest, BuiltinNode } from "./types.ts";

export interface TriggerDeps {
  readonly bus: EventBus;
  readonly now?: () => number;
}

/** The account filter every trigger carries, and the one config field they all share. */
const ACCOUNT_FIELD = {
  kind: "text",
  id: "accountId",
  label: "Only this account",
  description: "Leave blank for every managed account.",
} as const;

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
  map: (event: BusEvent) => PortValues | null,
): BuiltinNode {
  return {
    definition,
    arm: (request: BuiltinArmRequest) => {
      const patterns = kinds(request.config);
      if (patterns.length === 0) return;
      const subscription = deps.bus.subscribe(
        (event) => {
          const outputs = map(event);
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
  readonly map: (event: BusEvent) => PortValues | null;
  readonly maxFiresPerMinute?: number;
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

const PRESETS: readonly Preset[] = [
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
      { id: "at", label: "At", type: "number" },
    ],
    // A busy public instance is the case this has to survive. The ceiling is the graph's, not the
    // instance's: forty joins in a burst is normal, four hundred a minute is a graph nobody wants.
    maxFiresPerMinute: 120,
    map: (event) => {
      const payload = payloadOf(event);
      const name = text(payload.displayName) ?? text(event.subjectId);
      if (name === null) return null;
      // `user` may be absent: VRChat has shipped this log line with and without an id, which is
      // exactly why the name is the required half and the id is offered separately.
      return {
        name,
        ...(text(event.subjectId) === null ? {} : { user: event.subjectId }),
        ...(text(event.location) === null ? {} : { location: event.location }),
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
      { id: "at", label: "At", type: "number" },
    ],
    maxFiresPerMinute: 120,
    map: (event) => {
      const payload = payloadOf(event);
      const name = text(payload.displayName) ?? text(event.subjectId);
      if (name === null) return null;
      return {
        name,
        ...(text(event.subjectId) === null ? {} : { user: event.subjectId }),
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
      { id: "notification", label: "Notification", type: "json" },
    ],
    map: (event) => {
      const payload = payloadOf(event);
      const type = text(payload.type);
      if (type === null) return null;
      return {
        type,
        ...(text(payload.senderUserId) === null ? {} : { from: payload.senderUserId }),
        message: text(payload.message) ?? "",
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
];

function presetDefinition(preset: Preset): NodeDefinition {
  return {
    id: preset.id,
    kind: "trigger",
    title: preset.title,
    description: preset.description,
    category: "Triggers",
    outputs: preset.outputs,
    config: [ACCOUNT_FIELD],
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
    ...PRESETS.map((preset) =>
      busTrigger(deps, presetDefinition(preset), () => preset.kinds, preset.map),
    ),
    scheduleTrigger(deps),
    runNowTrigger(),
  ];
}
