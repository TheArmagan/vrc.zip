/**
 * The VRChat pipeline event map.
 *
 * These types describe **what the wire actually carries**, not what a sane API would carry. VRChat's
 * pipeline is undocumented and has accumulated quirks that are encoded here rather than normalised
 * away silently — a layer that hides them makes the next bug impossible to see. Each quirk is
 * commented at the field that carries it.
 *
 * Everything here is deliberately *permissive*: unmodelled fields arrive constantly (VRChat adds
 * them without notice) and every decoded event keeps the untouched parsed object alongside the typed
 * view, so nothing is lost. Fields never observed as absent are required; everything else is
 * optional. A payload that fails its shape check is reported as `malformed`, never thrown.
 */

import type { JsonObject, JsonValue } from "@vrcz/shared";

/**
 * A VRChat "location" string.
 *
 * Upstream quirk: this field is heavily overloaded. Observed values, all from live traffic:
 * - `""` — empty. Sent when the location is unknown or withheld and VRChat skips the sentinel.
 * - `"offline"` — the user is offline (or is hiding as offline).
 * - `"traveling"` — the user is between instances.
 * - `"traveling:traveling"` — the same state written in `worldId:instanceId` shape. Both forms
 *   occur; neither is a typo on our side.
 * - `"private"` — in an instance whose id is withheld from us.
 * - a real instance string, e.g. `"wrld_xxx:12345~region(use)"`.
 *
 * The `string & Record<never, never>` arm keeps the literals as editor completions while still
 * accepting any instance string. Never `switch` on this without a default arm.
 */
export type PipelineLocation =
  | ""
  | "offline"
  | "traveling"
  | "traveling:traveling"
  | "private"
  | (string & Record<never, never>);

/**
 * A world id, or the literal string `"private"`.
 *
 * Upstream quirk: when the world is hidden, `worldId` is not omitted and is not null — it is the
 * seven-character string `"private"`, sitting in a field that otherwise holds `wrld_…` ids. Code
 * that feeds this straight to a "fetch world by id" call 404s in production.
 */
export type PipelineWorldId = "private" | (string & Record<never, never>);

/**
 * A world object, or `{}`.
 *
 * Upstream quirk: `friend-online.world` is an **empty object** when the friend's status is ask-me or
 * DND (and occasionally for private instances). It is not `null` and the key is not absent, so
 * `if (world)` passes and `world.id` is `undefined`. Use {@link isEmptyWorld} before reading fields.
 */
export type PipelineWorld = JsonObject;

/** Narrows the `{}` form of {@link PipelineWorld} described above. */
export function isEmptyWorld(world: PipelineWorld | undefined): boolean {
  return world === undefined || Object.keys(world).length === 0;
}

/** A user object as embedded in pipeline payloads. Far more fields arrive than are modelled. */
export interface PipelineUser {
  readonly id: string;
  readonly displayName?: string;
  readonly userIcon?: string;
  readonly bio?: string;
  readonly profilePicOverride?: string;
  readonly currentAvatarImageUrl?: string;
  readonly currentAvatarThumbnailImageUrl?: string;
  readonly currentAvatarTags?: readonly string[];
  readonly status?: string;
  readonly statusDescription?: string;
  readonly tags?: readonly string[];
  readonly developerType?: string;
  readonly last_login?: string;
  readonly last_platform?: string;
  readonly allowAvatarCopying?: boolean;
  readonly isFriend?: boolean;
  readonly friendKey?: string;
  /** Present on some user payloads and subject to every quirk in {@link PipelineLocation}. */
  readonly location?: PipelineLocation;
}

/**
 * A v1 notification.
 *
 * Upstream quirk: `details` is a **JSON string nested inside the JSON payload** (and is often the
 * literal `"{}"`). It stays a string here; callers that need it parse it themselves so a malformed
 * `details` cannot invalidate an otherwise good notification.
 */
export interface PipelineNotification {
  readonly id: string;
  readonly type: string;
  readonly senderUserId?: string;
  readonly senderUsername?: string;
  readonly receiverUserId?: string;
  readonly message?: string;
  readonly details?: string;
  readonly created_at?: string;
  readonly seen?: boolean;
}

/** A v2 notification. Structurally unrelated to v1 despite the shared name. */
export interface PipelineNotificationV2 {
  readonly id: string;
  readonly version?: number;
  readonly type?: string;
  readonly category?: string;
  readonly title?: string;
  readonly message?: string;
  readonly senderUserId?: string;
  readonly receiverUserId?: string;
  readonly createdAt?: string;
  readonly isRead?: boolean;
  readonly data?: JsonValue;
}

/** Partial v2 notification patch. `updates` is a sparse object keyed by notification field. */
export interface PipelineNotificationV2Update {
  readonly id: string;
  readonly version?: number;
  readonly updates?: JsonObject;
}

