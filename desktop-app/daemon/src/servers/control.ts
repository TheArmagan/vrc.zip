import { APP_VERSION } from "@vrcz/shared";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { hostGuard, originGuard, sessionAuth, type TokenSource } from "../security/guards.ts";

/**
 * The control API — the private surface the vrc.zip UI and CLI talk to. See PLAN.md §1.8.
 *
 * Its own `Hono` instance on its own port, never a path prefix on the mirror: the byte-faithful
 * proxy must be structurally incapable of serving a control route, and separate instances make
 * that a property of the wiring rather than of careful middleware ordering.
 *
 * Everything the routes need arrives through `ControlDeps`. Nothing in this file imports the store,
 * the account manager, or the event bus — the handlers stay a thin translation between HTTP and a
 * set of async methods, which is also what makes them testable with a fake in a few lines.
 */

/** JSON as it crosses the wire. Local to this module so the control API owns no foreign types. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The 2FA challenges VRChat issues. `otp` is a one-time recovery code. */
export type TwoFactorMethod = "totp" | "emailOtp" | "otp";

export interface ControlAccount {
  id: string;
  displayName: string;
  /** Unix milliseconds, integer. */
  addedAt: number;
  enabled: boolean;
  /** Unix milliseconds, integer, or null when never seen. */
  lastSeenAt: number | null;
  /** Pipeline/login state, as the UI's status dot renders it. */
  connection: "connected" | "connecting" | "disconnected" | "needs-2fa";
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — `api.vrchat.cloud` image URLs require the account's auth cookie and the mandatory
   * User-Agent, neither of which a browser can supply, so a bare `<img src>` gets a 403.
   */
  iconUrl: string | null;
}

export interface RateLimitSnapshot {
  /** Requests permitted per second across all accounts. */
  limit: number;
  /** Tokens currently available. */
  remaining: number;
  /** Requests waiting on the limiter right now. */
  queued: number;
  /** Unix milliseconds when a 429 backoff lifts, or null when not backing off. */
  retryAfter: number | null;
}

/** Everything `GET /api/status` reports that this module cannot work out for itself. */
export interface StatusSnapshot {
  /** True when the master key sits in a plain file rather than the OS keychain. */
  degradedKeychain: boolean;
  /** Which keychain backend is in use, for the settings screen. */
  backend: string;
  /** Number of configured accounts. */
  accounts: number;
  rateLimit: RateLimitSnapshot;
}

export interface LoginInput {
  username: string;
  password: string;
}

export type LoginResult =
  | { status: "ok"; account: ControlAccount }
  | { status: "requires-2fa"; accountId: string; methods: TwoFactorMethod[] };

export interface VerifyTwoFactorInput {
  method: TwoFactorMethod;
  code: string;
}

/** A live VRChat game-client session, as reconstructed from the log watcher. */
export interface GameSession {
  id: number;
  accountId: string | null;
  displayName: string | null;
  /** Unix milliseconds, integer. */
  startedAt: number;
  vrMode: string | null;
  currentLocation: string | null;
  currentWorldId: string | null;
}

/**
 * An instance a self-invite can be aimed at, split the way VRChat's path template wants it:
 * `POST /invite/myself/to/{worldId}:{instanceId}`.
 *
 * Split rather than passed as one location string on purpose — the route validates and the
 * dependency interpolates, so a caller cannot smuggle a second path segment past the validator by
 * handing the implementation a raw string it would have to re-check.
 */
export interface InviteTarget {
  readonly worldId: string;
  readonly instanceId: string;
}

/** One row of the unified feed. */
export interface FeedEvent {
  id: number;
  /**
   * Null for events from a VRChat client signed into an account vrc.zip does not manage. That is a
   * normal state, not an error — see PLAN.md §1.7 on unlinked sessions.
   */
  accountId: string | null;
  /** Unix milliseconds, integer. */
  ts: number;
  sessionId: number | null;
  kind: string;
  subjectId: string | null;
  location: string | null;
  payload: JsonValue;
}

/**
 * A feed query.
 *
 * `accountId`, `sessionId`, and `subjectId` are **mutually exclusive selectors** — each names a
 * different axis of "which rows", and the route rejects any two of them together with a 400 rather
 * than picking a winner. Silently ignoring one would be the same class of bug as the ghost session
 * rows: an answer that looks right and is about something else. `kind`, `before`, and `limit`
 * apply to whichever selector was chosen.
 *
 * With none of the three, the query is every account *and* the rows with no account at all.
 */
export interface EventQuery {
  accountId?: string;
  /**
   * One game client, `sessions.id`. Every stored `gamelog.*` row carries a real session id, so
   * this is the filter that separates two VRChat clients running side by side (PLAN.md §1.7).
   */
  sessionId?: number;
  /** One user/world/group id — everything ever recorded about them, across every account. */
  subjectId?: string;
  kind?: string;
  /** Already clamped by the route. */
  limit?: number;
  /** Unix milliseconds; return events strictly older than this. Feeds the infinite scroll. */
  before?: number;
}

/** A pending or recent VRChat notification: an invite, a friend request, a group announcement. */
export interface NotificationItem {
  id: string;
  accountId: string;
  /** Unix milliseconds, integer. */
  ts: number;
  type: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  message: string | null;
  seen: boolean;
  data: JsonValue;
}

export interface FriendPresence {
  id: string;
  displayName: string;
  /** VRChat's own status string: `active`, `join me`, `ask me`, `busy`, `offline`. */
  status: string;
  statusDescription: string | null;
  location: string | null;
  worldId: string | null;
  platform: string | null;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — `api.vrchat.cloud` image URLs require the account's auth cookie and the mandatory
   * User-Agent, neither of which a browser can supply, so a bare `<img src>` gets a 403.
   */
  iconUrl: string | null;
  /** Unix milliseconds, integer, or null when unknown. */
  lastSeenAt: number | null;
}

