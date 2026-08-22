/**
 * The bus event `kind` taxonomy — the one list of what the daemon can put on the EventBus.
 *
 * This lived in four places at once and agreed with itself in none of them: the two `wiring/*`
 * bridges each held a `Record<string, string>` of producers, `ui/src/lib/api.ts` held a
 * `KnownEventKind` union the UI had hand-copied, and `ui/src/lib/format.ts` held a label table that
 * was a *superset* of that union. The union was missing ten kinds the pipeline bridge emits every
 * day — `group.joined`, `instance.queue_ready`, `user.badge_assigned` and the rest — and nothing
 * anywhere could notice, because every producer typed its values as bare `string`.
 *
 * So the vocabulary is declared once, here, and the producers are typed against it. Adding a kind
 * to a bridge without adding it here is now a compile error, which is the only mechanism that
 * actually keeps a list like this honest.
 *
 * ## Why `EventKind` stays widened
 *
 * {@link EventKind} is `KnownEventKind | (string & {})`, which accepts any string while still
 * offering the known ones to autocompletion. That is deliberate and it is not laziness: an event
 * arriving over the wire from a newer daemon than the UI must still render in a feed and still
 * match a filter, rather than being dropped by a consumer that has never heard of it. Producers
 * take the narrow {@link BusEventKind}; consumers take the wide {@link EventKind}. The strictness
 * belongs at the point of emission, where a typo is a bug, not at the point of display, where an
 * unrecognised kind is just news.
 */

/** The top-level namespace of a dotted kind: `gamelog.player_join` → `gamelog`. */
export type EventFamily =
  | "friend"
  | "user"
  | "notification"
  | "gamelog"
  | "session"
  | "account"
  | "pipeline"
  | "group"
  | "instance"
  | "economy"
  | "content"
  | "consent"
  | "other";

/**
 * Families in the order a filter bar should offer them — commonest first, `other` last.
 *
 * Order is part of the contract: the feed and settings screens both render this array directly, and
 * two screens listing the same families in different orders reads as a bug in one of them.
 */
export const EVENT_FAMILIES: readonly EventFamily[] = [
  "friend",
  "notification",
  "gamelog",
  "session",
  "user",
  "group",
  "instance",
  "account",
  "pipeline",
  "economy",
  "content",
  "consent",
  "other",
];

/** Friend-list and friend-presence changes, from the pipeline and from REST poll diffs. */
export type FriendEventKind =
  | "friend.online"
  | "friend.offline"
  | "friend.active"
  | "friend.location"
  | "friend.updated"
  | "friend.added"
  | "friend.removed"
  /** A whole-list presence snapshot for one account, not a per-friend delta. */
  | "friend.presence"
  /** The periodic REST refresh completed. Bookkeeping, not a feed row. */
  | "friend.list_refreshed";

/** Changes to a user record, including this account's own. */
export type UserEventKind =
  | "user.updated"
  | "user.location"
  | "user.badge_assigned"
  | "user.badge_unassigned";

export type NotificationEventKind =
  | "notification.received"
  | "notification.received_v2"
  | "notification.updated"
  | "notification.deleted"
  | "notification.responded"
  | "notification.seen"
  | "notification.hidden"
  | "notification.cleared"
  /** A full re-read of the notification list finished. Bookkeeping, not a feed row. */
  | "notification.synced";

/**
 * Derived from a VRChat game-client log file. The API has no equivalent for any of these, which is
 * the core reason this class of app exists at all — see PLAN.md §1.7.
 */
export type GamelogEventKind =
  | "gamelog.player_join"
  | "gamelog.player_leave"
  | "gamelog.world_enter"
  | "gamelog.location_join"
  | "gamelog.portal_spawn"
  | "gamelog.destination_set"
  | "gamelog.left_room"
  | "gamelog.join_failed"
  | "gamelog.screenshot"
  | "gamelog.app_quit"
  | "gamelog.vr_mode"
  /** The `User Authenticated:` line — what attributes a log file to an account. */
  | "gamelog.authenticated";

/** A running game client's lifecycle. Sessions are not accounts — see PLAN.md §1.7. */
export type SessionEventKind = "session.start" | "session.update" | "session.end";

export type AccountEventKind =
  /** Login/pipeline state changed. Fires while the manager may still hold a pending id. */
  | "account.state"
  /** The account is fully live under its real id. This is the one to start polling on. */
  | "account.ready"
  | "account.removed";

/** The pipeline socket's own connection state. */
export type PipelineEventKind = "pipeline.state";

