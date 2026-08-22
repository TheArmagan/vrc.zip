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
  /**
   * What this account is spending, per second, over the last minute.
   *
   * On the card because "which account is eating the budget" is a question the user asks when six
   * accounts share one IP ceiling — see PLAN.md §1.4, where the per-IP bucket is the load-bearing
   * one precisely because per-account limiting is structurally unable to see it.
   */
  readonly rate: RateSeries;
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
// Groups — the sub-resources a group screen is built out of
// ---------------------------------------------------------------------------

/*
 * `GroupSummary` and `GroupDetail` still live in `daemon/src/servers/control.ts`; only the
 * sub-resources are declared here, because they are what the group screen was added for and there
 * was no reason to write them down twice on the way in. The one exception is
 * {@link GroupGallerySummary}, which `GroupDetail` carries — the *list* of galleries comes off the
 * group object itself, and only the images inside one need a request.
 *
 * Every list below is a projection, not a passthrough. VRChat's `GroupMember`, `GroupPost`,
 * `GroupInstance` and `GroupGalleryImage` carry moderation fields (manager notes, ban timestamps,
 * approval state, role-permission lists) that no reader of a group screen has any business seeing,
 * and forwarding them because they happened to be in the body is how a control API grows a surface
 * nobody decided on.
 */

/**
 * One gallery on a group's page.
 *
 * Comes free with `GET /groups/{groupId}` — `Group.galleries` is part of the group body — so the
 * gallery list costs no request and only the images inside one do.
 */
export interface GroupGallerySummary {
  readonly id: string;
  /** Falls back to the id, so a tab always has a label. */
  readonly name: string;
  readonly description: string | null;
  /** VRChat's own flag. A non-member fetching this gallery's images gets a 403. */
  readonly membersOnly: boolean;
}

/**
 * One row of a group's member list.
 *
 * `id` and `userId` are **different identifiers and both are needed**: `id` is the membership row,
 * which is what a moderation action names, and `userId` is the person, which is what the user modal
 * opens on. VRChat gives the membership row the shorter name, so mixing them up is easy and silent.
 */
export interface GroupMemberSummary {
  /** The **membership** id, not the user's. Unique per (group, user); safe to key a list on. */
  readonly id: string;
  readonly userId: string;
  /** Falls back to `userId` when VRChat sent no embedded user, so a row always has a label. */
  readonly displayName: string;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly iconUrl: VrchatImageUrl;
  /** Unix milliseconds, integer, or null. VRChat sends an ISO string; the wire stays integer ms. */
  readonly joinedAt: number | null;
  /** The group roles this member holds, as ids. Names live on the group's own `roles`. */
  readonly roleIds: readonly string[];
  /** They are wearing this group above their name tag in-game. VRChat's flag, passed through. */
  readonly isRepresenting: boolean;
}

/**
 * One page of `GET /api/groups/:id/members`.
 *
 * `hasMore` is "the page came back full", the same contract as `MutualFriendPage` and for the same
 * reason: VRChat sends no total on any of these endpoints, so a full page is the only evidence
 * another exists. It can be true for the last exactly-full page — an infinite scroll asking once
 * more and getting nothing is the right cost, where claiming the list ended early is not.
 */
export interface GroupMemberPage {
  readonly members: readonly GroupMemberSummary[];
  readonly hasMore: boolean;
}

/** One announcement on a group's board. */
export interface GroupPostSummary {
  readonly id: string;
  readonly title: string | null;
  /** The post body, author-written, newlines and all. */
  readonly text: string | null;
  readonly authorId: string | null;
  /**
   * The author's name, or null — **best-effort, and null is the common case.**
   *
   * VRChat's `GroupPost` carries `authorId` and no name at all, so this is filled from what the
   * daemon already holds locally (presence, then the friend log) and costs no request. Group staff
   * are usually strangers to the reader, so the UI must have an id fallback rather than treating a
   * null here as a broken post.
   */
  readonly authorDisplayName: string | null;
  /** Unix milliseconds, integer, or null. */
  readonly createdAt: number | null;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly imageUrl: VrchatImageUrl;
}

/** One page of `GET /api/groups/:id/posts`. `hasMore` as in {@link GroupMemberPage}. */
export interface GroupPostPage {
  readonly posts: readonly GroupPostSummary[];
  readonly hasMore: boolean;
}