/** A user's local note, as stored in `notes` and echoed back by both routes that touch it. */
export interface UserNote {
  /** Whose note this is. Notes are per account — two accounts can hold different notes on one user. */
  accountId: string;
  userId: string;
  /** Null when there is no note, which is also what `PUT` with an empty string leaves behind. */
  note: string | null;
  /** Unix milliseconds, integer, or null when there is no note. */
  updatedAt: number | null;
}

/**
 * A VRChat group as the user modal renders it — one shape for both the represented group and the
 * full list, so the modal can draw the represented one first without a second source of truth.
 *
 * Normalised hard, because **every field of VRChat's `RepresentedGroup` and `LimitedUserGroups` is
 * optional**. A wire type whose fields are all `| null` pushes that mess into the UI, so the two
 * things a row cannot be drawn without — `id` and `name` — are guaranteed here instead, and a group
 * that cannot supply an id is dropped rather than passed on as a half-row.
 */
export interface GroupSummary {
  /** VRChat's `groupId` (`grp_…`). */
  id: string;
  /** Falls back to the short code, then to the id — never empty, so a row always has a label. */
  name: string;
  /** The `ABCD` half of `ABCD.1234`. */
  shortCode: string | null;
  /** The `1234` half. Two groups may share a short code; the pair is what is unique. */
  discriminator: string | null;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — see `ControlAccount.iconUrl`.
   */
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number | null;
  privacy: string | null;
  ownerId: string | null;
  description: string | null;
  /** VRChat's own flag, passed through — never inferred from which endpoint answered. */
  isRepresenting: boolean;
}

/** The answer to `GET /api/users/:id/groups`. */
export interface UserGroups {
  /**
   * **Only the groups this viewer is allowed to see.** VRChat filters the list by the asking
   * account's own membership and each group's visibility settings, so a short or empty list is a
   * correct answer about a user in a dozen groups, not a failed one.
   */
  groups: GroupSummary[];
}

/**
 * One mutual friend — enough to draw an avatar and a name without a call per row.
 *
 * A "mutual friend" is someone you and the subject are *both* friends with, which means every row
 * here is already one of your own friends. That is what makes `trustLevel` free: it comes from the
 * presence map this account already holds, not from a fetch. See {@link ControlDeps.listMutualFriends}.
 */
export interface MutualFriendSummary {
  id: string;
  displayName: string;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — see `ControlAccount.iconUrl`.
   */
  iconUrl: string | null;
  /** Derived by `trustLevelOf` from what vrc.zip already knows — see the note above. */
  trustLevel: string;
  /** VRChat's own status string: `active`, `join me`, `ask me`, `busy`, `offline`. */
  status: string;
}

/** One page of `GET /api/users/:id/mutual-friends`. */
export interface MutualFriendPage {
  users: MutualFriendSummary[];
  /**
   * Whether another page may exist.
   *
   * VRChat sends no total, so this is "the page came back full" — which can be true for the last
   * exactly-full page. An infinite scroll that asks once more and gets nothing is the right cost;
   * claiming the list ended when it did not is not.
   */
  hasMore: boolean;
}

/** Paging for `GET /api/users/:id/mutual-friends`. Already validated and clamped by the route. */
export interface PageQuery {
  n: number;
  offset: number;
}

/**
 * Just enough of a world to render `wrld_0ae3e886-52e…` as somewhere a person has heard of.
 *
 * This is the shape the **batch** resolver serves, and it is small on purpose: a feed page is a
 * hundred rows, and the row needs a name, a thumbnail, and an author — not a world's tag list,
 * visit count and Unity packages a hundred times over.
 */
export interface WorldSummary {
  id: string;
  /** Falls back to the id, so a label is never empty. */
  name: string;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — see `ControlAccount.iconUrl`.
   */
  thumbnailImageUrl: string | null;
  authorName: string | null;
  capacity: number | null;
}

/** The full world record, for a world page or a hover card. */
export interface WorldDetail extends WorldSummary {
  description: string | null;
  authorId: string | null;
  imageUrl: string | null;
  recommendedCapacity: number | null;
  tags: string[];
  releaseStatus: string | null;
  visits: number | null;
  favorites: number | null;
  heat: number | null;
  popularity: number | null;
  /**
   * How many people are in this world across every instance, at fetch time.
   *
   * The one genuinely live number on an otherwise static record, and the reason not to read too
   * much into it: it is as old as `fetchedAt`, which under this cache's TTL can be hours. For "who
   * is in *this* instance right now", `GET /api/instances` is the live answer.
   */
  occupants: number | null;
  /** Unix milliseconds, integer, or null. VRChat sends `"none"` here for an unpublished world. */
  publicationDate: number | null;
  /** Unix milliseconds, integer, or null. Same `"none"` caveat. */
  labsPublicationDate: number | null;
  /** Unix milliseconds, integer, or null. */
  createdAt: number | null;
  /** Unix milliseconds, integer, or null. */
  updatedAt: number | null;
  version: number | null;
  /** Unix milliseconds the VRChat body was fetched. */
  fetchedAt: number;
  /** True when this came from `world_cache` rather than a live fetch. */
  cached: boolean;
}

/**
 * The answer to `GET /api/worlds?ids=…`.
 *
 * **An id that could not be resolved is simply absent from the map**, never an error and never a
 * null entry. This endpoint exists to turn a page of feed rows into one request, and one deleted
 * world among fifty must not cost the other forty-nine their names. The UI's existing
 * `worldName ?? shortId(worldId)` fallback is exactly the right behaviour for a missing key.
 */
export interface WorldBatch {
  worlds: Record<string, WorldSummary>;
}