/** Bulk v2 notification deletion. `ids` is plural even when a single id is deleted. */
export interface PipelineNotificationV2Delete {
  readonly ids: readonly string[];
  readonly version?: number;
}

/** Emitted when *we* answer a notification, so other sessions can drop it from their list. */
export interface PipelineResponseNotification {
  readonly notificationId: string;
  readonly receiverId?: string;
  readonly responseId?: string;
}

/** `friend-add`, `friend-update`, `user-update` — an id plus the full user object. */
export interface PipelineFriendUserPayload {
  readonly userId: string;
  readonly user: PipelineUser;
}

/** `friend-delete`, `friend-offline` — an id, and usually nothing else. */
export interface PipelineFriendIdPayload {
  readonly userId: string;
  readonly user?: PipelineUser;
  readonly platform?: string;
}

/**
 * `friend-active`.
 *
 * Upstream quirk: this event — and only this event — spells the field **`userid`**, lowercase `i`.
 * That is a real typo in VRChat's pipeline, not ours. It is not renamed here; the decoder mirrors
 * the wire and additionally fills {@link PipelineFriendActive.userId} so callers can stay uniform
 * without the wire type lying about what arrived.
 */
export interface PipelineFriendActive {
  /** The wire field, spelled exactly as VRChat sends it. Lowercase `i` is intentional. */
  readonly userid: string;
  /** Alias filled in by the decoder from `userid`. Never present on the wire. */
  readonly userId: string;
  readonly user?: PipelineUser;
  readonly platform?: string;
}

/** `friend-online` — the fullest of the presence events. */
export interface PipelineFriendOnline {
  readonly userId: string;
  readonly user?: PipelineUser;
  readonly platform?: string;
  readonly location?: PipelineLocation;
  readonly travelingToLocation?: PipelineLocation;
  readonly worldId?: PipelineWorldId;
  /** `{}` for ask-me/DND friends — see {@link PipelineWorld}. */
  readonly world?: PipelineWorld;
  readonly canRequestInvite?: boolean;
}

/** `friend-location` — sent on every instance change of every friend. The highest-volume event. */
export interface PipelineFriendLocation {
  readonly userId: string;
  readonly user?: PipelineUser;
  readonly platform?: string;
  readonly location?: PipelineLocation;
  readonly travelingToLocation?: PipelineLocation;
  /** Literally `"private"` when the instance is hidden — see {@link PipelineWorldId}. */
  readonly worldId?: PipelineWorldId;
  /** Absent or `{}` when the world is private. */
  readonly world?: PipelineWorld;
  readonly canRequestInvite?: boolean;
}

/** `user-location` — our own location, echoed to every session of this account. */
export interface PipelineUserLocation {
  readonly userId: string;
  readonly user?: PipelineUser;
  readonly location?: PipelineLocation;
  readonly travelingToLocation?: PipelineLocation;
  readonly instance?: string;
  readonly worldId?: PipelineWorldId;
  readonly world?: PipelineWorld;
}

/** `user-badge-assigned`. Carries the whole badge object. */
export interface PipelineUserBadgeAssigned {
  readonly badge: JsonObject;
}

/**
 * `user-badge-unassigned`.
 *
 * Upstream quirk: this is *not* the mirror of `user-badge-assigned`. It has been observed carrying
 * `badgeId` alone and, on other days, a full `badge` object. Both are optional here and the decoder
 * requires at least one.
 */
export interface PipelineUserBadgeUnassigned {
  readonly badgeId?: string;
  readonly badge?: JsonObject;
}

/** `content-refresh` — "content of this type changed, refetch it". Carries no content itself. */
export interface PipelineContentRefresh {
  readonly contentType?: string;
  readonly fileType?: string;
  readonly actionType?: string;
}

/** `economy-update` — VRChat+ / credit balance changes. Shape is unstable; kept fully open. */
export interface PipelineEconomyUpdate {
  readonly userId?: string;
  readonly balance?: number;
  readonly isVRChatPlus?: boolean;
}

/** `modified-image-update` — an image finished processing. Often carries only a bare file id. */
export interface PipelineModifiedImageUpdate {
  readonly fileId?: string;
  readonly imageUrl?: string;
  readonly ownerId?: string;
}

/** `instance-queue-joined` — we entered the queue for a full instance. */
export interface PipelineInstanceQueueJoined {
  readonly instanceLocation: string;
  readonly position?: number;
  readonly queueSize?: number;
  readonly estimatedTotalWaitTime?: number;
  readonly estimatedServeTime?: number;
}

/** `instance-queue-ready` — a slot opened. `expiryTime` is an ISO string, not a unix timestamp. */
export interface PipelineInstanceQueueReady {
  readonly instanceLocation: string;
  readonly expiryTime?: string;
}

/** `group-joined` / `group-left` — group id only. */
export interface PipelineGroupMembership {
  readonly groupId: string;
}