/**
 * How vrc.zip came to know an instance of a world exists.
 *
 * This is on the wire rather than inferred in the UI because it is the honest caveat on the whole
 * list, and a caveat the reader cannot see is one that is not being made. See {@link WorldInstanceList}.
 */
export type WorldInstanceSource =
  /** A friend of one of your accounts is standing in it. */
  | "friend"
  /** One of your own VRChat clients is standing in it, per the game log. */
  | "client"
  /**
   * VRChat itself listed it on the world record, through at least one signed-in account.
   *
   * `World.instances` is documented "always an empty list when unauthenticated", and what it holds
   * depends on **who asked** — a friends-only instance appears for an account that may enter it and
   * not for one that may not. That is why the daemon reads the world once per signed-in account
   * rather than once, and why {@link WorldInstanceSummary.seenByAccountIds} is on the wire.
   */
  | "vrchat";

/** One person vrc.zip can see in an instance. Deduplicated by id across accounts. */
export interface WorldInstanceOccupant {
  readonly id: string;
  readonly displayName: string;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly iconUrl: VrchatImageUrl;
  readonly status: string;
}

/** One instance of a world that vrc.zip can currently see, and how it can see it. */
export interface WorldInstanceSummary {
  /** The location string, which is also the row's key. Unique within the list by construction. */
  readonly id: string;
  readonly location: string;
  /** The instance id with its tags, or null for a location with no instance part. */
  readonly instanceId: string | null;
  readonly worldId: string;
  /** Never empty. Both entries when a friend and one of your clients are in the same room. */
  readonly sources: readonly WorldInstanceSource[];
  readonly friends: readonly WorldInstanceOccupant[];
  /** `sessions.id` for each of your clients standing here. Empty for an instance you are not in. */
  readonly clientSessionIds: readonly number[];
  /**
   * VRChat's own head count for this instance, when a world record carried one.
   *
   * Null for an instance only presence or the game log revealed — and null is the honest answer
   * there, because `friends.length` is a floor rather than a count. A public room with forty
   * strangers and one friend in it would otherwise read as holding one person.
   */
  readonly userCount: number | null;
  /**
   * Which signed-in accounts VRChat listed this instance for.
   *
   * Empty when nothing but presence or the game log revealed it. A short list where others are
   * longer is the interesting case: it means the instance is visible to some of your accounts and
   * not others, which is a fact about access rather than about the room.
   */
  readonly seenByAccountIds: readonly string[];
}

/**
 * The answer to `GET /api/worlds/:id/instances`.
 *
 * **This is not a public listing, and VRChat has no endpoint that would make one.** There is no
 * "instances of this world" call upstream — only `GET /instances/{worldId}:{instanceId}`, which
 * needs an instance id you already hold. So the list is assembled from three sources, none of which
 * is complete on its own:
 *
 *  - **the world record**, once per signed-in account. `World.instances` is populated only for an
 *    authenticated caller and differs by *which* caller, so one account's answer is one account's
 *    view. This is the only source that carries a head count.
 *  - **friends' locations**, from the in-memory presence cache. Reveals rooms the world record did
 *    not list for any of your accounts, and is the only source that says who is in one.
 *  - **your own running clients**, from the game log. The only source that can reveal a room you
 *    are standing in alone.
 *
 * The consequence has to be stated wherever this renders: a busy public instance that no account
 * was shown and nobody you know is in does not appear, and its absence is not a claim that it does
 * not exist. That is the rule the rest of the app follows about absence, applied to a list.
 */
export interface WorldInstanceList {
  readonly instances: readonly WorldInstanceSummary[];
  /**
   * How many signed-in accounts were asked. Zero means nothing could be seen through VRChat at all,
   * and whatever is in the list came from presence or the game log.
   */
  readonly accountsConsulted: number;
  /**
   * Accounts that were asked and could not answer, by id.
   *
   * A partial answer is the normal outcome with several accounts — one may be rate-limited or its
   * cookie stale — and it must not fail the whole list, because the other accounts' answers are
   * exactly what makes a multi-account list worth having. Naming them lets the UI say the view is
   * incomplete rather than quietly presenting it as whole.
   */
  readonly failedAccountIds: readonly string[];
}

/**
 * One instance a group currently has open.
 *
 * The world is **flattened onto this row** rather than nested as a world summary. VRChat embeds a
 * whole `World` here, so the fields are free, but the shape that would hold them (`WorldSummary`)
 * lives in the daemon's control module and `@vrcz/shared` is a leaf — and declaring a second
 * structurally-identical world type in here to avoid that is precisely the duplication the header
 * of this file exists to argue against. Four named fields are not a type.
 */