/** One instance's own record — the live counts, the access type, the region. */
export interface InstanceInfo {
  worldId: string;
  /** The instance id *with* its tags, as VRChat quotes it. */
  instanceId: string;
  /** `public`, `hidden`, `friends`, `private`, `group` — VRChat's own word for the access level. */
  type: string | null;
  ownerId: string | null;
  region: string | null;
  capacity: number | null;
  userCount: number | null;
  /** VRChat sends both `userCount` and `n_users`; they can disagree, so both are passed through. */
  nUsers: number | null;
  full: boolean;
  canRequestInvite: boolean;
  /** Unix milliseconds, integer, or null while the instance is open. */
  closedAt: number | null;
  hardClose: boolean | null;
  queueEnabled: boolean;
  queueSize: number | null;
  tags: string[];
  active: boolean;
  /**
   * The world this instance is in — **free**, because VRChat embeds the whole world record in the
   * instance response. Fetching it separately would be paying twice for the same bytes.
   */
  world: WorldSummary | null;
}

/**
 * The answer to `GET /api/instances`.
 *
 * Shaped like {@link InstanceRoster}, including the word `unavailable`, so the UI branches the same
 * way on both. Two upstream answers land here and neither is a failure: a **closed instance 404s**
 * (every instance ends that way eventually), and an instance id VRChat dislikes comes back as a
 * literal `null` body *with a 200*. Both are `source: "unavailable"` with `instance: null`.
 */
export interface InstanceDetail {
  location: string;
  /** Unix milliseconds, integer. */
  fetchedAt: number;
  source: "instance" | "unavailable";
  instance: InstanceInfo | null;
}

/**
 * Everything the user modal shows: VRChat's `getUser` merged with what vrc.zip knows locally.
 *
 * One shape, two very different provenances, which is why `accountId` and `fetchedAt` are on it.
 * VRChat answers `GET /users/{id}` **differently depending on who is asking** — a friend sees
 * `location`, `bio` and `lastLogin` where a stranger sees blanks — so "which account's eyes" is
 * part of the answer, not a detail of how it was obtained. See PLAN.md §1.3.
 */
export interface UserDetail {
  id: string;
  displayName: string;
  /** Whose eyes this was seen through. */
  accountId: string;
  /** Unix milliseconds the VRChat body was fetched. */
  fetchedAt: number;
  /** True when this response came from `user_cache` rather than a live fetch. */
  cached: boolean;

  // -- from VRChat --------------------------------------------------------
  bio: string | null;
  bioLinks: string[];
  pronouns: string | null;
  /** VRChat's own status string: `active`, `join me`, `ask me`, `busy`, `offline`. */
  status: string;
  statusDescription: string | null;
  /** `online` / `active` / `offline` — VRChat's coarser presence field, distinct from `status`. */
  state: string | null;
  tags: string[];
  /** Derived from `tags` by `trustLevelOf`, never re-derived anywhere else. */
  trustLevel: string;
  /**
   * `18+`, `verified`, or `hidden` — VRChat's own words, passed through verbatim. Null when unset.
   *
   * The same field, from the same source, as {@link InstanceUser.ageVerificationStatus}: the modal
   * and the instance roster must not derive age verification two different ways, or they will
   * eventually disagree about a person. Reading it off the `system_age_verified` **tag** works and
   * is what the modal did before this field existed, but it is the fallback, not the signal.
   *
   * **`hidden` means verified-but-not-published, not unverified.** Never collapse it into a
   * boolean — an absent badge would then read as a claim that a real person is not age verified,
   * which is a claim vrc.zip is not entitled to make.
   */
  ageVerificationStatus: string | null;
  ageVerified: boolean;
  /** The platform they are on *right now*; null when not visible to this account. */
  platform: string | null;
  /** The last platform VRChat saw them on. */
  lastPlatform: string | null;
  /** Raw VRChat location, carried through untouched — may be `private`, `traveling`, or `""`. */
  location: string | null;
  worldId: string | null;
  isFriend: boolean;
  /** Unix milliseconds, integer, or null. VRChat sends a date string; the wire stays integer ms. */
  dateJoined: number | null;
  /** Unix milliseconds, integer, or null. */
  lastLogin: number | null;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — see `ControlAccount.iconUrl`.
   */
  iconUrl: string | null;
  /**
   * The **non-thumbnail** original of {@link iconUrl}, or null — for "open image in a new tab".
   *
   * A separate field rather than a smarter `iconUrl`, because the two answer different questions:
   * every avatar in the app wants the thumbnail for its bandwidth, and this one wants the actual
   * image. It never falls back to a thumbnail, so null means *there is no full-size original* —
   * the UI should hide the action rather than open a 256px crop that looks like it worked.
   */
  iconUrlFull: string | null;
  /**
   * The profile banner, or null. A plain field on VRChat's `User`, so it costs no extra call — it
   * simply was not being passed through. Already the full-size asset; there is no thumbnail of it.
   */
  bannerUrl: string | null;
  /** Which banner the profile uses (`none`, `gallery`, …). VRChat's own word, passed through. */
  bannerType: string | null;
  /**
   * The group this user is representing, or null — and **null is the common case**, not a failure.
   * Costs one extra upstream call on a cache miss, folded into the same `user_cache` row and TTL as
   * the profile itself rather than getting a second cache with its own staleness.
   */
  representedGroup: GroupSummary | null;

  // -- from vrc.zip -------------------------------------------------------
  /** Unix milliseconds this account first recorded the friendship, or null when never friends. */
  friendedAt: number | null;
  /** The local note, per account. Null when unset. */
  note: string | null;
  /** Unix milliseconds the note was last written, or null. */
  noteUpdatedAt: number | null;
}

/**
 * One person in an instance, as the Live Sessions roster draws them.
 *
 * Everything here arrives in a **single** `GET /instances/{worldId}:{instanceId}` — VRChat returns
 * the whole roster as `LimitedUserInstance[]` on that one response. The alternative is one
 * `GET /users/{id}` per head, which is forty calls for a busy public instance and impossible
 * anyway: the game log frequently omits the user id, so there is often no id to ask about.
 */
