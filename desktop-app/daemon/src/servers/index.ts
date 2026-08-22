/**
 * The three HTTP servers. See PLAN.md §1.8.
 *
 * Barrel only — nothing here has behaviour of its own.
 */

export {
  APP_API_PREFIX,
  type AppApi,
  type AppApiDeps,
  type AppGrant,
  appWebSocketHandler,
  canSeeEvent,
  createAppApi,
  parseGrantScopes,
  visibleSessions,
} from "./app-api.ts";
export {
  type BindServerOptions,
  type BindServersOptions,
  type BoundServer,
  type BoundServers,
  bindServer,
  bindServers,
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOSTNAME,
  DEFAULT_PROXY_PORT,
  DEFAULT_UI_PORT,
  type FetchApp,
  launchUrl,
} from "./bind.ts";
export {
  type ControlAccount,
  type ControlApp,
  type ControlAppOptions,
  type ControlDeps,
  ControlError,
  type ControlErrorStatus,
  controlWebSocketHandler,
  createControlApp,
  type EventQuery,
  type FeedEvent,
  type FriendPresence,
  type GameSession,
  type LoginInput,
  type LoginResult,
  MAX_NOTE_LENGTH,
  parseUserId,
  type RateLimitSnapshot,
  type Settings,
  type SettingsPatch,
  type StatusSnapshot,
  type StreamEvent,
  type TwoFactorMethod,
  type UserDetail,
  type UserNote,
  type VerifyTwoFactorInput,
} from "./control.ts";
export { createProxyApp, type ProxyApp, type ProxyAppOptions } from "./proxy.ts";
export {
  createUiApp,
  defaultUiDistDir,
  SESSION_COOKIE,
  type UiApp,
  type UiAppOptions,
} from "./ui.ts";
