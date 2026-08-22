/**
 * Outbound webhooks — PLAN.md §"Control API — :7775", phase 2 step 2.10.
 *
 * The surface `app.ts` needs is small: construct a {@link WebhookManager} with the store, subscribe
 * `manager.onEvent` to the EventBus, mount `register` / `list` / `remove` behind the control API's
 * scope guard, and call `start()` / `stop()` with the rest of the daemon's lifecycle.
 *
 * Everything below that — the SSRF checks on a target URL, the HMAC scheme, the durable queue, the
 * backoff, the dead-letter, the auto-disable — is this module's business and nobody else's.
 */

export type { AttemptOptions, AttemptResult, BackoffOptions, FetchLike } from "./delivery.ts";
export { attemptDelivery, backoffDelay } from "./delivery.ts";
export type { WebhookFilter } from "./filter.ts";
export {
  matchesKind,
  normaliseKindPatterns,
  parseKindPatterns,
  WILDCARD,
  webhookMatches,
} from "./filter.ts";
export type {
  RegisteredWebhook,
  WebhookManagerOptions,
  WebhookRegistration,
} from "./manager.ts";
export { WebhookManager } from "./manager.ts";
export type { MintedWebhookSecret } from "./signature.ts";
export {
  mintWebhookSecret,
  signingPayload,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_HEADERS,
  WEBHOOK_SECRET_PREFIX,
  webhookKeyHash,
} from "./signature.ts";
export type { IpClass } from "./url.ts";
export { classifyHost, classifyIpLiteral, validateWebhookUrl, WebhookUrlError } from "./url.ts";