export interface InstanceUser {
  id: string;
  displayName: string;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — see `ControlAccount.iconUrl`.
   */
  iconUrl: string | null;
  /**
   * The non-thumbnail original, or null — see {@link UserDetail.iconUrlFull}. Free here: it comes
   * out of the same roster response, so it costs no extra call.
   */
  iconUrlFull: string | null;
  /** Derived from `tags` by `trustLevelOf`, never re-derived anywhere else. */
  trustLevel: string;
  /** `18+`, `verified`, or `hidden` — VRChat's own words, passed through. Null when unset. */
  ageVerificationStatus: string | null;
  ageVerified: boolean;
  /** Whether they are a friend **of the account this roster was read through**. */
  isFriend: boolean;
  platform: string | null;
  developerType: string | null;
}

/**
 * The answer to `GET /api/instance-users`.
 *
 * `source` is the honest part. VRChat populates `users` only when the asking account is itself in
 * that instance, and omits it otherwise — that is a normal, correct state, not a failure, so it
 * answers `200` with `source: "unavailable"` and an empty roster. The screen then falls back to the
 * names it already has from the game log rather than showing an error for something working as
 * designed.
 */
export interface InstanceRoster {
  /** Echoed back so a late response can be matched to the instance the screen is still showing. */
  location: string;
  /** Unix milliseconds, integer. */
  fetchedAt: number;
  source: "instance" | "unavailable";
  users: InstanceUser[];
}

/**
 * Settings are deliberately opaque here. The control API's job is to hand them to the UI and hand
 * a patch back; the schema belongs to whoever owns `settings.json`.
 */
export type Settings = { readonly [key: string]: JsonValue };
export type SettingsPatch = { readonly [key: string]: JsonValue };

/** A message pushed down `GET /api/stream`. */
export interface StreamEvent {
  type: string;
  /** Unix milliseconds, integer. */
  ts: number;
  payload: JsonValue;
}

/**
 * The daemon capabilities the control API needs, and nothing else.
 *
 * Narrow on purpose: every method here is one route's worth of work, which keeps the seam between
 * "HTTP" and "the daemon" small enough to hold in your head and lets the two be built in parallel.
 */
export interface ControlDeps {
  /** Backing data for `GET /api/status`. `version` is added by the route from `@vrcz/shared`. */
  status(): Promise<StatusSnapshot>;

  listAccounts(): Promise<ControlAccount[]>;
  /** Resolves to `requires-2fa` rather than throwing — a challenge is a success, not an error. */
  login(input: LoginInput): Promise<LoginResult>;
  verifyTwoFactor(accountId: string, input: VerifyTwoFactorInput): Promise<ControlAccount>;
  /** Removes the account, its secrets, and its rows. Throws `ControlError(404)` if unknown. */
  removeAccount(accountId: string): Promise<void>;

  /**
   * Sends this account an invite to `target`, so a game client already signed into it can travel
   * there by accepting a notification.
   *
   * This exists because `vrchat://launch?id=…` is the wrong tool once a client is running: the URI
   * starts a *second* client, and two clients on one account fight over it. A self-invite is what
   * the running client can act on, and it is what VRCX's "Invite Me" does. The deep link stays
   * correct for the case where nothing is running — that decision is the UI's, not the daemon's.
   *
   * `target` has already been validated by `parseInviteLocation`; the implementation interpolates
   * it into a path and must not accept an unvalidated one.
   */
  inviteSelfTo(accountId: string, target: InviteTarget): Promise<void>;

  /**
   * The roster of one instance — trust rank, age verification, and friendship per head — in a
   * single upstream call.
   *
   * `target` has already been validated by `parseInviteLocation`, for the same reason
   * {@link inviteSelfTo} takes one: the location is interpolated into a VRChat path, so the
   * implementation must never receive a string it would have to re-check.
   *
   * `accountId` chooses whose eyes, exactly as {@link getUser} does — VRChat only fills in `users`
   * for an account that is *in* that instance, and `isFriend` is per account. `null` means "any
   * online account".
   *
   * Throws `ControlError(404, "unknown_account")` for a named account that does not exist, and
   * `ControlError(503, "no_account")` when nobody is signed in. A missing roster is **not** an
   * error — see {@link InstanceRoster}.
   */
  listInstanceUsers(target: InviteTarget, accountId: string | null): Promise<InstanceRoster>;

  /** Live game-client sessions — the ones with no `ended_at`. */
  listSessions(): Promise<GameSession[]>;
  listEvents(query: EventQuery): Promise<FeedEvent[]>;
  /** `null` means every account. */
  listFriends(accountId: string | null): Promise<FriendPresence[]>;
  /** `null` means every account. Notifications are state, not feed history — see the sink. */
  listNotifications(accountId: string | null): Promise<NotificationItem[]>;
  markNotificationSeen(id: string): Promise<void>;

  /**
   * VRChat's `getUser` merged with the local friend log and note, for the user modal.
   *
   * `accountId` chooses whose eyes to look through; `null` means "any online account". The
   * distinction is load-bearing rather than a convenience — see {@link UserDetail}.
   *
   * Throws `ControlError(404, "unknown_user")` when VRChat 404s, `ControlError(404,
   * "unknown_account")` for a named account that does not exist, and `ControlError(503,
   * "no_account")` when a live fetch is needed and nobody is signed in.
   */
  getUser(userId: string, accountId: string | null): Promise<UserDetail>;

  /**
   * The groups this user is in, as far as `accountId` is permitted to see them.
   *
   * Same account-resolution and error codes as {@link getUser}. An empty list is a 200 — see
   * {@link UserGroups.groups}.
   */
  listUserGroups(userId: string, accountId: string | null): Promise<UserGroups>;

  /**
   * One world, cached.
   *
   * The cache is **not per account** — unlike a user, a world is the same object whoever asks, and
   * migration 002 deliberately left `world_cache` global for exactly that reason. A fresh cache hit
   * therefore needs no account at all, which is what lets a feed render world names on a laptop
   * that has not signed in yet.
   *
   * Throws `ControlError(404, "unknown_world")` when VRChat 404s, and `ControlError(503,
   * "no_account")` when a live fetch is needed and nobody is signed in.
   */
  getWorld(worldId: string, accountId: string | null): Promise<WorldDetail>;