/** `group-member-updated` — our own membership row inside a group changed. */
export interface PipelineGroupMemberUpdated {
  readonly member: JsonObject;
}

/** `group-role-updated` — a role definition we hold changed. */
export interface PipelineGroupRoleUpdated {
  readonly role: JsonObject;
}

/** Normalised payload for the two events whose `content` is a bare id string. */
export interface PipelineNotificationIdPayload {
  readonly notificationId: string;
}

/**
 * The complete set of pipeline events, keyed by wire `type`.
 *
 * Three of these do not carry a JSON object at all, which is the entire reason `decode.ts` exists:
 * - `see-notification` / `hide-notification` carry a **bare notification id string** as `content`.
 * - `clear-notification` carries **no `content` key at all**.
 */
export interface PipelineEventMap {
  notification: PipelineNotification;
  "notification-v2": PipelineNotificationV2;
  "notification-v2-update": PipelineNotificationV2Update;
  "notification-v2-delete": PipelineNotificationV2Delete;
  "response-notification": PipelineResponseNotification;
  /** Bare id string on the wire; normalised to `{ notificationId }`. */
  "see-notification": PipelineNotificationIdPayload;
  /** Bare id string on the wire; normalised to `{ notificationId }`. */
  "hide-notification": PipelineNotificationIdPayload;
  /** No `content` key on the wire; normalised to `{}`. */
  "clear-notification": Record<string, never>;
  "friend-add": PipelineFriendUserPayload;
  "friend-delete": PipelineFriendIdPayload;
  "friend-online": PipelineFriendOnline;
  "friend-active": PipelineFriendActive;
  "friend-offline": PipelineFriendIdPayload;
  "friend-update": PipelineFriendUserPayload;
  "friend-location": PipelineFriendLocation;
  "user-update": PipelineFriendUserPayload;
  "user-location": PipelineUserLocation;
  "user-badge-assigned": PipelineUserBadgeAssigned;
  "user-badge-unassigned": PipelineUserBadgeUnassigned;
  "content-refresh": PipelineContentRefresh;
  "economy-update": PipelineEconomyUpdate;
  "modified-image-update": PipelineModifiedImageUpdate;
  "instance-queue-joined": PipelineInstanceQueueJoined;
  "instance-queue-ready": PipelineInstanceQueueReady;
  "group-joined": PipelineGroupMembership;
  "group-left": PipelineGroupMembership;
  "group-member-updated": PipelineGroupMemberUpdated;
  "group-role-updated": PipelineGroupRoleUpdated;
}

/** Every wire `type` we understand. */
export type PipelineEventType = keyof PipelineEventMap;

/**
 * How `content` arrives for a given event type. The decoder branches on this and nothing else, so
 * adding an event means adding one row here and one row to {@link PipelineEventMap}.
 */
export type PipelineContentKind =
  /** `content` is a JSON string encoding an object. The common case. */
  | "json-object"
  /** `content` is a bare, unquoted id string. `JSON.parse` on it throws. */
  | "bare-string"
  /** `content` is absent entirely. `JSON.parse(undefined)` throws. */
  | "absent";

/**
 * The per-type content contract.
 *
 * This table is the load-bearing part of the module. An unconditional `JSON.parse(content)` silently
 * swallows the three non-`json-object` rows below — the exact bug this design exists to prevent.
 */
export const PIPELINE_CONTENT_KIND: { readonly [K in PipelineEventType]: PipelineContentKind } = {
  notification: "json-object",
  "notification-v2": "json-object",
  "notification-v2-update": "json-object",
  "notification-v2-delete": "json-object",
  "response-notification": "json-object",
  "see-notification": "bare-string",
  "hide-notification": "bare-string",
  "clear-notification": "absent",
  "friend-add": "json-object",
  "friend-delete": "json-object",
  "friend-online": "json-object",
  "friend-active": "json-object",
  "friend-offline": "json-object",
  "friend-update": "json-object",
  "friend-location": "json-object",
  "user-update": "json-object",
  "user-location": "json-object",
  "user-badge-assigned": "json-object",
  "user-badge-unassigned": "json-object",
  "content-refresh": "json-object",
  "economy-update": "json-object",
  "modified-image-update": "json-object",
  "instance-queue-joined": "json-object",
  "instance-queue-ready": "json-object",
  "group-joined": "json-object",
  "group-left": "json-object",
  "group-member-updated": "json-object",
  "group-role-updated": "json-object",
};

/** Every event type as an array, in the order declared above. */
export const PIPELINE_EVENT_TYPES = Object.keys(
  PIPELINE_CONTENT_KIND,
) as readonly PipelineEventType[];

/** Type guard for a wire `type` we model. */
export function isPipelineEventType(value: string): value is PipelineEventType {
  return Object.hasOwn(PIPELINE_CONTENT_KIND, value);
}
