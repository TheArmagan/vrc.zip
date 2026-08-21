import type { BusEvent, EventBus } from "../bus/event-bus.ts";
import type { DecodedPipelineEvent, PipelineEventType } from "../pipeline/index.ts";

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

const KIND: Record<PipelineEventType, string> = {
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
export function busKindFor(type: PipelineEventType): string {
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

/** Converts one decoded pipeline event into a bus event. */
export function toBusEvent(accountId: string, decoded: DecodedPipelineEvent): BusEvent {
  return {
    kind: busKindFor(decoded.type),
    accountId,
    ts: decoded.receivedAt,
    subjectId: subjectOf(decoded.data),
    location: locationOf(decoded.data),
    payload: decoded.data,
  };
}

export function publishPipelineEvent(
  bus: EventBus,
  accountId: string,
  decoded: DecodedPipelineEvent,
): void {
  bus.emit(toBusEvent(accountId, decoded));
}