  /**
   * Many worlds at once, for a page of rows that each name one.
   *
   * **Never throws for an unresolvable world, and never throws `no_account`.** Cache hits are
   * served whatever else fails; misses are fetched only if an account is online, and anything still
   * unresolved is left out of the map. A batch that fails as a whole would take a hundred feed rows
   * down with one dead world, which is the opposite of why it exists.
   */
  listWorlds(worldIds: readonly string[], accountId: string | null): Promise<WorldBatch>;

  /**
   * One instance's own record: the live counts, the access type, the region, and the world.
   *
   * `target` has already been validated by `parseInviteLocation`. Shares its cache with
   * {@link listInstanceUsers} — the same upstream response carries both the roster and this, so
   * asking for both costs one call, not two.
   */
  getInstance(target: InviteTarget, accountId: string | null): Promise<InstanceDetail>;

  /**
   * One page of the friends this account and `userId` have in common.
   *
   * Paged rather than fetched whole: a user with six hundred mutuals is a real thing, and the modal
   * shows a dozen rows. `page` has already been validated and clamped by the route.
   *
   * Same account-resolution and error codes as {@link getUser}.
   */
  listMutualFriends(
    userId: string,
    accountId: string | null,
    page: PageQuery,
  ): Promise<MutualFriendPage>;

  /**
   * Writes the local note for `userId` under one account. An empty string clears it.
   *
   * **Local only.** This does not touch VRChat's `/userNotes`; a note here is vrc.zip's own,
   * which is why it needs no online account.
   */
  setUserNote(userId: string, accountId: string | null, note: string): Promise<UserNote>;

  /**
   * Fetches one VRChat image through an online account, cached.
   *
   * `null` means upstream said the image does not exist (a 404), which the route turns into a 404.
   * No online account is a `ControlError(503, "no_account")` from the implementation — the daemon
   * has no cookie to fetch with, and pretending otherwise would return a broken image forever.
   *
   * The URL arriving here has **already passed the host allowlist**; see `parseImageUrl`.
   */
  fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;

  getSettings(): Promise<Settings>;
  /** Merges the patch and resolves to the settings as they now stand. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;

  /**
   * Subscribes to the live event bus for `GET /api/stream`. Returns an unsubscribe function, which
   * the route calls when the socket closes — a leak here is a leak per browser tab.
   */
  subscribeEvents(listener: (event: StreamEvent) => void): () => void;
}

/** Status codes a dependency may ask for. Anything not on this list is a bug, and so a 500. */
export type ControlErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503;

/** Thrown by a `ControlDeps` implementation to choose the status code. Anything else is a 500. */
export class ControlError extends Error {
  readonly status: ControlErrorStatus;
  readonly code: string;

  constructor(status: ControlErrorStatus, code: string, message?: string) {
    super(message ?? code);
    this.name = "ControlError";
    this.status = status;
    this.code = code;
  }
}

export interface ControlAppOptions {
  /** The port this instance will be bound to. The `Host` allowlist is built from it. */
  port: number;
  deps: ControlDeps;
  /** Resolves the session token. A function, so a rotated token needs no re-wiring. */
  token: TokenSource;
}

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

/**
 * Paging for the mutual-friends list.
 *
 * The default is a modal's worth of rows rather than a screenful of data; the maximum is VRChat's
 * own ceiling for `n` on this endpoint, so asking for more than 100 could only ever be answered
 * with 100 and pretending otherwise would break the `hasMore` arithmetic.
 */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The only hosts `GET /api/image` will fetch from.
 *
 * **This is the daemon's SSRF boundary.** Every other outbound request the daemon makes goes to a
 * path it chose itself against `api.vrchat.cloud`; this is the one route where the *caller* names
 * the URL, and the caller is a web page. Without this list, anything that can reach the control
 * port — a malicious plugin's UI, a stored URL in a friend record VRChat let someone set — could
 * make the daemon fetch `http://169.254.169.254/`, `http://127.0.0.1:<proxy port>/`, or any
 * intranet host, and read the response back.
 */
const IMAGE_HOSTS: ReadonlySet<string> = new Set([
  "api.vrchat.cloud",
  "assets.vrchat.com",
  "files.vrchat.cloud",
]);

/** How long a browser may keep an image without revalidating. Icons change on the order of months. */
const IMAGE_CACHE_CONTROL = "private, max-age=604800, immutable";

/**
 * Validates and normalises the `url` query parameter of `GET /api/image`.
 *
 * Throws `ControlError(400, "invalid_url")` for anything the daemon must not fetch. The host match
 * is **exact** — deliberately not a suffix test, because `evil-api.vrchat.cloud.attacker.tld` ends
 * with nothing useful and `api.vrchat.cloud.attacker.tld` ends with `.attacker.tld`, yet a
 * `endsWith("vrchat.cloud")` check passes the first and a naive `includes` passes both.
 */
export function parseImageUrl(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_url", "url is required");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlError(400, "invalid_url", "url is not a URL");
  }

  // Plain http is refused rather than upgraded: an upgrade would hide a caller that meant to reach
  // something local, and VRChat serves every image over https anyway.
  if (url.protocol !== "https:") {
    throw new ControlError(400, "invalid_url", "url must be https");
  }

  // `URL` has already lowercased and punycoded the host, so this compares normalised forms.
  if (!IMAGE_HOSTS.has(url.hostname)) {
    throw new ControlError(400, "invalid_url", `host ${url.hostname} is not a VRChat image host`);
  }

  return url.toString();
}

/**
 * The ETag for an image URL: a hash of the (normalised) URL, not of the bytes.
 *
 * Hashing the URL means a conditional request is answered without fetching or even reading the
 * image — which is the entire point, since the expensive part is the upstream request. VRChat's
 * image URLs carry a file *version* in the path, so new bytes arrive under a new URL.
 */