export interface GroupInstanceSummary {
  /** The instance id *with* its tags, as VRChat quotes it. */
  readonly instanceId: string;
  /** `wrld_…:12345~group(grp_…)` — the full location, ready for a join or an instance lookup. */
  readonly location: string;
  /** How many group members are in it. Null when VRChat did not say. */
  readonly memberCount: number | null;
  readonly worldId: string | null;
  /** Falls back to `worldId`, then null — never an empty label. */
  readonly worldName: string | null;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly worldThumbnailImageUrl: VrchatImageUrl;
  readonly worldCapacity: number | null;
}

/**
 * The answer to `GET /api/groups/:id/instances`.
 *
 * **Not paged, because VRChat does not page it** — `GET /groups/{groupId}/instances` takes no `n`
 * or `offset` at all. An `n` invented here would be a local slice wearing the clothes of a request,
 * and a `hasMore` on top of it would be a claim nothing upstream can support.
 */
export interface GroupInstanceList {
  readonly instances: readonly GroupInstanceSummary[];
}

/** One image in a group gallery. */
export interface GroupGalleryImageSummary {
  readonly id: string;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly imageUrl: VrchatImageUrl;
  readonly submittedByUserId: string | null;
  /** Unix milliseconds, integer, or null. */
  readonly createdAt: number | null;
}

/**
 * One page of `GET /api/groups/:id/galleries/:galleryId/images`. `hasMore` as in
 * {@link GroupMemberPage}.
 */