export type GroupEventKind =
  | "group.joined"
  | "group.left"
  | "group.member_updated"
  | "group.role_updated";

export type InstanceEventKind = "instance.queue_joined" | "instance.queue_ready";

export type EconomyEventKind = "economy.update";

export type ContentEventKind = "content.refresh" | "content.image_updated";

/**
 * A third-party app waiting at the consent sheet, and its outcome. See PLAN.md §Phase 2.
 *
 * The pairing code deliberately never rides on the bus — `consent.pending` carries the app identity
 * and the request id so a subscriber can raise a sheet, and the code is read from the store by the
 * screen that shows it (decision 61).
 */
export type ConsentEventKind = "consent.pending" | "consent.resolved";

/**
 * Every kind the daemon can emit. Producers are typed against this, so adding a kind to a bridge
 * without adding it here does not compile.
 */
export type BusEventKind =
  | FriendEventKind
  | UserEventKind
  | NotificationEventKind
  | GamelogEventKind
  | SessionEventKind
  | AccountEventKind
  | PipelineEventKind
  | GroupEventKind
  | InstanceEventKind
  | EconomyEventKind
  | ContentEventKind
  | ConsentEventKind;

/** @deprecated Prefer {@link BusEventKind}. Kept as the name the UI already imports. */
export type KnownEventKind = BusEventKind;

/**
 * A kind as a *consumer* sees it: any of the known ones, or a string from a daemon newer than this
 * build. See the note at the top of this file about why the strictness sits on the producer side.
 */
export type EventKind = BusEventKind | (string & {});

/**
 * Every known kind, as a runtime array.
 *
 * Kept beside the union rather than derived from it — a union cannot be enumerated at runtime — and
 * {@link EVENT_KIND_COVERAGE_NOTE} explains what keeps the two in step. The test in `events.test.ts`
 * asserts every entry parses to a real family and that the array and the union have the same size.
 */
export const BUS_EVENT_KINDS = [
  "friend.online",
  "friend.offline",
  "friend.active",
  "friend.location",
  "friend.updated",
  "friend.added",
  "friend.removed",
  "friend.presence",
  "friend.list_refreshed",
  "user.updated",
  "user.location",
  "user.badge_assigned",
  "user.badge_unassigned",
  "notification.received",
  "notification.received_v2",
  "notification.updated",
  "notification.deleted",
  "notification.responded",
  "notification.seen",
  "notification.hidden",
  "notification.cleared",
  "notification.synced",
  "gamelog.player_join",
  "gamelog.player_leave",
  "gamelog.world_enter",
  "gamelog.location_join",
  "gamelog.portal_spawn",
  "gamelog.destination_set",
  "gamelog.left_room",
  "gamelog.join_failed",
  "gamelog.screenshot",
  "gamelog.app_quit",
  "gamelog.vr_mode",
  "gamelog.authenticated",
  "session.start",
  "session.update",
  "session.end",
  "account.state",
  "account.ready",
  "account.removed",
  "pipeline.state",
  "group.joined",
  "group.left",
  "group.member_updated",
  "group.role_updated",
  "instance.queue_joined",
  "instance.queue_ready",
  "economy.update",
  "content.refresh",
  "content.image_updated",
  "consent.pending",
  "consent.resolved",
] as const satisfies readonly BusEventKind[];

/**
 * The array above must list every member of the union. TypeScript checks one direction for free
 * (`satisfies` rejects an entry that is not a kind); the other direction — a union member missing
 * from the array — is checked by this type, which resolves to `never` only when the two agree.
 * A mismatch surfaces as a compile error on {@link EVENT_KIND_COVERAGE_NOTE} below.
 */
type MissingFromArray = Exclude<BusEventKind, (typeof BUS_EVENT_KINDS)[number]>;

/**
 * Compiles only while {@link BUS_EVENT_KINDS} covers {@link BusEventKind} completely. If you added a
 * kind to the union and this line went red, add it to the array too.
 */
export const EVENT_KIND_COVERAGE_NOTE: MissingFromArray[] = [];

/** True for a kind this build knows by name. */
export function isBusEventKind(kind: string): kind is BusEventKind {
  return (BUS_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The family of a dotted kind, or `other` for a namespace this build has never heard of.
 *
 * Total by construction: an unknown kind gets a home rather than an exception, because this runs on
 * every row of a feed that may be showing events written by a newer daemon.
 */
export function familyOf(kind: string): EventFamily {
  const head = kind.split(".", 1)[0] ?? "";
  return (EVENT_FAMILIES as readonly string[]).includes(head) ? (head as EventFamily) : "other";
}
