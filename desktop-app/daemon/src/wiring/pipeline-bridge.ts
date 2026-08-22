import type { BusEventKind } from "@vrcz/shared";
import type { BusEvent, EventBus } from "../bus/event-bus.ts";
import type { DecodedPipelineEvent, PipelineEventType, PipelineUser } from "../pipeline/index.ts";
import type { UpdateDiffSet, UpdateVerdict } from "./update-diff.ts";

/**
 * Normalizes pipeline frames onto the EventBus.
 *
 * VRChat's wire names are kebab-case and flat (`friend-location`, `notification-v2-delete`); the
 * bus uses a dotted taxonomy (`friend.location`) so subscribers can filter on `friend.*` without
 * string surgery, and so log-derived and REST-derived events sit in the same namespace as pipeline
 * ones. The mapping is explicit rather than a `replace("-", ".")` — `notification-v2-delete` would
 * otherwise become `notification.v2-delete`, and nobody would notice until a filter silently
 * matched nothing.
 */

const KIND: Record<PipelineEventType, BusEventKind> = {
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

/** The bus kind for a pipeline event type. */
export function busKindFor(type: PipelineEventType): BusEventKind {
  return KIND[type];
}

interface MaybeSubject {
  userId?: unknown;
  userid?: unknown;
  user?: { id?: unknown };
  worldId?: unknown;
  groupId?: unknown;
  notificationId?: unknown;
  id?: unknown;
  location?: unknown;
}

/**
 * Pulls the id this event is *about* out of a payload.
 *
 * Note `userid` alongside `userId`: `friend-active` spells it with a lowercase `i`. That is a real
 * upstream typo, not ours, and reading only the correct spelling would silently drop the subject on
 * every friend-active event.
 */
function subjectOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const payload = data as MaybeSubject;

  for (const candidate of [
    payload.userId,
    payload.userid,
    payload.user?.id,
    payload.worldId,
    payload.groupId,
    payload.notificationId,
    payload.id,
  ]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

function locationOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const location = (data as MaybeSubject).location;
  return typeof location === "string" ? location : null;
}

/** The embedded user object, when the frame has one with a usable id. */
function userOf(data: unknown): PipelineUser | null {
  if (typeof data !== "object" || data === null) return null;
  const user = (data as { user?: unknown }).user;
  if (typeof user !== "object" || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? (user as PipelineUser) : null;
}

/**
 * Asks the right differ what an update frame changed.
 *
 * The three frame types here share one defect — they announce that something moved and carry a
 * whole object rather than the part that moved — and therefore one treatment. Everything else maps
 * straight through. `null` means "not a refinable frame", which is not the same as the verdict
 * `unchanged`, and conflating the two would drop every ordinary event.
 */
function refine(
  accountId: string,
  decoded: DecodedPipelineEvent,
  diffs: UpdateDiffSet,
): {
  readonly base: "friend.updated" | "user.updated" | "economy.update";
  readonly verdict: UpdateVerdict;
} | null {
  switch (decoded.type) {
    case "friend-update":
    case "user-update": {
      const user = userOf(decoded.data);
      if (user === null) return null;
      const base = decoded.type === "friend-update" ? "friend.updated" : "user.updated";
      return { base, verdict: diffs.profiles.observe(accountId, user.id, user) };
    }
    case "economy-update": {
      const data = decoded.data;
      if (typeof data !== "object" || data === null) return null;
      // Keyed on the account rather than on a subject: an economy frame is about the signed-in
      // account, and the `userId` it sometimes carries is that same account said twice.
      return {
        base: "economy.update",
        verdict: diffs.economy.observe(accountId, accountId, data),
      };
    }
    default:
      return null;
  }
}

/**
 * Converts one decoded pipeline event into a bus event, or `null` when it should not be emitted.
 *
 * `null` has exactly one cause: `diffs` was supplied, the frame was one of the update kinds, and
 * nothing this build tracks actually moved. Without `diffs` this behaves as it always did and never
 * returns `null`, which is what keeps the mapping testable on its own.
 */
export function toBusEvent(
  accountId: string,
  decoded: DecodedPipelineEvent,
  diffs?: UpdateDiffSet,
): BusEvent | null {
  const base: BusEvent = {
    kind: busKindFor(decoded.type),
    accountId,
    ts: decoded.receivedAt,
    subjectId: subjectOf(decoded.data),
    location: locationOf(decoded.data),
    payload: decoded.data,
  };

  if (diffs === undefined) return base;
  const refined = refine(accountId, decoded, diffs);
  if (refined === null) return base;

  if (refined.verdict.verdict === "unchanged") return null;
  // Nothing to compare against yet. The generic kind is the honest one: something changed, and
  // saying which would be inventing an answer.
  if (refined.verdict.verdict === "unknown") return base;

  const changes = refined.verdict.changes;
  const only = changes.length === 1 ? changes[0] : undefined;
  return {
    ...base,
    // One aspect names the kind. Several stay under the generic kind with the list in the payload,
    // because a frame that moved three things is not three events and picking one of them to be
    // the headline would be arbitrary.
    kind: only === undefined ? refined.base : (`${refined.base}.${only.aspect}` as BusEventKind),
    payload: { ...(decoded.data as object), changes },
  };
}

export function publishPipelineEvent(
  bus: EventBus,
  accountId: string,
  decoded: DecodedPipelineEvent,
  diffs?: UpdateDiffSet,
): void {
  const event = toBusEvent(accountId, decoded, diffs);
  if (event !== null) bus.emit(event);
}