export function imageETag(url: string): string {
  return `"${new Bun.CryptoHasher("sha256").update(url, "utf8").digest("hex").slice(0, 32)}"`;
}

/** `If-None-Match` is a comma-separated list, and may weaken each entry with a `W/` prefix. */
function matchesETag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((entry) => entry.trim().replace(/^W\//, ""))
    .includes(etag);
}

/**
 * The words VRChat uses for "nowhere you can follow". `/api/friends` and the log both pass these
 * through raw, so they reach the UI and would reach here if nothing stopped them.
 */
const UNJOINABLE_LOCATIONS: ReadonlySet<string> = new Set(["", "offline", "private", "traveling"]);

/** `wrld_` plus the id body. Length-capped so a pathological string cannot become a huge path. */
const WORLD_ID_PATTERN = /^wrld_[0-9A-Za-z_-]{1,64}$/;

/**
 * An instance id *with its tags* — `12345~hidden(usr_…)~region(eu)~nonce(…)`.
 *
 * The whole tail is sent, not just the number before the first `~`: the tags carry the access
 * level and the nonce, and VRChat rejects a self-invite to a closed instance quoted without them.
 * Every character this allows is left alone by percent-encoding, which is what makes it safe to
 * interpolate into a path directly — and the pattern is an allowlist precisely so `/`, `?`, `#`
 * and `%` cannot appear and turn one path segment into several.
 */
const INSTANCE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_.~()-]{0,255}$/;

/**
 * Validates a VRChat location string and splits it for `POST /invite/myself/to/{world}:{instance}`.
 *
 * Server-side and strict, rather than trusting the caller: the UI is a web page, and the only
 * thing standing between a wrong location and a malformed VRChat request is this function. Every
 * rejection is a 400 with `invalid_location` so the UI branches on a code, not on a sentence.
 */
export function parseInviteLocation(raw: string | undefined): InviteTarget {
  if (raw === undefined) {
    throw new ControlError(400, "invalid_location", "location is required");
  }
  // `traveling:wrld_…` is a destination the client is mid-hop to. It has no instance to be invited
  // into yet, and by the time an invite arrived the client would be somewhere else.
  if (UNJOINABLE_LOCATIONS.has(raw) || raw.startsWith("traveling")) {
    throw new ControlError(
      400,
      "invalid_location",
      `${raw || "an empty location"} is not joinable`,
    );
  }

  // `indexOf`, not `split(":", 2)`: the instance id is everything after the *first* colon, and
  // splitting would silently discard anything after a second one instead of rejecting it.
  const separator = raw.indexOf(":");
  if (separator === -1) {
    throw new ControlError(400, "invalid_location", "location names no instance");
  }

  const worldId = raw.slice(0, separator);
  const instanceId = raw.slice(separator + 1);

  if (!WORLD_ID_PATTERN.test(worldId)) {
    throw new ControlError(400, "invalid_location", `${worldId} is not a world id`);
  }
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new ControlError(400, "invalid_location", "instance id contains something unexpected");
  }

  return { worldId, instanceId };
}

/**
 * A VRChat user id, as it may be interpolated into `GET /users/{userId}`.
 *
 * **Not** `usr_<uuid>`: accounts created before the `usr_` scheme carry short opaque ids like
 * `8JoV9XEdKs`, and rejecting those would make the modal permanently unopenable for VRChat's
 * oldest users. So the pattern is an allowlist of the characters a path segment survives
 * unencoded, length-capped — the property that actually matters is that `/`, `?`, `#`, and `%`
 * cannot appear and turn one path segment into several. Same reasoning as `INSTANCE_ID_PATTERN`.
 */
const USER_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

/**
 * Validates a world id, for the routes that interpolate one into `GET /worlds/{worldId}`.
 *
 * Reuses `WORLD_ID_PATTERN`, the same allowlist `parseInviteLocation` applies to the half before
 * the colon — one definition of "that is a world id", so the two routes cannot drift into
 * disagreeing about one.
 */
export function parseWorldId(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_world_id", "a world id is required");
  }
  if (!WORLD_ID_PATTERN.test(raw)) {
    throw new ControlError(400, "invalid_world_id", "that is not a VRChat world id");
  }
  return raw;
}

/** The most ids `GET /api/worlds` will take at once. A feed page is 100 rows; most repeat a world. */
export const MAX_WORLD_IDS = 50;

/**
 * Splits and filters the `ids` query parameter of the batch world resolver.
 *
 * Malformed ids are **dropped, not rejected**, while too many is a 400. The asymmetry is the
 * contract: an unresolvable id is absent from the answer, and an id that cannot even be a world id
 * is the most unresolvable kind there is — failing the whole batch over one would take the other
 * forty-nine rows down with it. A cap, by contrast, is about what this endpoint is willing to spend
 * upstream, and silently truncating that would serve a partial answer that looks complete.
 */
export function parseWorldIds(raw: string | undefined): string[] {
  if (raw === undefined) {
    throw new ControlError(400, "invalid_query", "ids is required");
  }

  const requested = raw.split(",").map((id) => id.trim());
  if (requested.length > MAX_WORLD_IDS) {
    throw new ControlError(
      400,
      "too_many_ids",
      `at most ${String(MAX_WORLD_IDS)} world ids per request`,
    );
  }

  // De-duplicated: a feed page is full of rows in the same world, and asking for it fifty times
  // would be fifty cache lookups and, on a miss, fifty identical fetches waiting on each other.
  return [...new Set(requested.filter((id) => WORLD_ID_PATTERN.test(id)))];
}

/** Validates the `:id` path parameter of the user routes. */
export function parseUserId(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_user_id", "a user id is required");
  }
  if (!USER_ID_PATTERN.test(raw)) {
    throw new ControlError(400, "invalid_user_id", "that is not a VRChat user id");
  }
  return raw;
}

