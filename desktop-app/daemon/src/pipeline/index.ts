/**
 * `daemon/src/pipeline` — the VRChat pipeline WebSocket client.
 *
 * Public surface: the typed event map (`events.ts`), the defensive frame decoder (`decode.ts`), and
 * the per-account socket (`client.ts`). The client takes every collaborator by injection, so nothing
 * here reaches into accounts, storage, or the HTTP layer.
 */

export {
  buildPipelineUrl,
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_STABLE_CONNECTION_MS,
  type PipelineBackoffOptions,
  PipelineClient,
  type PipelineClientOptions,
  type PipelineConnectionState,
  type PipelineStateChange,
  VRCHAT_PIPELINE_URL,
} from "./client.ts";
export {
  DEAD_SESSION_ERROR,
  type DecodedPipelineEvent,
  decodePipelineMessage,
  isReauthError,
  type PipelineDecodeResult,
  type PipelineMalformedMessage,
  type PipelineMalformedReason,
  type PipelineReauthRequired,
  type PipelineServerError,
  type PipelineUnknownEvent,
} from "./decode.ts";
export {
  isEmptyWorld,
  isPipelineEventType,
  type JsonObject,
  type JsonValue,
  PIPELINE_CONTENT_KIND,
  PIPELINE_EVENT_TYPES,
  type PipelineContentKind,
  type PipelineContentRefresh,
  type PipelineEconomyUpdate,
  type PipelineEventMap,
  type PipelineEventType,
  type PipelineFriendActive,
  type PipelineFriendIdPayload,
  type PipelineFriendLocation,
  type PipelineFriendOnline,
  type PipelineFriendUserPayload,
  type PipelineGroupMembership,
  type PipelineGroupMemberUpdated,
  type PipelineGroupRoleUpdated,
  type PipelineInstanceQueueJoined,
  type PipelineInstanceQueueReady,
  type PipelineLocation,
  type PipelineModifiedImageUpdate,
  type PipelineNotification,
  type PipelineNotificationIdPayload,
  type PipelineNotificationV2,
  type PipelineNotificationV2Delete,
  type PipelineNotificationV2Update,
  type PipelineResponseNotification,
  type PipelineUser,
  type PipelineUserBadgeAssigned,
  type PipelineUserBadgeUnassigned,
  type PipelineUserLocation,
  type PipelineWorld,
  type PipelineWorldId,
} from "./events.ts";
