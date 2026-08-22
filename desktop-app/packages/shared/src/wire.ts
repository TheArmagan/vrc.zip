/**
 * The control API's wire types — the shapes `:7775` puts on the wire and the UI reads back.
 *
 * These were maintained as two hand-copied sets, `daemon/src/servers/control.ts` and
 * `ui/src/lib/api.ts`, whose header openly said each shape "was read off" the other. They had
 * drifted in every way two copies can:
 *
 *  - the daemon typed its **deps**, not its **routes**, so several response bodies had no type at
 *    all on the daemon side. `POST /accounts/:id/verify-2fa` returns `{status, account}` and only
 *    the UI ever named that shape; the stream envelope was emitted through a double `as` cast.
 *  - `sessionId` on the stream was `string` in the UI and `number` on the bus, with a stringify on
 *    the way in and a `Number()` back out again — a round trip whose own comment admitted it was
 *    pointless.
 *  - `FeedEvent.payload` was `JsonValue` on one side and `unknown` on the other; `kind` and `status`
 *    were bare `string` on one side and a widened union on the other.
 *
 * So the wire is declared once, here, and both sides import it. The rule this file follows: **it
 * describes what crosses the socket, not what either side does with it.** Every field is `readonly`,
 * because nothing that arrived over a wire should be mutated in place by the code that received it.
 *
 * All timestamps are integer unix milliseconds. Never ISO strings — see PLAN.md §1.6.
 */

import type { EventKind } from "./events.ts";
import type { JsonValue } from "./json.ts";

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * How the daemon currently stands with an account.
 *
 * About credentials and the pipeline socket, never about a running game client — those are
 * {@link GameSession}s, a different set entirely. See PLAN.md §1.7.
 */
export type AccountConnection = "connected" | "connecting" | "disconnected" | "needs-2fa";

/** The 2FA challenges VRChat issues. `otp` is a one-time recovery code. */
export type TwoFactorMethod = "totp" | "emailOtp" | "otp";

/**
 * An absolute VRChat image URL, or null.
 *
 * **The UI must load it through `GET /api/image`, never directly** — `api.vrchat.cloud` image URLs
 * require the account's auth cookie and the mandatory User-Agent, neither of which a browser can
 * supply, so a bare `<img src>` gets a 403.
 */
export type VrchatImageUrl = string | null;

