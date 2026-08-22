/**
 * The forward proxy on `:7776`. See `server.ts` for the design and PLAN.md §Phase 2.
 *
 * Barrel only — nothing here has behaviour of its own.
 */

export { loadOrCreateTlsMaterial, normaliseHosts, type TlsMaterial } from "./ca.ts";
export {
  DEFAULT_INTERCEPT_HOSTS,
  type ForwardProxy,
  type ForwardProxyOptions,
  startForwardProxy,
} from "./server.ts";
export { forwardProxyBanner } from "./welcome.ts";