/**
 * The longest note accepted. VRChat's own `/userNotes` caps at 256 characters, and a local note
 * that cannot be synced later would be a note the user has to retype — so the local store adopts
 * the upstream limit now rather than growing data the sync cannot carry.
 */
export const MAX_NOTE_LENGTH = 256;

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

/** The Bun websocket handler for this app. `bind.ts` hands it to `Bun.serve`. */
export const controlWebSocketHandler = websocket;

export function createControlApp({ port, deps, token }: ControlAppOptions) {
  const app = new Hono()
    .use(hostGuard(port))
    .use(originGuard(port))
    .use(sessionAuth(token))

    .get("/api/status", async (c) => {
      const snapshot = await deps.status();
      return c.json({ version: APP_VERSION, ...snapshot });
    })

    .get("/api/accounts", async (c) => c.json(await deps.listAccounts()))

    .post("/api/accounts/login", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const username = stringField(body, "username");
      const password = stringField(body, "password");
      if (username === undefined || password === undefined) {
        throw new ControlError(400, "invalid_body", "username and password are required");
      }
      return c.json(await deps.login({ username, password }));
    })

    .post("/api/accounts/:id/verify-2fa", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const method = stringField(body, "method");
      const code = stringField(body, "code");
      if (!isTwoFactorMethod(method) || code === undefined) {
        throw new ControlError(400, "invalid_body", "method and code are required");
      }
      const account = await deps.verifyTwoFactor(c.req.param("id"), { method, code });
      return c.json({ status: "ok" as const, account });
    })

    .delete("/api/accounts/:id", async (c) => {
      await deps.removeAccount(c.req.param("id"));
      return c.json({ status: "ok" as const });
    })

    /*
     * "Take the client I already have running to this instance."
     *
     * The account is in the path because *which* account travels is the whole question when two
     * clients are running — the caller decides, the daemon does not guess. The location arrives as
     * one string because that is the shape everything upstream of here already has (a friend's
     * `location`, a session's `currentLocation`); splitting it is this route's job.
     */
    .post("/api/accounts/:id/invite-self", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const target = parseInviteLocation(stringField(body, "location"));
      await deps.inviteSelfTo(c.req.param("id"), target);
      return c.json({ status: "ok" as const });
    })

    .get("/api/sessions", async (c) => c.json(await deps.listSessions()))

    /*
     * The Live Sessions roster: everyone in one instance, with the three things the game log
     * cannot give you — trust rank, age verification, and whether they are a friend.
     *
     * The location is a **query parameter, not a path segment**, and that is not cosmetic: a real
     * one looks like `wrld_…:12345~hidden(usr_…)~region(eu)`, so as a path it would be several
     * segments wearing a trench coat. As `?location=<encodeURIComponent(…)>` it arrives as one
     * value, and `parseInviteLocation` — the same allowlist the self-invite route uses, for the
     * same interpolated-into-a-VRChat-path reason — decides whether it is a real instance at all.
     */
    .get("/api/instance-users", async (c) => {
      const target = parseInviteLocation(c.req.query("location"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listInstanceUsers(target, accountId));
    })

    /*
     * The feed. Four selectors, one of which is "everything": `accountId`, `sessionId`,
     * `subjectId`, or none. They are mutually exclusive and a combination is a 400 — see
     * `EventQuery`. `kind`, `before` and `limit` narrow and page whichever was chosen.
     */
    .get("/api/events", async (c) => {
      const query: EventQuery = { limit: clampLimit(c.req.query("limit")) };

      const accountId = nonEmpty(c.req.query("accountId"));
      if (accountId !== undefined) query.accountId = accountId;

      // Rejected rather than clamped or ignored: a `sessionId` that failed to parse would
      // otherwise silently widen the query from one game client to every event in the database,
      // which looks like data corruption from the UI side.
      const rawSession = nonEmpty(c.req.query("sessionId"));
      if (rawSession !== undefined) {
        const sessionId = integerParam(rawSession);
        if (sessionId === undefined || sessionId < 0) {
          throw new ControlError(400, "invalid_query", "sessionId must be a non-negative integer");
        }
        query.sessionId = sessionId;
      }

      const subjectId = nonEmpty(c.req.query("subjectId"));
      if (subjectId !== undefined) query.subjectId = subjectId;

      const selectors = [query.accountId, query.sessionId, query.subjectId].filter(
        (value) => value !== undefined,
      ).length;
      if (selectors > 1) {
        throw new ControlError(
          400,
          "invalid_query",
          "accountId, sessionId and subjectId are mutually exclusive",
        );
      }

      const kind = nonEmpty(c.req.query("kind"));
      if (kind !== undefined) query.kind = kind;
      const before = integerParam(c.req.query("before"));
      if (before !== undefined) query.before = before;
      return c.json(await deps.listEvents(query));
    })

    /*
     * The user modal's payload: VRChat's own record merged with the friend log and the local note.
     * `?accountId=` picks whose eyes; omitted, the daemon uses any online account.
     */
    .get("/api/users/:id", async (c) => {
      const userId = parseUserId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.getUser(userId, accountId));
    })

    /*
     * The groups on the profile. VRChat filters this by what the asking account may see, so an
     * empty array is a real answer — the route does not turn it into a 404.
     */
    .get("/api/users/:id/groups", async (c) => {
      const userId = parseUserId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listUserGroups(userId, accountId));
    })

    /*
     * Mutual friends, paged. `n` and `offset` are **rejected** rather than clamped when they are
     * not integers: a silently-ignored `offset` would serve page one forever while the UI counted
     * up, which reads as duplicated data rather than as a bad request.
     */
    .get("/api/users/:id/mutual-friends", async (c) => {
      const userId = parseUserId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(
        await deps.listMutualFriends(userId, accountId, {
          n: clampPageSize(c.req.query("n")),
          offset: parseOffset(c.req.query("offset")),
        }),
      );
    })

    /*
     * The local note. Local only — this never reaches VRChat's `/userNotes`. An empty string
     * clears the note, which is why the body is validated as a string rather than a non-empty one:
     * `stringField` treats `""` as absent, and here it is a deletion.
     */
    .put("/api/users/:id/note", async (c) => {
      const userId = parseUserId(c.req.param("id"));
      const body = await readJsonObject(c.req.raw);
      const note = body?.note;
      if (typeof note !== "string") {
        throw new ControlError(400, "invalid_body", "note must be a string");
      }
      if (note.length > MAX_NOTE_LENGTH) {
        throw new ControlError(
          400,
          "note_too_long",
          `a note is at most ${MAX_NOTE_LENGTH} characters`,
        );
      }
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.setUserNote(userId, accountId, note));
    })

    /*
     * World names. Two routes, and the batch one is the important one: every screen that shows a
     * location renders a world name, a feed page is a hundred rows, and one request per row is a
     * hundred requests. `GET /api/worlds?ids=a,b,c` is that page's worth in one.
     *
     * Registered before `/api/worlds/:id` for readability only — Hono matches the literal path and
     * the parameterised one as distinct routes, so the order is not load-bearing.
     */
    .get("/api/worlds", async (c) => {
      const ids = parseWorldIds(c.req.query("ids"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listWorlds(ids, accountId));
    })

    .get("/api/worlds/:id", async (c) => {
      const worldId = parseWorldId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.getWorld(worldId, accountId));
    })

    /*
     * One instance's own record. Same query-parameter-not-path-segment reasoning as
     * `/api/instance-users`, and the same validator — and on the daemon side, the same cached
     * upstream response, so a screen showing both the roster and the instance header pays once.
     */
    .get("/api/instances", async (c) => {
      const target = parseInviteLocation(c.req.query("location"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.getInstance(target, accountId));
    })

    .get("/api/friends", async (c) => {
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listFriends(accountId));
    })

    .get("/api/notifications", async (c) => {
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listNotifications(accountId));
    })

    .post("/api/notifications/:id/seen", async (c) => {
      await deps.markNotificationSeen(c.req.param("id"));
      return c.body(null, 204);
    })

    /*
     * The image proxy. `GET /api/image?url=<encodeURIComponent(absolute url)>`.
     *
     * A browser cannot load a VRChat image URL itself — they require the account's auth cookie and
     * the mandatory User-Agent — so every avatar in the UI comes through here. The route stays a
     * thin translation: validation, caching headers, and a call into `deps`.
     */
    .get("/api/image", async (c) => {
      const url = parseImageUrl(c.req.query("url"));
      const etag = imageETag(url);

      // Answered before touching `deps`: the whole value of an ETag here is skipping the upstream
      // fetch, and the tag is derived from the URL alone precisely so that is possible.
      if (matchesETag(c.req.header("If-None-Match"), etag)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": IMAGE_CACHE_CONTROL },
        });
      }

      const image = await deps.fetchImage(url);
      if (image === null) throw new ControlError(404, "image_not_found");

      return new Response(image.bytes, {
        status: 200,
        headers: {
          "Content-Type": image.contentType,
          "Cache-Control": IMAGE_CACHE_CONTROL,
          ETag: etag,
        },
      });
    })

    .get("/api/settings", async (c) => c.json(await deps.getSettings()))

    .put("/api/settings", async (c) => {
      const body = await readJsonObject(c.req.raw);
      if (body === undefined) throw new ControlError(400, "invalid_body", "expected a JSON object");
      return c.json(await deps.updateSettings(body));
    })

    /*
     * The live feed. Same guards as every other route on this port — the token arrives as
     * `?token=`, because a browser WebSocket cannot set request headers.
     */
    .get(
      "/api/stream",
      upgradeWebSocket(() => {
        let unsubscribe: (() => void) | undefined;
        return {
          onOpen(_event, ws) {
            unsubscribe = deps.subscribeEvents((event) => {
              ws.send(JSON.stringify(event));
            });
            ws.send(JSON.stringify({ type: "ready", ts: Date.now(), payload: null }));
          },
          onClose() {
            unsubscribe?.();
            unsubscribe = undefined;
          },
        };
      }),
    )

    .onError((error, c) => {
      if (error instanceof ControlError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      return c.json({ error: "internal_error", message: String(error) }, 500);
    });

  return app;
}