export interface GroupGalleryImagePage {
  readonly images: readonly GroupGalleryImageSummary[];
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

/**
 * The answer to `GET /api/avatars/by-file/:fileId`.
 *
 * `avatarId` null is the ordinary answer, not a failure: the lookup is switchable
 * (`Settings.resolveAvatarIds`), the index it consults does not know every avatar, and a feed row
 * that cannot be opened is a normal feed row. The `fileId` is echoed so a batch of these can be
 * matched up without the caller tracking request order.
 */
export interface AvatarFileResolution {
  readonly fileId: string;
  /** `avtr_…`, or null when no avatar is known for this file. */
  readonly avatarId: string | null;
}

/**
 * One avatar record, as `GET /api/avatars/:id` serves it.
 *
 * Explicitly named fields, never VRChat's body passed through — the same rule the world and user
 * shapes follow. The avatar body is the largest record VRChat serves (`unityPackages` alone is
 * dozens of entries carrying asset URLs and platform builds), and none of it belongs on a card.
 *
 * The image fields are absolute VRChat URLs: see {@link VrchatImageUrl} — a browser cannot load one
 * directly.
 */
export interface AvatarDetail {
  readonly id: string;
  /** Falls back to the id, so a label is never empty. */
  readonly name: string;
  readonly description: string | null;
  readonly authorId: string | null;
  readonly authorName: string | null;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly imageUrl: VrchatImageUrl;
  /** See {@link VrchatImageUrl} — not loadable directly by a browser. */
  readonly thumbnailImageUrl: VrchatImageUrl;
  /** VRChat's own word: `public`, `private`, `hidden`. Null when it did not say. */
  readonly releaseStatus: string | null;
  readonly tags: readonly string[];
  readonly version: number | null;
  /** Unix milliseconds, integer, or null. */
  readonly createdAt: number | null;
  /** Unix milliseconds, integer, or null. */
  readonly updatedAt: number | null;
  /** Unix milliseconds the VRChat body was fetched. */
  readonly fetchedAt: number;
  /** True when this came from `avatar_cache` rather than a live fetch. */
  readonly cached: boolean;
  /**
   * Which signed-in account could actually see this avatar, or null.
   *
   * VRChat serves an avatar record only to accounts allowed to see it, so a 404 is a statement
   * about the asker rather than about the avatar: an avatar private to its author is invisible to
   * every other account, including your other ones. The daemon therefore asks each signed-in
   * account in turn and names the one that answered, which is the difference between "this avatar
   * is gone" and "your other account can see this one".
   *
   * Null on a row cached by a build that did not record it. Absence is "not known", never "nobody".
   */
  readonly seenByAccountId: string | null;
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
  /**
   * Several exact kinds at once — what a filter with checkboxes actually needs. `kind` stays for
   * the single-kind callers that already exist; when both are given, both narrow.
   */
  readonly kinds?: readonly string[] | undefined;
  /**
   * Dotted families (`gamelog`), matched as a `kind` **prefix**.
   *
   * Not the same thing as listing that family's known kinds: a kind from a daemon newer than the
   * caller still belongs to its family, and a filter built from a hardcoded list would silently
   * drop it. Family filtering used to happen in the UI over the loaded page, which meant a family
   * tab showed only whatever that family had contributed to the newest N rows.
   */
  readonly families?: readonly string[] | undefined;
  /**
   * Case-insensitive substring over the kind, subject, location and raw payload.
   *
   * Server-side because a search that only sees the loaded page is not a search — it answers
   * "is this in the last 150 rows", which is a question nobody asked.
   */
  readonly search?: string | undefined;
  /** Clamped by the route regardless of what is asked for. */
  readonly limit?: number | undefined;
  /** Unix milliseconds; return events strictly older than this. Feeds the infinite scroll. */
  readonly before?: number | undefined;
}

/**
 * One entry of `GET /api/event-kinds`: a kind in the store and how many rows it has.
 *
 * The vocabulary a filter list is built from. Counting the fetched page instead — which is what
 * the feed's family tabs used to do — offers a filter only while that kind happens to be in the
 * newest rows, and withdraws it as those rows age out.
 */
export interface EventKindCount {
  readonly kind: string;
  readonly count: number;
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
  /**
   * The display name of the game client this event came from, when it came from one.
   *
   * Null for anything not derived from a log, and null for a session whose identity line has not
   * been read yet. It is carried rather than left to be looked up because sessions are the unit for
   * everything log-derived (PLAN.md §"Control API"): a third-party app following two concurrent
   * clients needs to say *which* one without holding a session table of its own, and re-deriving it
   * from `accountId` is exactly wrong for the case this exists to serve — a client signed into an
   * account vrc.zip does not manage has a display name and no account id at all.
   */
  readonly displayName: string | null;
  readonly subjectId: string | null;
  readonly location: string | null;
  /** The kind-specific body. Narrow it at the point of use; the wire promises only that it is JSON. */
  readonly data: JsonValue;
}

/** The literal first frame after a successful upgrade. There is no version handshake. */
export const STREAM_READY = "ready";

/** A once-a-second reading of what the daemon is spending. See {@link RateFrame}. */
export const STREAM_RATE = "rate";

/**
 * How many one-second buckets a rate history carries. One minute.
 *
 * Here rather than in the daemon's meter because both sides have to agree on it: the daemon fills
 * the array and the UI right-aligns the seed into a buffer of exactly this length, and a mismatch
 * would silently shift every sparkline rather than fail.
 *
 * A minute rather than ten: at this size the chart is a few dozen pixels wide, so a longer window
 * buys history nobody can resolve while making every recent second narrower. Sixty buckets also
 * means the sparkline never has to downsample at all — one column per second, nothing averaged.
 */
export const RATE_WINDOW_SECONDS = 60;

/**
 * One series' worth of request rate, as a card draws it.
 *
 * `history` is the seed: a minute of one-second buckets, oldest first, fetched once with the
 * card. The live frame that follows carries **only the newest value**, which the UI appends. Sending
 * the whole window every second would be two kilobytes per series per second to say one number
 * changed, and the client already has the rest of it.
 */
export interface RateSeries {
  /** Requests in the last **complete** second. The second in progress reads low, so it is excluded. */
  readonly current: number;
  /** Oldest to newest, one entry per second, `windowSeconds` long. */
  readonly history: readonly number[];
  /** The highest single second in the window. What a sparkline scales to. */
  readonly peak: number;
  /** Every request in the window. */
  readonly total: number;
}

/**
 * The `rate` frame, once a second while anyone is watching.
 *
 * Per-account and per-grant maps carry only keys that moved, so an idle daemon sends
 * `{total: 0, accounts: {}, grants: {}}` rather than a row of zeroes per account. A key's absence
 * means zero, which is the same thing and much smaller.
 */
export interface RateFrame {
  /** Requests in the last complete second, across every account. */
  readonly total: number;
  /** Per account, non-zero only. */
  readonly accounts: Readonly<Record<string, number>>;
  /** Per grant, non-zero only. */
  readonly grants: Readonly<Record<string, number>>;
  /** The IP-wide API ceiling the daemon holds itself to, so the UI can draw load against capacity. */
  readonly limit: number;
  /**
   * Calls blocked on the limiter at this instant.
   *
   * On the frame rather than only in `/api/status` because it is the number that explains a stall
   * while it is happening: a daemon spending 3/s against an 80/s ceiling looks idle, and "and
   * forty calls are waiting" is the difference between a quiet app and a jammed one.
   */
  readonly queued: number;
  /** Unix ms at which a 429 backoff lifts, or null when not backing off. */
  readonly retryAfter: number | null;
}

/**
 * One frame on the event socket.
 *
 * `type` is widened to `string` for the same reason {@link EventKind} is: a frame whose kind this
 * build has never heard of must still reach a subscriber rather than being dropped at the parser.
 */
export type StreamFrame =
  | {
      readonly type: EventKind;
      /** Unix milliseconds, integer. */
      readonly ts: number;
      readonly payload: StreamEnvelope;
    }
  | { readonly type: typeof STREAM_READY; readonly ts: number; readonly payload: null }
  /**
   * The rate reading. Its own member rather than a bus kind, because it is not an *event* — nothing
   * happened, this is a sample. Putting it in `EventKind` would have put it in the feed, the
   * retention config, and the webhook payloads, none of which want a heartbeat.
   */
  | { readonly type: typeof STREAM_RATE; readonly ts: number; readonly payload: RateFrame };

/** A frame carrying a bus event, as opposed to the `ready` handshake or a `rate` sample. */
export type StreamEventFrame = Extract<StreamFrame, { payload: StreamEnvelope }>;

/**
 * Narrows a frame to the event-carrying kind.
 *
 * Exported rather than re-derived per consumer because the union has three members and only one of
 * them has an envelope — every screen that reads `payload.accountId` needs this exact check, and
 * writing it once is what stops the fourth member (whenever there is one) from being handled in
 * three subtly different ways.
 */
export function isEventFrame(frame: StreamFrame): frame is StreamEventFrame {
  return frame.type !== STREAM_READY && frame.type !== STREAM_RATE;
}

/** Narrows a frame to a `rate` sample. */
export function isRateFrame(
  frame: StreamFrame,
): frame is Extract<StreamFrame, { payload: RateFrame }> {
  return frame.type === STREAM_RATE;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * One rate ceiling, as it stands right now.
 *
 * There is no `limit` here and no single number anywhere in {@link RateLimitSnapshot}, because
 * there was never one ceiling: VRChat enforces 20 req/s per account, 100 req/s per IP, and 300
 * req/s per IP for files, and vrc.zip runs each at 80% (PLAN.md §1.4). The old snapshot reported
 * the IP-wide API rate as "the" limit and made up `remaining` and `queued` — a gauge that looked
 * precise and was not. All four numbers below are read off the limiter's actual buckets.
 */
export interface RateCeilingSnapshot {
  /** Sustained requests per second this bucket refills at. A constant off the configuration. */
  readonly rate: number;
  /** Bucket capacity — the size of a burst this ceiling will absorb before it starts pacing. */
  readonly burst: number;
  /** Whole tokens available at the moment the snapshot was taken. Measured, not estimated. */
  readonly available: number;
  /** Calls blocked on this ceiling right now. Measured by the limiter, not inferred. */
  readonly queued: number;
}

/** A per-account ceiling, named. One per account that has spent anything or is waiting. */
export interface AccountRateCeiling extends RateCeilingSnapshot {
  readonly accountId: string;
}

/**
 * The limiter as the settings screen and the shell draw it.
 *
 * Three ceilings, each with its own reading, plus the shared breaker. The breaker is shared and the
 * ceilings are not: a 429 on either tier stops both, which is why `retryAfter` sits at the top
 * level rather than on a ceiling.
 */
export interface RateLimitSnapshot {
  /** The IP-wide API ceiling. Every account's traffic draws from this one as well as its own. */
  readonly api: RateCeilingSnapshot;
  /** The IP-wide file ceiling — images, icons, and everything else on the `/file/` tier. */
  readonly files: RateCeilingSnapshot;
  /**
   * Per-account API ceilings.
   *
   * Empty until an account has made its first API call, which is correct rather than a gap: a
   * bucket that has never been drawn from is at capacity by definition, and {@link perAccountRate}
   * is enough to render one.
   */
  readonly accounts: readonly AccountRateCeiling[];
  /** The per-account sustained rate every account gets. Shown for accounts not yet in `accounts`. */
  readonly perAccountRate: number;
  /** Calls blocked anywhere in the limiter right now. Not the sum of the ceilings' `queued`. */
  readonly queued: number;
  /** Unix milliseconds at which a 429 backoff lifts, or null when not backing off. */
  readonly retryAfter: number | null;
  /** Consecutive 429s behind the current backoff. Zero once anything succeeds. */
  readonly consecutive429: number;
  /**
   * What the daemon is actually spending, against those ceilings.
   *
   * The shell used to render a ceiling as though it were a live reading, which it never was. This
   * is the measured half, and it is what makes the numbers beside it mean something.
   */
  readonly used: RateSeries;
  /** How many seconds of history `used` carries. */
  readonly windowSeconds: number;
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

// ---------------------------------------------------------------------------
// The proxy audit log
// ---------------------------------------------------------------------------

/**
 * What the proxy did with one call, in the store's own vocabulary.
 *
 * Widened to `string` for the same reason {@link EventKind} is: a daemon newer than this bundle may
 * record an outcome this build has never heard of, and a row that cannot be labelled must still
 * list rather than vanish out of the very log that exists to show it.
 */
export type AuditOutcome =
  | "allowed"
  | "denied_scope"
  | "hard_denied"
  | "denied_revoked"
  | "rate_limited"
  | "blocked_egress"
  | (string & {});

/**
 * One mutating call an app made through the mirror, as `GET /apps/:id/audit` returns it.
 *
 * **Reads are deliberately not recorded** — see migration 003 — so this is a log of what an app
 * *changed*, not of what it looked at. That is what makes it short enough to read: an app polling
 * friends every ten seconds contributes nothing here, and the one time it accepted an invite does.
 *
 * `grantId` is null for a call that was refused before a grant could be attributed, which is why a
 * row can exist that no app on the Connected apps page owns.
 */
export interface AppAuditEntry {
  readonly id: number;
  /** Unix milliseconds, integer. */
  readonly ts: number;
  readonly grantId: string | null;
  readonly accountId: string | null;
  /** Off the app's `User-Agent`, and a claim rather than a verified identity — as everywhere. */
  readonly appName: string;
  readonly method: string;
  readonly path: string;
  /** The route table's name for the operation, when one resolved. Null on a path with no route. */
  readonly operationId: string | null;
  /** The scope the call was checked against, or null when it never got that far. */
  readonly scope: string | null;
  readonly outcome: AuditOutcome;
  /** The status the caller was given, or null when the call was refused before one was chosen. */
  readonly status: number | null;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * The reserved rule key holding the window every unconfigured kind inherits.
 *
 * It lives here rather than only in the daemon because the UI has to keep it *out* of the per-kind
 * list it renders — a `'*'` row shown beside `gamelog.player-join` reads as an event kind called
 * "everything", which is the one reading that would make someone set it to a day.
 */
export const RETENTION_DEFAULT_KEY = "*";

/**
 * The floor and ceiling on any retention window, in days.
 *
 * The floor is 1 rather than 0 because "keep nothing" is not a retention policy, it is turning the
 * feed off, and a screen that can do that by accident is a screen that eats someone's history on a
 * mis-drag. The ceiling is ten years: past that the number stops meaning anything and the honest
 * answer is that nobody has run this daemon that long.
 */
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

/** Where the window applied to a kind actually came from. Rendered so a number is never a mystery. */
export type RetentionSource = "exact" | "prefix" | "default" | "fallback";

/** One stored rule: an exact kind (`gamelog.player-join`) or a family prefix (`gamelog.*`). */
export interface RetentionRule {
  readonly kind: string;
  readonly retainDays: number;
}

/**
 * One event kind as the Settings screen draws it: what is stored, what the rules resolve to, and
 * what the next pass would delete.
 *
 * `expiring` is the whole reason this is a dry run rather than a form — a window is an abstraction
 * until it is "4,182 rows go away", and that is the number someone needs before they commit.
 */
export interface RetentionKindStat {
  readonly kind: string;
  readonly retainDays: number;
  readonly source: RetentionSource;
  /** Rows of this kind stored right now. */
  readonly rows: number;
  /** Rows the next pass would roll up and delete. */
  readonly expiring: number;
}

/** The body of `GET /api/retention`, and of a `PUT` that applied or previewed one. */
export interface RetentionSettings {
  /** The window every kind inherits when no exact or prefix rule matches. */
  readonly defaultRetainDays: number;
  /** Stored rules other than the default, kind-ascending. */
  readonly rules: readonly RetentionRule[];
  /** Every kind currently in the store, resolved against the rules. Kind-ascending. */
  readonly kinds: readonly RetentionKindStat[];
  /** Rows the next pass would delete across every kind. */
  readonly totalExpiring: number;
  /** Unix ms of the last completed pass, or null if none has run on this install. */
  readonly lastRunAt: number | null;
  /** Unix ms the next scheduled pass is aimed at. */
  readonly nextRunAt: number | null;
  /** The database file's size on disk, so a window has a cost attached to it. */
  readonly dbSizeBytes: number;
  /**
   * True when this body describes a proposal rather than what is stored.
   *
   * A preview and a saved state are the same shape on purpose: the screen renders one component
   * either way, and the only difference is which one it is showing.
   */
  readonly preview: boolean;
}

/**
 * The body of `PUT /api/retention`.
 *
 * `rules` is a **patch, not a replacement**: a key mapped to a number sets it, a key mapped to
 * `null` deletes it, and a key that is absent is left alone. Replacement semantics would mean the
 * screen has to send every rule it did not touch back, and a screen that has to re-send state it
 * did not author is a screen that will one day delete a rule it never rendered.
 */
export interface RetentionUpdate {
  readonly defaultRetainDays?: number;
  readonly rules?: Readonly<Record<string, number | null>>;
  /** Compute and return the result without writing anything. */
  readonly dryRun?: boolean;
}

/** What `POST /api/retention/run` reports about the pass it just made. */
export interface RetentionRunResult {
  /** Rows deleted, per kind. Kinds that lost nothing are omitted. */
  readonly deletedByKind: Readonly<Record<string, number>>;
  readonly totalDeleted: number;
  readonly durationMs: number;
  /** The state after the pass, so the screen never has to re-fetch to redraw. */
  readonly settings: RetentionSettings;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * One registered webhook, as the control API returns it and the UI lists it.
 *
 * The secret is **not** here and never will be. It is handed back once by
 * {@link WebhookRegistered} at registration and is not recoverable afterwards — the same posture
 * grants take with their tokens, for the same reason: a listing endpoint that returns live signing
 * keys is a listing endpoint that leaks them.
 */
export interface WebhookSummary {
  readonly id: string;
  /** The grant that registered it, or null for one the user added in the UI. */
  readonly grantId: string | null;
  /** The app's name, resolved from the grant. Null when there is no grant behind it. */
  readonly appName: string | null;
  readonly url: string;
  /** Kind patterns: an exact kind, a `family.*` prefix, or `*`. */
  readonly kinds: readonly string[];
  /** The account this webhook is scoped to, or null for every account. */
  readonly accountId: string | null;
  readonly createdAt: number;
  /** Set when delivery has been switched off — by the user, or automatically. */
  readonly disabledAt: number | null;
  /** Why it was disabled, in words meant to be read. Null while it is live. */
  readonly disabledReason: string | null;
  readonly deliveredCount: number;
  /** Deliveries that exhausted their retries. The number that says an endpoint is broken. */
  readonly deadCount: number;
  readonly lastDeliveryAt: number | null;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  /** Deliveries still queued or mid-backoff. Survives a daemon restart — the queue is on disk. */
  readonly pending: number;
}

/**
 * The answer to `POST /api/webhooks`, and the only time the signing secret exists on the wire.
 *
 * Split from {@link WebhookSummary} rather than being an optional field on it, so that "the secret
 * is present" is a fact about the *type* rather than about which call happened to produce it.
 */
export interface WebhookRegistered {
  readonly webhook: WebhookSummary;
  /** `whsec_…`. Shown once. The daemon stores only a hash of it. */
  readonly secret: string;
}

/** The body of `POST /api/webhooks`. */
export interface WebhookRegistration {
  readonly url: string;
  /**
   * Kind patterns to deliver. Omitted means everything the caller is allowed to see, which is a
   * defensible default only because a webhook is already scoped to one grant's account.
   */
  readonly kinds?: readonly string[];
  /** Restrict to one account. A grant-registered webhook is pinned to its grant's account anyway. */
  readonly accountId?: string | null;
}