export interface ControlAccount {
  readonly id: string;
  readonly displayName: string;
  /** Unix milliseconds, integer. */
  readonly addedAt: number;
  readonly enabled: boolean;
  /** Unix milliseconds, integer, or null when never seen. */
  readonly lastSeenAt: number | null;
  readonly connection: AccountConnection;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly iconUrl: VrchatImageUrl;
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

export type LoginResult =
  | { readonly status: "ok"; readonly account: ControlAccount }
  | {
      readonly status: "requires-2fa";
      readonly accountId: string;
      readonly methods: readonly TwoFactorMethod[];
    };

export interface VerifyTwoFactorInput {
  readonly method: TwoFactorMethod;
  readonly code: string;
}

/**
 * The body of `POST /accounts/:id/verify-2fa`.
 *
 * Named here because it previously existed only in the UI: the daemon typed
 * `ControlDeps.verifyTwoFactor` as returning a bare `ControlAccount` and then wrapped it in this
 * envelope inside the route, so the shape that actually crossed the wire was written down on one
 * side only. That is the general failure this file exists to close.
 */
export interface VerifyTwoFactorResult {
  readonly status: "ok";
  readonly account: ControlAccount;
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

/**
 * VRChat's own status vocabulary, widened.
 *
 * Widened rather than closed because this is VRChat's field, not ours: they can add a value without
 * telling anyone, and a friend whose status this build does not recognise must still render in the
 * list rather than being dropped by an exhaustive switch.
 */
export type FriendStatus = "active" | "join me" | "ask me" | "busy" | "offline" | (string & {});

export interface FriendPresence {
  readonly id: string;
  readonly displayName: string;
  readonly status: FriendStatus;
  readonly statusDescription: string | null;
  readonly location: string | null;
  readonly worldId: string | null;
  readonly platform: string | null;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly iconUrl: VrchatImageUrl;
  /** Unix milliseconds, integer, or null when unknown. */
  readonly lastSeenAt: number | null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A live VRChat game-client session, reconstructed from the log watcher.
 *
 * Sessions and accounts are different sets, and no screen may imply otherwise. A client can run
 * without the daemon knowing which account it belongs to (`accountId: null` — "unlinked"), and an
 * account can be signed in with no client running at all. Six accounts and two sessions is a normal
 * state. See PLAN.md §1.7.
 */
export interface GameSession {
  /**
   * The **store's** row id, and the same identifier the stream's `sessionId` carries.
   *
   * One identifier across both surfaces on purpose: the log watcher generates its own internal
   * string ids, and a consumer handed one of each has no way to join them — it is reduced to
   * correlating on start time, which silently mis-attributes two clients started in the same
   * second.
   */
  readonly id: number;
  readonly accountId: string | null;
  readonly displayName: string | null;
  /** Unix milliseconds, integer. */
  readonly startedAt: number;
  /**
   * The VR mode string as the log wrote it, or null before it is known.
   *
   * Deliberately not the parser's `"vr" | "desktop"` union: this field crosses a version boundary,
   * and a client older than the daemon must not fail to render a value VRChat started writing last
   * week. Consumers ask `isVrMode()` rather than comparing to a literal.
   */
  readonly vrMode: string | null;
  readonly currentLocation: string | null;
  readonly currentWorldId: string | null;
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/** One row of the unified feed. `payload` is the bus event's payload, shape-per-kind. */
export interface FeedEvent {
  readonly id: number;
  /**
   * Null for events from a VRChat client signed into an account vrc.zip does not manage. A normal
   * state, not an error — see PLAN.md §1.7 on unlinked sessions.
   */
  readonly accountId: string | null;
  /** Unix milliseconds, integer. */
  readonly ts: number;
  /** The store's `sessions` row id. Set on `gamelog.*` rows; null elsewhere. */
  readonly sessionId: number | null;
  readonly kind: EventKind;
  readonly subjectId: string | null;
  readonly location: string | null;
  readonly payload: JsonValue;
}

/**
 * Query parameters for `GET /events`.
 *
 * Optionals are written `?: T | undefined` rather than `?: T` because `exactOptionalPropertyTypes`
 * is on: under it the two are **not** interchangeable, and a caller building a query object with a
 * conditionally-undefined field cannot assign to the narrower form.
 */
export interface EventQuery {
  readonly accountId?: string | undefined;
  readonly sessionId?: number | undefined;
  /** One user/world/group id — everything ever recorded about them, across every account. */
  readonly subjectId?: string | undefined;
  readonly kind?: string | undefined;
  /** Clamped by the route regardless of what is asked for. */
  readonly limit?: number | undefined;
  /** Unix milliseconds; return events strictly older than this. Feeds the infinite scroll. */
  readonly before?: number | undefined;
}

// ---------------------------------------------------------------------------
// The event stream (`GET /api/stream`)
// ---------------------------------------------------------------------------

/**
 * The envelope every non-`ready` frame carries in `payload`.
 *
 * This had **no type on the daemon side at all** — it was built inline and cast twice through
 * `as StreamEvent["payload"]`, so the only written-down description of the daemon's own wire format
 * lived in the UI. Both sides now build and read the same interface.
 */
export interface StreamEnvelope {
  readonly accountId: string | null;
  /**
   * The store's `sessions` row id, matching {@link GameSession.id}.
   *
   * A **number**, and it always was one on the bus. The UI used to type this `string`, stringify it
   * on arrival and `Number()` it back out one function later; the round trip existed only because
   * the two hand-copied declarations never agreed.
   */
  readonly sessionId: number | null;
  readonly subjectId: string | null;
  readonly location: string | null;
  /** The kind-specific body. Narrow it at the point of use; the wire promises only that it is JSON. */
  readonly data: JsonValue;
}

/** The literal first frame after a successful upgrade. There is no version handshake. */
export const STREAM_READY = "ready";

/**
 * One frame on the event socket.
 *
 * `type` is widened to `string` for the same reason {@link EventKind} is: a frame whose kind this
 * build has never heard of must still reach a subscriber rather than being dropped at the parser.
 */
export interface StreamFrame {
  readonly type: EventKind | typeof STREAM_READY;
  /** Unix milliseconds, integer. */
  readonly ts: number;
  /** Null on the `ready` frame, and only there. */
  readonly payload: StreamEnvelope | null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The limiter as the settings screen draws it.
 *
 * `remaining` and `queued` are **approximations** — the limiter does not expose live token counts —
 * and `limit` describes a single ceiling when there are in fact three (20/s per account, 100/s per
 * IP, 300/s per IP for files; see PLAN.md §1.4). Both are open questions in PROGRESS.md rather than
 * settled contract, and this comment is here so nobody builds a precise-looking gauge on top of them
 * without knowing that.
 */
export interface RateLimitSnapshot {
  /** Requests permitted per second across all accounts. */
  readonly limit: number;
  /** Tokens currently available. Approximate. */
  readonly remaining: number;
  /** Requests waiting on the limiter right now. Approximate. */
  readonly queued: number;
  /** Unix milliseconds at which a 429 backoff lifts, or null when not backing off. */
  readonly retryAfter: number | null;
}

/** Everything `GET /api/status` reports that the control module cannot work out for itself. */
export interface StatusSnapshot {
  /** True when the master key sits in a plain file rather than the OS keychain. */
  readonly degradedKeychain: boolean;
  /** Which keychain backend is in use, for the settings screen. */
  readonly backend: string;
  /** Number of configured accounts. */
  readonly accounts: number;
  readonly rateLimit: RateLimitSnapshot;
}

/**
 * The body of `GET /api/status`.
 *
 * {@link StatusSnapshot} plus the daemon version, which the route stamps on from `@vrcz/shared`
 * rather than the deps supplying it. Separate types because the split is real: one is what the
 * daemon's internals report, the other is what crosses the wire.
 */
export interface DaemonStatus extends StatusSnapshot {
  readonly version: string;
}