/** The type the UI feeds to `hc<ControlApp>` for end-to-end typed calls. */
export type ControlApp = ReturnType<typeof createControlApp>;

async function readJsonObject(request: Request): Promise<Record<string, JsonValue> | undefined> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, JsonValue>;
}

function stringField(body: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isTwoFactorMethod(value: string | undefined): value is TwoFactorMethod {
  return value === "totp" || value === "emailOtp" || value === "otp";
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

function clampLimit(raw: string | undefined): number {
  const parsed = integerParam(raw);
  if (parsed === undefined || parsed <= 0) return DEFAULT_EVENT_LIMIT;
  return Math.min(parsed, MAX_EVENT_LIMIT);
}

/** `n`, clamped to VRChat's own ceiling. Absent or nonsense falls back to the default page. */
function clampPageSize(raw: string | undefined): number {
  const parsed = integerParam(raw);
  if (parsed === undefined || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * `offset`, rejected rather than defaulted when it is malformed.
 *
 * Unlike `n`, a wrong offset is not a cosmetic difference: quietly treating it as 0 would hand the
 * infinite scroll page one again under the name of page five, and duplicate rows look like a data
 * bug rather than a bad request.
 */
function parseOffset(raw: string | undefined): number {
  if (nonEmpty(raw) === undefined) return 0;
  const parsed = integerParam(raw);
  if (parsed === undefined || parsed < 0) {
    throw new ControlError(400, "invalid_query", "offset must be a non-negative integer");
  }
  return parsed;
}

function integerParam(raw: string | undefined): number | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
