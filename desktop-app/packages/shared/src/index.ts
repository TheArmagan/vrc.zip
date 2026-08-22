/**
 * `@vrcz/shared` — the single source of truth for anything the daemon, proxy, UI, and docs must
 * agree on: event types, the scope registry, and wire protocol types.
 *
 * Nothing here may import from `@vrcz/daemon`, `@vrcz/api`, or `@vrcz/ui`. This package is a leaf.
 */

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
