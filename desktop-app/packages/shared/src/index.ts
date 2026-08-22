/**
 * `@vrcz/shared` — the single source of truth for anything the daemon, proxy, UI, and docs must
 * agree on: event types, the scope registry, and wire protocol types.
 *
 * Nothing here may import from `@vrcz/daemon`, `@vrcz/api`, or `@vrcz/ui`. This package is a leaf.
 */

export {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOSTNAME,
  DEFAULT_PROXY_PORT,
  DEFAULT_UI_PORT,
  launchUrl,
  SESSION_COOKIE,
  TOKEN_HEADER,
  TOKEN_QUERY_PARAM,
} from "./config.ts";
export {
  type AccountEventKind,
  BUS_EVENT_KINDS,
  type BusEventKind,
  type ConsentEventKind,
  type ContentEventKind,
  type EconomyEventKind,
  EVENT_FAMILIES,
  type EventFamily,
  type EventKind,
  type FriendEventKind,
  familyOf,
  type GamelogEventKind,
  type GroupEventKind,
  type InstanceEventKind,
  isBusEventKind,
  type KnownEventKind,
  type NotificationEventKind,
  type PipelineEventKind,
  type SessionEventKind,
  type UserEventKind,
} from "./events.ts";
export { isJsonObject, type JsonObject, type JsonValue } from "./json.ts";
export {
  ALL_SCOPES,
  DEFAULT_SCOPES,
  expandWildcard,
  isDangerousScope,
  isScope,
  SCOPES,
  type Scope,
  type ScopeDefinition,
} from "./scopes.ts";
export { APP_NAME, APP_VERSION, PLUGIN_API_PROTOCOL_MAJOR } from "./version.ts";
export {
  type AccountConnection,
  type ControlAccount,
  type DaemonStatus,
  type EventQuery,
  type FeedEvent,
  type FriendPresence,
  type FriendStatus,
  type GameSession,
  type LoginInput,
  type LoginResult,
  type RateLimitSnapshot,
  STREAM_READY,
  type StatusSnapshot,
  type StreamEnvelope,
  type StreamFrame,
  type TwoFactorMethod,
  type VerifyTwoFactorInput,
  type VerifyTwoFactorResult,
  type VrchatImageUrl,
} from "./wire.ts";
