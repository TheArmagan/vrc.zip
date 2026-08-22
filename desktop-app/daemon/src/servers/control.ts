import {
  APP_VERSION,
  type AppAuditEntry,
  type AvatarDetail,
  type AvatarFileResolution,
  type ControlAccount,
  type EventKindCount,
  type EventQuery,
  type FeedEvent,
  type FriendPresence,
  type GameSession,
  type GroupGalleryImagePage,
  type GroupGalleryImageSummary,
  type GroupGallerySummary,
  type GroupInstanceList,
  type GroupInstanceSummary,
  type GroupMemberPage,
  type GroupMemberSummary,
  type GroupPostPage,
  type GroupPostSummary,
  type JsonValue,
  type LoginInput,
  type LoginResult,
  type RateLimitSnapshot,
  type RateSeries,
  RETENTION_DEFAULT_KEY,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type RetentionRunResult,
  type RetentionSettings,
  type RetentionUpdate,
  type StatusSnapshot,
  type StreamFrame,
  type TwoFactorMethod,
  type VerifyTwoFactorInput,
  type WebhookSummary,
  type WorldInstanceList,
} from "@vrcz/shared";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { hostGuard, originGuard, sessionAuth, type TokenSource } from "../security/guards.ts";
import { APP_API_PREFIX, type AppApi, type AppApiDeps, createAppApi } from "./app-api.ts";

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

/*
 * The wire shapes live in `@vrcz/shared` and are re-exported here, so every existing importer -
 * `wiring/control-deps.ts`, `servers/index.ts`, the tests - keeps its import path unchanged while
 * there is exactly one definition. See the header of `packages/shared/src/wire.ts` for what the two
 * hand-copied sets had drifted into.
 */
export type {
  AppAuditEntry,
  AvatarDetail,
  AvatarFileResolution,
  ControlAccount,
  EventKindCount,
  EventQuery,
  FeedEvent,
  FriendPresence,
  GameSession,
  GroupGalleryImagePage,
  GroupGalleryImageSummary,
  GroupGallerySummary,
  GroupInstanceList,
  GroupInstanceSummary,
  GroupMemberPage,
  GroupMemberSummary,
  GroupPostPage,
  GroupPostSummary,
  LoginInput,
  LoginResult,
  RateLimitSnapshot,
  StatusSnapshot,
  TwoFactorMethod,
  VerifyTwoFactorInput,
};

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

/**
 * How the inbox is narrowed and paged.
 *
 * Every field narrows. `GET /api/notifications` used to take no parameters at all and answer with
 * a fixed window — fifty rows per account, merged and sorted in the daemon — which is not a page:
 * there was no cursor, so the fifty-first notification on a busy account could not be asked for.
 */
export interface NotificationQuery {
  readonly accountId?: string | undefined;
  /** VRChat's own `type` strings. Absent means every type. */
  readonly types?: readonly string[] | undefined;
  /** `false` hides what has been read. Absent shows both. */
  readonly seen?: boolean | undefined;
  /** Case-insensitive substring over the sender, message, type and raw payload. */
  readonly search?: string | undefined;
  /** Clamped by the route regardless of what is asked for. */
  readonly limit?: number | undefined;
  /** Unix milliseconds; return notifications strictly older than this. */
  readonly before?: number | undefined;
}

/** One entry of `GET /api/notification-types`: a type in the store and how many rows it has. */
export interface NotificationTypeCount {
  readonly type: string;
  readonly count: number;
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
  /**
   * VRChat's `mutualGroup`: the *asking* account is in this group too.
   *
   * Only `LimitedUserGroups` carries it, which is `GET /users/{id}/groups` and nothing else, so it
   * is false everywhere else rather than computed — a group fetched by id is not "not mutual", it
   * is a group nobody asked that question about. The Groups tab is the one place it is rendered,
   * and that is the one place it arrives.
   */
  mutualGroup: boolean;
}

/**
 * One VRChat group in full, for the group modal — a `GroupSummary` plus the fields only
 * `GET /groups/{groupId}` carries.
 *
 * It extends the summary rather than restating it so the modal can render a group it already has a
 * summary of — a represented badge, a row in a user's Groups tab — the instant the dialog opens,
 * and let the fetch fill in the rest. Two shapes that overlapped by nine fields would guarantee
 * they eventually disagreed about one.
 *
 * Everything here is nullable for the same reason every field of `GroupSummary` is: **VRChat's
 * `Group` has no required fields at all**. A missing `memberCount` and a `memberCount` of zero are
 * different claims, so the absent one stays null and the UI drops the row rather than printing a
 * confident nought.
 */
export interface GroupDetail extends GroupSummary {
  /** Unix milliseconds, or null. VRChat sends an ISO string; the daemon converts, as everywhere. */
  createdAt: number | null;
  /**
   * How many members are online *now*, as against `memberCount`.
   *
   * VRChat computes this on its own schedule and stamps `memberCountSyncedAt` with when — which is
   * why that timestamp is passed through rather than dropped. A live-looking number with no age on
   * it is the kind of thing a reader trusts more than it deserves.
   */
  onlineMemberCount: number | null;
  memberCountSyncedAt: number | null;
  /** The group's own rules text, author-written, newlines and all. */
  rules: string | null;
  /** URLs the group put on its page. Rendered as links, never followed by the daemon. */
  links: string[];
  /** Three-letter language codes, as VRChat stores them. */
  languages: string[];
  /** VRChat's own tags, including its `system_` bookkeeping ones. Passed through unfiltered. */
  tags: string[];
  isVerified: boolean;
  /** `open`, `invite`, `request`, `closed` — how someone would join, in VRChat's own word. */
  joinState: string | null;
  /**
   * The *asking account's* standing in this group: `member`, `requested`, `invited`, `userblocked`,
   * or null when VRChat said nothing.
   *
   * A statement about the viewer, not about the group, which is why it moves when `accountId` does.
   */
  membershipStatus: string | null;
  /**
   * The group's galleries, which arrive **on the group body itself** — `Group.galleries` — so the
   * tab strip costs no request and only opening one does.
   *
   * A gallery with no id is dropped rather than passed on: there would be nothing to fetch its
   * images with, and nothing to key the tab on. Empty is the common case for a small group.
   */
  galleries: GroupGallerySummary[];
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

/**
 * Paging for `GET /api/apps/:id/audit`. Already validated and clamped by the route.
 *
 * Keyed on a timestamp rather than an offset, exactly as the feed is: the audit log grows while the
 * page is open, and an offset would re-show the row the reader just scrolled past.
 */
export interface AuditQuery {
  readonly limit: number;
  /** Unix milliseconds; return rows strictly older than this. Absent means "from now". */
  readonly before?: number | undefined;
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
  /**
   * The name whoever opened the instance gave it, or null.
   *
   * Group instances are the case that matters: VRChat lets them be titled, and "Movie Night" is
   * what the people in it call the room. Null for the ordinary instance nobody named, which is
   * most of them, and null is what lets a caller fall back to the instance number rather than
   * printing an empty heading.
   */
  displayName: string | null;
  /** VRChat's own `name`, which is usually the instance number again. Passed through, not merged. */
  name: string | null;
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
 * One VRChat badge, as the profile page shows it.
 *
 * `assignedAt`, `hidden` and `updatedAt` exist on VRChat's `Badge` and are documented as *"only
 * present in CurrentUser badges"*, so they are deliberately absent here: a field that is null for
 * every user this modal can show is a field the UI eventually branches on wrongly.
 */
export interface UserBadge {
  id: string;
  name: string;
  description: string | null;
  /**
   * An absolute VRChat asset URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — see `ControlAccount.iconUrl`.
   */
  imageUrl: string | null;
  /** The user chose to feature this one on their profile. Showcased badges sort first. */
  showcased: boolean;
}

/**
 * The profile-page half of a user: what `GET /profile/{id}` adds to `GET /users/{id}`.
 *
 * **`/profile/{id}` does not replace `/users/{id}`.** It carries none of the presence fields —
 * no `location`, `state`, `last_login`, `platform`, or `travelingTo*` — so it supplements the user
 * record and can never stand in for it. Reading presence off it would leave the whole app blind.
 * See the decision log in PROGRESS.md.
 *
 * A separate, **nullable** object rather than fields spread onto {@link UserDetail}, because this
 * is a second, best-effort call: null means *we got no answer*, which is a different claim from
 * "this person has no badges and published no languages". The modal renders fully without it.
 */
export interface UserProfileCard {
  /** Languages the user published, in VRChat's own short codes (`eng`, `jpn`, …). */
  languages: string[];
  /** Showcased first, then the rest, VRChat's own order preserved within each half. */
  badges: UserBadge[];
  /** VRChat's own answer, rather than `tags.includes("system_supporter")` inferred from elsewhere. */
  hasVrcPlus: boolean;
  /** The colour VRChat stores for the profile header, or null when unset. */
  bannerColor: string | null;
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
   * The avatar this user is *wearing*, as VRChat's own picture of it, or null.
   *
   * Distinct from `iconUrl` and worth its own field even though `pickUserImageUrl` may fall back to
   * it: as an icon it is "the best picture of this person", and here it is "the thing they are
   * wearing", which is a different claim and the only one an avatar lookup may be built on. VRChat
   * exposes no avatar *id* on a public user, so this URL's file id is the only handle there is —
   * see `net/avatar-ids.ts`.
   */
  currentAvatarImageUrl: string | null;
  /** The thumbnail of the same. Both are sent, and either can carry the file id. */
  currentAvatarThumbnailImageUrl: string | null;
  /** VRChat's content tags for the worn avatar. An open set, passed through verbatim. */
  currentAvatarTags: readonly string[];
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
  /**
   * The profile-page extras, or **null when that call did not answer** — never an empty card.
   *
   * Costs no extra request on the common path: the profile reports whether the user represents a
   * group at all, and a `null` there skips the `/users/{id}/groups/represented` call that used to
   * run unconditionally. See {@link UserProfileCard}.
   */
  profileCard: UserProfileCard | null;

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
  /**
   * VRChat's `status` — the person's *chosen* status (`active`, `join me`, `ask me`, `busy`), or
   * `offline`. Passed through verbatim; null when unset.
   *
   * It is not a statement about whether they are here. Everybody in a roster is here — the game log
   * says so — and VRChat will still answer `offline` for some of them. See `chosenStatus` in the
   * UI's `format.ts` for what that means at the point of rendering.
   */
  status: string | null;
  platform: string | null;
  developerType: string | null;
}

/**
 * The answer to `GET /api/instance-users`.
 *
 * `source` is the honest part, and what it is honest *about* was wrong here until someone checked.
 *
 * **VRChat returns `users` only on instances the asking account created.** Not "instances it is
 * standing in" — that is what this said, and it is false: an account sitting in a group-public
 * instance with sixteen people in it gets `userCount: 16` and no `users` array at all. The spec
 * says so in one line (`Instance.users`: *"present on instances created by the requesting user"*),
 * and the observed behaviour matches it exactly.
 *
 * That makes `source: "unavailable"` the **normal** answer for almost every instance anyone
 * actually looks at, rather than the edge case the old wording implied. It is a correct 200 with an
 * empty roster, and the screen falls back to the names the game log already gave it — which is why
 * the log is the source of truth for *who is present* and this endpoint only ever decorates.
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
 * The answer to `GET /api/users?ids=…` — the roster's fallback, one entry per user it could read.
 *
 * Shaped as `InstanceUser[]` on purpose, not as a new type: this exists precisely so a screen that
 * asked for a roster and got `source: "unavailable"` can fill the same chips from a different
 * source, and a second shape would mean a second render path that could drift from the first.
 *
 * **An id that could not be read is absent from the list**, exactly as in the world batch, and for
 * the same reason: this is asked for a room of eighty strangers, and one deleted account must not
 * take the other seventy-nine down with it. Absent does not mean "deleted" either — with nobody
 * signed in the daemon answers from cache alone, so everything it has never read is missing too.
 */
export interface UserBatch {
  users: InstanceUser[];
}

/**
 * The most ids `GET /api/users` will take at once.
 *
 * A VRChat instance holds at most 80 and the busiest rooms are near that, so this covers a full
 * room in one request. It is a ceiling on **upstream spend**, not a paging convenience: every id
 * past the cache is one `GET /users/{id}`, which is why the route rejects a longer list rather than
 * truncating it and serving a partial answer that looks complete.
 */
export const MAX_USER_IDS = 80;

/**
 * Settings are deliberately opaque here. The control API's job is to hand them to the UI and hand
 * a patch back; the schema belongs to whoever owns `settings.json`.
 */
export type Settings = { readonly [key: string]: JsonValue };
export type SettingsPatch = { readonly [key: string]: JsonValue };

/**
 * A message pushed down `GET /api/stream`.
 *
 * `StreamFrame` from `@vrcz/shared`, under the name the daemon already used. It was
 * `{ type: string; ts: number; payload: JsonValue }` here, which is not a description of the wire
 * so much as an admission that nobody had written one: the envelope inside `payload` had no type at
 * all and was produced through two `as` casts in `control-deps.ts`. The UI held the only written
 * description of the daemon's own frame format.
 */
export type StreamEvent = StreamFrame;

/**
 * The daemon capabilities the control API needs, and nothing else.
 *
 * Narrow on purpose: every method here is one route's worth of work, which keeps the seam between
 * "HTTP" and "the daemon" small enough to hold in your head and lets the two be built in parallel.
 */
/**
 * One app waiting at the consent sheet. PLAN.md §Phase 2 "Pending consent".
 *
 * **The pairing code is on this payload, and that is deliberate.** It is the whole point of the
 * screen: the user reads it here and types it into the app, and that gesture is the consent. It
 * never goes to the app itself, only to the vrc.zip UI behind the session token.
 */
export interface PendingConsentRequest {
  id: string;
  /** Null when the app asked the user to choose, or named an account not in vrc.zip yet. */
  accountId: string | null;
  /** Whichever account `accountId` names, resolved for display. Null with `accountId`. */
  accountName: string | null;
  /** What the app put in the username field, shown verbatim so the user recognises it. */
  requestedUsername: string;
  app: { name: string; version: string; contact: string };
  /** Everything the app asked for, each with the plain-English line from the shared registry. */
  scopes: ConsentScope[];
  /**
   * Whether this is an escalation: the app already holds a grant and is asking for more.
   *
   * The sheet leads with the *new* scopes in that case. Re-listing what the user already approved
   * makes the new ask harder to see, not easier.
   */
  escalation: boolean;
  /** Six digits. */
  code: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * One app that holds a live grant, as the Connected apps page renders it.
 *
 * **No token, no hash, and no pairing code.** The grant's token is what an app authenticates with,
 * and it is stored hashed precisely so that nothing — including this — can hand it back. The page
 * needs to answer "who has access to what, and since when", and none of that requires the
 * credential.
 */
export interface ConnectedApp {
  readonly id: string;
  readonly accountId: string;
  /** The account's display name, resolved for the page. Falls back to the id if unknown. */
  readonly accountName: string;
  readonly app: { readonly name: string; readonly version: string; readonly contact: string };
  readonly scopes: readonly ConsentScope[];
  readonly createdAt: number;
  /** When this app last made a request through the mirror. Null if it never has. */
  readonly lastUsedAt: number | null;
  /** Live pipeline sockets this grant currently holds. */
  readonly liveSockets: number;
  /**
   * What this app is spending, per second, over the last minute.
   *
   * PLAN.md §Phase 3 calls the rate budget the sharpest edge in the system: an app polling too hard
   * gets *the user* rate-limited, and the user blames vrc.zip. Naming who is eating it is the half
   * that makes the revoke button beside it an informed decision rather than a guess.
   */
  readonly rate: RateSeries;
  /**
   * The three risky scopes' hourly allowances, and what this app has spent against them.
   *
   * Only the budgeted scopes appear, and one appears whether or not this app holds it: a card that
   * hid `invite:send` because the app cannot send invites would make the control invisible exactly
   * when someone wants to check that it is zero.
   */
  readonly budgets: readonly AppBudget[];
}

/** One risky scope's allowance for one app. */
export interface AppBudget {
  readonly scope: string;
  /** Plain English, from the shared registry. The same sentence the consent sheet showed. */
  readonly description: string;
  /** Calls permitted per rolling hour. `0` means never. */
  readonly limit: number;
  /** This build's allowance for the scope, so the page can say what "reset" would go back to. */
  readonly defaultLimit: number;
  /** True when `limit` is the user's, false when it is `defaultLimit` because nothing was set. */
  readonly overridden: boolean;
  /** Calls of this scope that reached VRChat inside the current window. */
  readonly used: number;
  /** True when the app holds this scope at all. A budget on a scope it lacks is inert. */
  readonly granted: boolean;
}

/** One requested scope, as the consent sheet renders it. */
export interface ConsentScope {
  scope: string;
  description: string;
  /** Shown in its own block behind a second toggle, and never reachable through a wildcard. */
  dangerous: boolean;
  /** False when the app already holds this scope — an escalation shows those greyed, not hidden. */
  isNew: boolean;
}

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
   * Invites someone else to an instance, **as the user**.
   *
   * The counterpart to {@link inviteSelfTo}, and a materially different act: that one moves a
   * client the user already owns, this one puts a notification in a stranger's inbox with the
   * user's name on it. It is behind the same `invite:send` scope the proxy budgets for exactly that
   * reason — see `DEFAULT_GRANT_BUDGETS` — and the UI reaches it with the user's own session, so
   * nothing here is budgeted; the user clicking a button is not an app spending their reputation.
   *
   * `target` has already passed `parseInviteLocation`, and `userId` `parseUserId`, because both are
   * interpolated into a VRChat path.
   *
   * `messageSlot` picks one of the user's saved invite messages. Absent means VRChat's default
   * wording, which is what almost every caller wants.
   */
  inviteUserTo(
    accountId: string,
    userId: string,
    target: InviteTarget,
    messageSlot?: number,
  ): Promise<void>;

  /**
   * Asks someone for an invite to wherever they are.
   *
   * The mirror image of {@link inviteUserTo} and the one people actually use: you cannot join a
   * friend in a friends-only instance without one, and the alternative is asking them in a text
   * chat they are not reading because they are in VR.
   */
  requestInviteFrom(accountId: string, userId: string, requestSlot?: number): Promise<void>;

  /**
   * Boops someone.
   *
   * A greeting with no content, which is the whole appeal — and the reason it is here rather than
   * waiting for something larger. It costs one call, it is `friends:write` (budgeted for apps,
   * unbudgeted for the person at the keyboard), and it is the single friendliest thing this API
   * can do.
   */
  boop(accountId: string, userId: string): Promise<void>;

  /**
   * The roster of one instance — trust rank, age verification, and friendship per head — in a
   * single upstream call.
   *
   * `target` has already been validated by `parseInviteLocation`, for the same reason
   * {@link inviteSelfTo} takes one: the location is interpolated into a VRChat path, so the
   * implementation must never receive a string it would have to re-check.
   *
   * `accountId` chooses whose eyes, exactly as {@link getUser} does — `isFriend` is per account, and
   * whether `users` comes back at all depends on whether that account *created* the instance (see
   * {@link InstanceRoster}). `null` means "any online account".
   *
   * Throws `ControlError(404, "unknown_account")` for a named account that does not exist, and
   * `ControlError(503, "no_account")` when nobody is signed in. A missing roster is **not** an
   * error — see {@link InstanceRoster}.
   */
  listInstanceUsers(target: InviteTarget, accountId: string | null): Promise<InstanceRoster>;

  /** Live game-client sessions — the ones with no `ended_at`. */
  listSessions(): Promise<GameSession[]>;
  listEvents(query: EventQuery): Promise<FeedEvent[]>;
  /** Every kind in the store with its row count — what a filter list is built from. */
  listEventKinds(): Promise<EventKindCount[]>;
  /** `null` means every account. */
  listFriends(accountId: string | null): Promise<FriendPresence[]>;
  /** One page of the inbox. Notifications are state, not feed history — see the sink. */
  listNotifications(query: NotificationQuery): Promise<NotificationItem[]>;
  /** Every notification type in the store with its row count. The type filter's vocabulary. */
  listNotificationTypes(): Promise<NotificationTypeCount[]>;
  markNotificationSeen(id: string): Promise<void>;

  /**
   * Apps currently waiting at the consent sheet, oldest first.
   *
   * Carries the pairing code, so this route is exactly as sensitive as the session token that
   * guards it. There is no unauthenticated variant and there must never be one.
   */
  listPendingConsent(): Promise<PendingConsentRequest[]>;

  /**
   * Binds a pending request to an account — the picker, for the reserved "let the user choose"
   * username, and for an app that named an account only added just now.
   *
   * Until this happens a correct code is still refused, because pairing to nothing would either
   * fail later or pick an account on the user's behalf. Throws `ControlError(404, "unknown_consent")`
   * for a request that has expired or already been answered.
   */
  setConsentAccount(pairingId: string, accountId: string): Promise<PendingConsentRequest>;

  /** The user said no. Idempotent; a request that is already gone is not an error. */
  denyConsent(pairingId: string): Promise<void>;

  /** Every app holding a live grant, newest first. Revoked ones are gone, not greyed. */
  listConnectedApps(): Promise<ConnectedApp[]>;

  /**
   * Revokes one grant and closes the sockets it holds.
   *
   * Idempotent: revoking something already revoked is the outcome the user asked for. Per grant
   * rather than per account, because an account can have several apps attached and "revoke this
   * one" must not take the others down with it.
   */
  revokeConnectedApp(grantId: string): Promise<void>;

  /**
   * Sets or clears one app's hourly allowance for one risky scope.
   *
   * `null` clears the override, which returns the scope to this build's default rather than to
   * zero — decision 95 asks for an editable number, not a second kill switch. Throws
   * `ControlError(404)` for an unknown app and `ControlError(400)` for a scope that is not budgeted.
   */
  setAppBudget(grantId: string, scope: string, limit: number | null): Promise<ConnectedApp>;

  /**
   * Every webhook registered on this daemon, newest first.
   *
   * The user's oversight view, and deliberately *not* scoped to a grant the way `/app/webhooks` is:
   * an app sees only its own, the person who owns the machine sees all of them. A webhook is an
   * app quietly forwarding this user's presence to an address they never typed, so being able to
   * enumerate them is the point.
   */
  listWebhooks(): Promise<WebhookSummary[]>;
  /** Removes one, whoever registered it. Idempotent; an unknown id is not an error. */
  deleteWebhook(webhookId: string): Promise<void>;

  /** The global kill switch. Returns how many live grants it closed. */
  revokeAllConnectedApps(): Promise<number>;

  /**
   * What one app has actually done — its rows of the proxy audit log, newest first.
   *
   * Scoped to a grant rather than served whole, because the question the Connected apps page asks
   * is about one app: the revoke button beside it is a decision about that app, and a mixed log of
   * every app's calls is not evidence for it.
   *
   * A **revoked** grant is still a valid id here: the log outlives the access, which is the point of
   * keeping it. Throws `ControlError(404, "unknown_app")` only for a grant that never existed —
   * an empty list is a normal answer for an app that has changed nothing.
   *
   * `query` has already been validated and clamped by the route.
   */
  listAppAudit(grantId: string, query: AuditQuery): Promise<AppAuditEntry[]>;

  /**
   * How many UI clients currently hold an event-stream socket.
   *
   * Synchronous and not a promise: it is read on the path that decides whether to raise an OS
   * notification, and that decision must not be able to lag behind the socket it describes.
   */
  streamClientCount(): number;

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
   * Attributes for many users at once — the roster's fallback path.
   *
   * `listInstanceUsers` is the cheap way to learn what a room full of people are like: one request
   * for the lot. It only answers for an instance the account **created** (see {@link
   * InstanceRoster}), which is almost never, so without this the chips would be permanently empty
   * for every group and public room anyone actually sits in.
   *
   * So: one `GET /users/{id}` per person, cache-first, and deliberately not the default. It is the
   * expensive path and the caller is expected to ask only for the people it still has nothing
   * about.
   *
   * **Never throws for an unresolvable user, and never throws `no_account`.** Cache hits are served
   * whatever else fails; misses are fetched only if an account is online, and anything still
   * unresolved is simply left out — same contract as {@link listWorlds}, for the same reason.
   */
  listUsers(userIds: readonly string[], accountId: string | null): Promise<UserBatch>;

  /**
   * The groups this user is in, as far as `accountId` is permitted to see them.
   *
   * Same account-resolution and error codes as {@link getUser}. An empty list is a 200 — see
   * {@link UserGroups.groups}.
   */
  listUserGroups(userId: string, accountId: string | null): Promise<UserGroups>;

  /**
   * One group in full, for the group modal.
   *
   * Not cached, unlike a world, and the difference is not an oversight: a group's live figures —
   * the online member count, and the viewer's own membership status — are the reason to open the
   * dialog, and a cached one would show yesterday's. Worlds are the same record whoever asks and
   * change on a release cadence; groups are neither.
   *
   * `accountId` chooses whose eyes, as everywhere: `membershipStatus` and `myMember` are statements
   * about the *asking* account, and a private group answers 404 to an account that cannot see it.
   *
   * Throws `ControlError(404, "unknown_group")` when VRChat 404s, `ControlError(404,
   * "unknown_account")` for a named account that does not exist, and `ControlError(503,
   * "no_account")` when nobody is signed in.
   */
  getGroup(groupId: string, accountId: string | null): Promise<GroupDetail>;

  /*
   * The four group sub-resources. They share an error contract, and the part of it worth stating
   * once is the **403**.
   *
   * Most groups will not show their member list, their board, or a members-only gallery to somebody
   * who is not in them, and VRChat says so with a 403 rather than an empty list. Collapsing that
   * into `[]` would put "this group has no members" on screen in front of a group with four hundred
   * — so it surfaces as `ControlError(403, "group_forbidden")` and the UI renders "membership
   * required" instead. An empty list and "you may not look" are different facts.
   *
   * A 404 stays `unknown_group`, exactly as on {@link getGroup}: gone, or invisible to this account.
   * `ControlError(404, "unknown_account")` and `ControlError(503, "no_account")` behave as
   * everywhere else.
   */

  /** One page of a group's member list. `page` has already been validated and clamped by the route. */
  listGroupMembers(
    groupId: string,
    accountId: string | null,
    page: PageQuery,
  ): Promise<GroupMemberPage>;

  /** One page of a group's announcements. `page` has already been validated and clamped. */
  listGroupPosts(
    groupId: string,
    accountId: string | null,
    page: PageQuery,
  ): Promise<GroupPostPage>;

  /**
   * Every instance the group currently has open.
   *
   * Takes no paging because **upstream takes none** — `GET /groups/{groupId}/instances` has no `n`
   * or `offset`. See {@link GroupInstanceList}.
   */
  listGroupInstances(groupId: string, accountId: string | null): Promise<GroupInstanceList>;

  /**
   * One page of images from one of the group's galleries.
   *
   * The gallery *list* is not fetched: it rides on the group body as {@link GroupDetail.galleries}.
   * A `membersOnly` gallery is the most likely source of a `group_forbidden` on this whole family.
   */
  listGroupGalleryImages(
    groupId: string,
    galleryId: string,
    accountId: string | null,
    page: PageQuery,
  ): Promise<GroupGalleryImagePage>;

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
   * The avatar id behind one image file id, via **avtr.zip — a third-party service**.
   *
   * The one non-VRChat request vrc.zip makes, and the only reason it exists is that VRChat exposes
   * no avatar id on a public user: the image is the only handle a "changed avatar" row has. What
   * leaves the machine is the file id and nothing else; `daemon/src/net/avatar-ids.ts` says so at
   * length.
   *
   * **Never throws for an unresolved file.** `avatarId: null` is the answer when the setting is
   * off, when avtr.zip does not know the file, and when avtr.zip cannot be reached — none of which
   * is an error the caller can act on differently.
   */
  resolveAvatarByFile(fileId: string): Promise<AvatarFileResolution>;

  /**
   * One avatar, cached.
   *
   * Cached in `avatar_cache`, which like `world_cache` is **not per account**: an avatar record is
   * the same object whoever asks. A fresh cache hit therefore needs no account at all.
   *
   * Throws `ControlError(404, "unknown_avatar")` when VRChat 404s — which is the ordinary answer
   * for a private or deleted avatar — and `ControlError(503, "no_account")` when a live fetch is
   * needed and nobody is signed in.
   */
  getAvatar(avatarId: string, accountId: string | null): Promise<AvatarDetail>;

  /**
   * The instances of one world vrc.zip can see, derived from friends' presence and your own clients.
   *
   * **Never reaches VRChat**, so it never throws `no_account`: an empty list is the answer when
   * nothing is signed in, which is a true statement about what can be seen rather than a failure.
   * See {@link WorldInstanceList} for why a derived list is the only kind there can be.
   */
  listWorldInstances(worldId: string, accountId: string | null): Promise<WorldInstanceList>;

  /**
   * Puts one signed-in account into an avatar.
   *
   * `accountId` is required and never inferred: with two accounts signed in, "wear this" means
   * nothing until it says who, and choosing one silently would dress the wrong person.
   *
   * Throws `ControlError(409, "account_offline")`, `(404, "unknown_avatar")` for an avatar that is
   * gone or invisible, and `(403, "avatar_forbidden")` when VRChat refuses the entitlement — which
   * VRChat decides, not vrc.zip. See PLAN.md §Guardrails.
   */
  selectAvatar(avatarId: string, accountId: string): Promise<void>;

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

  /** The retention config, plus a dry run of what the next pass would delete. */
  getRetention(): Promise<RetentionSettings>;
  /**
   * Applies a retention patch, or — when `dryRun` is set — reports what it would do and writes
   * nothing. Both resolve to the same shape; `preview` on the result says which happened.
   */
  updateRetention(update: RetentionUpdate): Promise<RetentionSettings>;
  /** Runs a retention pass now, rather than waiting for the nightly one. */
  runRetention(): Promise<RetentionRunResult>;

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
  /**
   * The third-party surface from `app-api.ts`, mounted at `/app`.
   *
   * Passed in rather than constructed here so this module keeps one authentication model per path
   * prefix and no knowledge of the other's. Omit it and `/app` does not exist — which is the right
   * answer for a daemon with no grant store, and for every test that only exercises `/api`.
   */
  appApi?: AppApi | undefined;
  /** Resolves the session token. A function, so a rotated token needs no re-wiring. */
  token: TokenSource;
}

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

/**
 * Paging for the mutual-friends list and the three paged group sub-resources.
 *
 * The default is a modal's worth of rows rather than a screenful of data; the maximum is VRChat's
 * own ceiling for `n` on every one of these endpoints, so asking for more than 100 could only ever
 * be answered with 100 and pretending otherwise would break the `hasMore` arithmetic — which reads
 * "the page came back full" and would therefore be permanently false at any larger `n`.
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

/**
 * Splits and filters the `ids` query parameter of the user batch.
 *
 * Malformed ids are **dropped, not rejected**, while too many is a 400 — the same asymmetry as
 * `parseWorldIds`, and the same contract: an unresolvable id is absent from the answer, and an id
 * that cannot even be a user id is the most unresolvable kind there is. A cap, by contrast, is
 * about what this endpoint is willing to spend upstream, and silently truncating it would serve a
 * partial answer that looks complete.
 */
export function parseUserIds(raw: string | undefined): string[] {
  if (raw === undefined) {
    throw new ControlError(400, "invalid_query", "ids is required");
  }

  const requested = raw.split(",").map((id) => id.trim());
  if (requested.length > MAX_USER_IDS) {
    throw new ControlError(
      400,
      "too_many_ids",
      `at most ${String(MAX_USER_IDS)} user ids per request`,
    );
  }

  // De-duplicated: the caller is a roster, and a roster can name the same person twice while the
  // log and the endpoint disagree for a second about who has left.
  return [...new Set(requested.filter((id) => USER_ID_PATTERN.test(id)))];
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
 * Validates a group id, for the route that interpolates one into `GET /groups/{groupId}`.
 *
 * Stricter than `parseUserId` because it can afford to be: every group id VRChat has ever issued is
 * a `grp_` prefix and a UUID, with none of the legacy shapes that make user ids a character
 * allowlist rather than a pattern. What matters either way is that `/`, `?`, `#`, and `%` cannot
 * appear and turn one path segment into several.
 */
export function parseGroupId(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_group_id", "a group id is required");
  }
  if (!GROUP_ID_PATTERN.test(raw)) {
    throw new ControlError(400, "invalid_group_id", "that is not a VRChat group id");
  }
  return raw;
}

const GROUP_ID_PATTERN = /^grp_[0-9A-Za-z_-]{1,64}$/;

/**
 * Validates an avatar id, for the route that interpolates one into `GET /avatars/{avatarId}`.
 *
 * Same reasoning as {@link parseGroupId}: every avatar id VRChat has issued is `avtr_` plus a UUID,
 * and what has to hold either way is that `/`, `?`, `#` and `%` cannot appear and turn one path
 * segment into several.
 */
export function parseAvatarId(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_avatar_id", "an avatar id is required");
  }
  if (!AVATAR_ID_PATTERN.test(raw)) {
    throw new ControlError(400, "invalid_avatar_id", "that is not a VRChat avatar id");
  }
  return raw;
}

const AVATAR_ID_PATTERN = /^avtr_[0-9A-Za-z_-]{1,64}$/;

/**
 * Validates an image file id, for the route that sends one to **a third party**.
 *
 * Stricter than the other validators here, and for a different reason. Everywhere else the property
 * being defended is that one path segment cannot become several; here it is also that the only
 * thing that can ever leave this machine on that request is a VRChat file id — so the pattern is an
 * exact shape rather than a character allowlist, and `_` is deliberately absent after the prefix
 * because a VRChat file id is a UUID.
 */
export function parseImageFileId(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_file_id", "a file id is required");
  }
  if (!IMAGE_FILE_ID_PATTERN.test(raw)) {
    throw new ControlError(400, "invalid_file_id", "that is not a VRChat image file id");
  }
  return raw;
}

const IMAGE_FILE_ID_PATTERN = /^file_[0-9A-Za-z-]{1,64}$/;

/**
 * Validates the `:galleryId` path parameter, which is interpolated into
 * `GET /groups/{groupId}/galleries/{groupGalleryId}`.
 *
 * Deliberately looser than {@link parseGroupId}: the spec types `GroupGalleryId` as a bare string
 * and the ids VRChat issues today are `ggal_`-prefixed, but nothing documents that prefix, and a
 * validator asserting an undocumented shape breaks the day it changes. What actually has to hold is
 * the same thing that holds for a group id — `/`, `?`, `#` and `%` cannot appear and turn one path
 * segment into several.
 */
export function parseGalleryId(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_gallery_id", "a gallery id is required");
  }
  if (!GALLERY_ID_PATTERN.test(raw)) {
    throw new ControlError(400, "invalid_gallery_id", "that is not a VRChat gallery id");
  }
  return raw;
}

const GALLERY_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * The longest note accepted. VRChat's own `/userNotes` caps at 256 characters, and a local note
 * that cannot be synced later would be a note the user has to retype — so the local store adopts
 * the upstream limit now rather than growing data the sync cannot carry.
 */
export const MAX_NOTE_LENGTH = 256;

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

/** The Bun websocket handler for this app. `bind.ts` hands it to `Bun.serve`. */
export const controlWebSocketHandler = websocket;

/**
 * The `/app` surface for a daemon that has no grant store behind it.
 *
 * Every method refuses rather than being absent, so the sub-app is always mounted and always the
 * same type. The alternative — mounting it conditionally — would make `/app` a 404 in one build and
 * a 401 in another, and "the route does not exist" is a different and less honest answer than "you
 * are not authenticated", especially to a client trying to work out which it is.
 */
const NO_APP_ACCESS: AppApiDeps = {
  resolveGrant: async () => null,
  watchGrant: () => () => {},
  listSessions: async () => [],
  subscribeEvents: () => () => {},
  registerWebhook: () => Promise.reject(new Error("no grant store")),
  listWebhooks: async () => [],
  deleteWebhook: async () => false,
};

export function createControlApp({ port, deps, appApi, token }: ControlAppOptions) {
  const app = new Hono()
    .use(hostGuard(port))
    .use(originGuard(port))

    /*
     * The third-party surface, mounted **before** `sessionAuth` and therefore never reached by it.
     *
     * That ordering is the whole security model of this port, not an implementation detail. Hono
     * applies middleware in registration order, so `/app/…` authenticates itself against a proxy
     * grant and `/api/…` authenticates against the session token, and neither can ever accept the
     * other's credential. The alternative — one auth middleware that accepts both, plus a list of
     * which `/api/` routes an app may reach — fails open: the day someone adds a route and forgets
     * the list, a third-party app can read the user's whole account. This way a new `/api/` route
     * is app-unreachable by construction.
     *
     * Optional, because a Phase 1 test constructing this app has no grants to serve; absent, `/app`
     * simply does not exist and falls through to the same 404 as any other unknown path.
     */
    .route(APP_API_PREFIX, appApi ?? createAppApi({ deps: NO_APP_ACCESS }))

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

    /*
     * The three "do a thing to another person" actions the command palette has carried as stubs
     * since Phase 1. They sit beside `invite-self` because they are the same slot: an account in
     * the path, because *which* account acts is the whole question when two are signed in, and a
     * validated target because every one of these is interpolated into a VRChat path.
     */
    .post("/api/accounts/:id/invite", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const userId = parseUserId(stringField(body, "userId"));
      const target = parseInviteLocation(stringField(body, "location"));
      const messageSlot = parseSlot(body?.messageSlot, "messageSlot");
      await deps.inviteUserTo(c.req.param("id"), userId, target, messageSlot);
      return c.json({ status: "ok" as const });
    })

    .post("/api/accounts/:id/request-invite", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const userId = parseUserId(stringField(body, "userId"));
      const requestSlot = parseSlot(body?.requestSlot, "requestSlot");
      await deps.requestInviteFrom(c.req.param("id"), userId, requestSlot);
      return c.json({ status: "ok" as const });
    })

    .post("/api/accounts/:id/boop", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const userId = parseUserId(stringField(body, "userId"));
      await deps.boop(c.req.param("id"), userId);
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
      const accountId = nonEmpty(c.req.query("accountId"));

      // Rejected rather than clamped or ignored: a `sessionId` that failed to parse would
      // otherwise silently widen the query from one game client to every event in the database,
      // which looks like data corruption from the UI side.
      const rawSession = nonEmpty(c.req.query("sessionId"));
      let sessionId: number | undefined;
      if (rawSession !== undefined) {
        sessionId = integerParam(rawSession);
        if (sessionId === undefined || sessionId < 0) {
          throw new ControlError(400, "invalid_query", "sessionId must be a non-negative integer");
        }
      }

      const subjectId = nonEmpty(c.req.query("subjectId"));

      const selectors = [accountId, sessionId, subjectId].filter(
        (value) => value !== undefined,
      ).length;
      if (selectors > 1) {
        throw new ControlError(
          400,
          "invalid_query",
          "accountId, sessionId and subjectId are mutually exclusive",
        );
      }

      // Built in one expression rather than mutated into shape: `EventQuery` is a wire type and
      // wire types are `readonly`. Every field is spelled out because `exactOptionalPropertyTypes`
      // distinguishes "absent" from "present and undefined", and `listEvents` branches on absence.
      const query: EventQuery = {
        limit: clampLimit(c.req.query("limit")),
        accountId,
        sessionId,
        subjectId,
        kind: nonEmpty(c.req.query("kind")),
        kinds: csvParam(c.req.query("kinds")),
        families: csvParam(c.req.query("families")),
        search: nonEmpty(c.req.query("q")),
        before: integerParam(c.req.query("before")),
      };
      return c.json(await deps.listEvents(query));
    })

    /*
     * The filter vocabulary: what kinds are actually in this database, and how many of each.
     *
     * The feed used to build its family tabs by counting the page it had just fetched, which meant
     * a family only offered a tab once it happened to appear in the newest rows — and the tab then
     * disappeared as that row aged out. A filter list has to describe the whole store, not the
     * window, or picking a filter and finding nothing is indistinguishable from a bug.
     *
     * One `GROUP BY` over an indexed column, and no per-kind expiry arithmetic, which is what
     * makes this cheap enough to call on screen load where `GET /api/retention` would not be.
     */
    .get("/api/event-kinds", async (c) => c.json(await deps.listEventKinds()))

    /*
     * Attributes for many users in one request — the roster's fallback when VRChat will not
     * describe an instance, which is nearly always. Registered before `/api/users/:id` for
     * readability only; Hono matches the literal path and the parameterised one as distinct routes.
     */
    .get("/api/users", async (c) => {
      const ids = parseUserIds(c.req.query("ids"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listUsers(ids, accountId));
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
     * One group, for the group modal. Live every time — see {@link ControlDeps.getGroup} for why a
     * group is not cached the way a world is.
     */
    .get("/api/groups/:id", async (c) => {
      const groupId = parseGroupId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.getGroup(groupId, accountId));
    })

    /*
     * The four sub-resources a group *screen* — as against the group card — is built out of.
     *
     * All of them take `?accountId=` for the same reason `GET /api/groups/:id` does: which account
     * is asking changes what VRChat will hand over, up to and including refusing outright. Paging
     * follows the mutual-friends route exactly — `n` clamped, `offset` rejected when malformed —
     * because an ignored offset serves page one forever while the scroll counts up.
     */
    .get("/api/groups/:id/members", async (c) => {
      const groupId = parseGroupId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(
        await deps.listGroupMembers(groupId, accountId, {
          n: clampPageSize(c.req.query("n")),
          offset: parseOffset(c.req.query("offset")),
        }),
      );
    })

    .get("/api/groups/:id/posts", async (c) => {
      const groupId = parseGroupId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(
        await deps.listGroupPosts(groupId, accountId, {
          n: clampPageSize(c.req.query("n")),
          offset: parseOffset(c.req.query("offset")),
        }),
      );
    })

    /*
     * No `n` and no `offset`, because VRChat's own endpoint has neither — see `GroupInstanceList`.
     * Accepting them here would be a paging contract the daemon would have to fake by slicing.
     */
    .get("/api/groups/:id/instances", async (c) => {
      const groupId = parseGroupId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listGroupInstances(groupId, accountId));
    })

    /*
     * `/images` is a trailing segment vrc.zip adds; upstream the images *are* the gallery
     * (`GET /groups/{groupId}/galleries/{groupGalleryId}`). It is here because `…/galleries/:id`
     * with no suffix would read as "the gallery record", which is not a thing this API serves — the
     * gallery record already rode in on `GET /api/groups/:id`.
     */
    .get("/api/groups/:id/galleries/:galleryId/images", async (c) => {
      const groupId = parseGroupId(c.req.param("id"));
      const galleryId = parseGalleryId(c.req.param("galleryId"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(
        await deps.listGroupGalleryImages(groupId, galleryId, accountId, {
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
     * Avatar identity, in two steps because VRChat only gives us the first half.
     *
     * `by-file` is the third-party hop — see {@link ControlDeps.resolveAvatarByFile} and
     * `daemon/src/net/avatar-ids.ts` for what leaves the machine and how to switch it off. It takes
     * no `accountId`: the lookup carries no account, and adding one to the route would imply
     * otherwise.
     *
     * Registered before `/api/avatars/:id` for readability only — the two have different segment
     * counts, so Hono matches them as distinct routes and the order is not load-bearing.
     */
    .get("/api/avatars/by-file/:fileId", async (c) => {
      const fileId = parseImageFileId(c.req.param("fileId"));
      return c.json(await deps.resolveAvatarByFile(fileId));
    })

    .get("/api/avatars/:id", async (c) => {
      const avatarId = parseAvatarId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.getAvatar(avatarId, accountId));
    })

    /*
     * The instances of a world vrc.zip can see. Not paged, and not for the reason
     * `/api/groups/:id/instances` is not paged: there is no upstream call here at all. The answer
     * is derived from in-memory presence and the open sessions, both of which are bounded by the
     * friend list, so a page boundary would be a slice of a list that is already whole.
     */
    /*
     * The one write in the avatar routes, and a POST where upstream is a PUT.
     *
     * The account is in the query rather than assumed, matching `/api/accounts/:id/*`: which
     * account acts is the whole question when two are signed in. It carries no body, because the
     * two ids in the path and query are the entire request.
     */
    .post("/api/avatars/:id/select", async (c) => {
      const avatarId = parseAvatarId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      if (accountId === null) {
        throw new ControlError(
          400,
          "invalid_query",
          "accountId is required: wearing an avatar has to say which account wears it.",
        );
      }
      await deps.selectAvatar(avatarId, accountId);
      return c.json({ status: "ok" as const });
    })

    .get("/api/worlds/:id/instances", async (c) => {
      const worldId = parseWorldId(c.req.param("id"));
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listWorldInstances(worldId, accountId));
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

    /*
     * The inbox, paged and filtered the same way the feed is: `limit`/`before` for the cursor,
     * `types`/`q`/`seen` to narrow, all of it applied in SQL.
     *
     * `seen` is tri-state and the parsing says so: absent shows both, `seen=false` hides what has
     * been read. An unparseable value is treated as absent rather than as `false` — silently
     * hiding read notifications because a query string was malformed is the kind of wrong answer
     * that reads as data loss.
     */
    .get("/api/notifications", async (c) => {
      const query: NotificationQuery = {
        limit: clampLimit(c.req.query("limit")),
        accountId: nonEmpty(c.req.query("accountId")),
        types: csvParam(c.req.query("types")),
        seen: booleanParam(c.req.query("seen")),
        search: nonEmpty(c.req.query("q")),
        before: integerParam(c.req.query("before")),
      };
      return c.json(await deps.listNotifications(query));
    })

    .get("/api/notification-types", async (c) => c.json(await deps.listNotificationTypes()))

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

    /*
     * Consent. These three are the whole of the sheet: read what is pending, tell the daemon which
     * account the user picked, or refuse. Approval is deliberately *not* here — the approving
     * gesture is the user typing the code into the app, which lands on `:7774`. A button here that
     * approved directly would defeat the point of the code, which is to prove the person at this
     * screen is the person operating that app.
     */
    .get("/api/consent", async (c) => c.json(await deps.listPendingConsent()))

    .post("/api/consent/:id/account", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const accountId = typeof body?.accountId === "string" ? body.accountId : "";
      if (accountId === "") {
        throw new ControlError(400, "invalid_body", "accountId is required");
      }
      return c.json(await deps.setConsentAccount(c.req.param("id"), accountId));
    })

    .post("/api/consent/:id/deny", async (c) => {
      await deps.denyConsent(c.req.param("id"));
      return c.body(null, 204);
    })

    /*
     * Connected apps — the durable half of the same question the consent sheet asks. The sheet is
     * about one moment ("should this app get in"); this is about standing access ("what is still
     * in, and cut it off"). PLAN.md §Enforcement names the kill switch as a requirement rather than
     * a nicety: scopes alone do not stop an app misbehaving, and the user needs a way out that does
     * not involve deleting a database file.
     */
    .get("/api/apps", async (c) => c.json(await deps.listConnectedApps()))

    /*
     * What one app has done, as against what it is allowed to do. The scope list above is a
     * statement of permission; this is the record of use, and it is the half that tells a user
     * whether an app has been doing anything with the access it holds.
     *
     * `limit` and `before` follow `GET /api/events` exactly — same clamp, same "strictly older
     * than" cursor — so a list that pages here pages the way the feed already does.
     */
    .get("/api/apps/:id/audit", async (c) =>
      c.json(
        await deps.listAppAudit(c.req.param("id"), {
          limit: clampLimit(c.req.query("limit")),
          before: integerParam(c.req.query("before")),
        }),
      ),
    )

    /*
     * The per-app allowance for one risky scope. `PUT` with `{"limit": n}` sets it and
     * `{"limit": null}` clears it — clearing returns the scope to the build's default, which is why
     * this is not a DELETE: DELETE would read as "remove the budget", and there is no such state.
     */
    .put("/api/apps/:id/budgets/:scope", async (c) => {
      const body = await readJsonObject(c.req.raw);
      if (body === undefined) throw new ControlError(400, "invalid_body", "expected a JSON object");
      const raw = body.limit;
      if (raw !== null && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)) {
        throw new ControlError(
          400,
          "invalid_body",
          "limit must be a non-negative whole number, or null to use the default",
        );
      }
      return c.json(await deps.setAppBudget(c.req.param("id"), c.req.param("scope"), raw));
    })

    /*
     * Webhook oversight. Read and delete only — there is no route here that *creates* one, because
     * a webhook is something an app asks for through `/app/webhooks` after the user approved it at
     * consent. A create button on this side would be the user hand-configuring an outbound feed of
     * their own presence, which is a feature, not part of the app-access story this page tells.
     */
    .get("/api/webhooks", async (c) => c.json(await deps.listWebhooks()))

    .delete("/api/webhooks/:id", async (c) => {
      await deps.deleteWebhook(c.req.param("id"));
      return c.body(null, 204);
    })

    .post("/api/apps/:id/revoke", async (c) => {
      await deps.revokeConnectedApp(c.req.param("id"));
      return c.body(null, 204);
    })

    /*
     * Deliberately its own route rather than a flag on the one above. "Revoke everything" is a
     * different decision from "revoke this", and a client that meant one and sent the other because
     * a parameter was missing is a failure mode worth designing out.
     */
    .post("/api/apps/revoke-all", async (c) =>
      c.json({ revoked: await deps.revokeAllConnectedApps() }),
    )

    .get("/api/settings", async (c) => c.json(await deps.getSettings()))

    .put("/api/settings", async (c) => {
      const body = await readJsonObject(c.req.raw);
      if (body === undefined) throw new ControlError(400, "invalid_body", "expected a JSON object");
      return c.json(await deps.updateSettings(body));
    })

    /*
     * Retention — the one setting on this screen that deletes things.
     *
     * `PUT` is the same route whether it is saving or previewing, and `dryRun` picks. That is not
     * a shortcut: a preview computed by a different code path than the save is a preview that can
     * be wrong about the one thing it exists to be right about.
     */
    .get("/api/retention", async (c) => c.json(await deps.getRetention()))

    .put("/api/retention", async (c) => {
      const body = await readJsonObject(c.req.raw);
      if (body === undefined) throw new ControlError(400, "invalid_body", "expected a JSON object");
      return c.json(await deps.updateRetention(parseRetentionUpdate(body)));
    })

    .post("/api/retention/run", async (c) => c.json(await deps.runRetention()))

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

/**
 * A comma-separated list parameter, or `undefined` when nothing usable was given.
 *
 * Capped, deduplicated and empty-filtered. The cap is not ceremony: every entry becomes a bound
 * placeholder in the assembled `WHERE`, and SQLite has a hard limit on how many a statement may
 * carry. A filter with more than fifty kinds ticked is also not a filter.
 */
function csvParam(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const values = [...new Set(raw.split(",").map((value) => value.trim()))]
    .filter((value) => value !== "")
    .slice(0, 50);
  return values.length === 0 ? undefined : values;
}

/**
 * A tri-state boolean parameter: `true`, `false`, or absent.
 *
 * Anything unrecognised is absent rather than `false`. A filter that silently engages because a
 * query string was malformed hides rows, and hidden rows read as lost data.
 */
function booleanParam(raw: string | undefined): boolean | undefined {
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
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

/**
 * Validates a `PUT /api/retention` body.
 *
 * Every window is bounds-checked *here*, at the edge, rather than clamped further in. A clamp
 * would silently store something other than what the user typed, and the number they typed is the
 * number of days of their history they believe they are keeping.
 */
export function parseRetentionUpdate(body: Record<string, JsonValue>): RetentionUpdate {
  const update: {
    defaultRetainDays?: number;
    rules?: Record<string, number | null>;
    dryRun?: boolean;
  } = {};

  if (body.defaultRetainDays !== undefined) {
    update.defaultRetainDays = parseRetainDays(body.defaultRetainDays, RETENTION_DEFAULT_KEY);
  }

  const rules = body.rules;
  if (rules !== undefined) {
    if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
      throw new ControlError(400, "invalid_body", "rules must be an object");
    }
    const parsed: Record<string, number | null> = {};
    for (const [kind, value] of Object.entries(rules)) {
      if (kind === "" || kind.length > 64) {
        throw new ControlError(400, "invalid_body", "a rule key must be 1-64 characters");
      }
      // `null` is the delete verb, and it is the only non-number this accepts. `undefined` cannot
      // reach here from JSON, so an absent key really does mean "leave it alone".
      parsed[kind] = value === null ? null : parseRetainDays(value, kind);
    }
    update.rules = parsed;
  }

  if (body.dryRun !== undefined) {
    if (typeof body.dryRun !== "boolean") {
      throw new ControlError(400, "invalid_body", "dryRun must be a boolean");
    }
    update.dryRun = body.dryRun;
  }

  return update;
}

function parseRetainDays(value: JsonValue, kind: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < RETENTION_MIN_DAYS ||
    value > RETENTION_MAX_DAYS
  ) {
    throw new ControlError(
      400,
      "invalid_body",
      `"${kind}" must be a whole number of days between ${String(RETENTION_MIN_DAYS)} and ${String(RETENTION_MAX_DAYS)}`,
    );
  }
  return value;
}

/**
 * An optional invite-message slot.
 *
 * VRChat exposes twelve slots per message type and numbers them from zero. Rejected rather than
 * clamped: a slot the user did not mean sends *different words* in their name, which is not the
 * kind of mistake to paper over with a nearest-valid-value.
 */
export const MAX_INVITE_SLOT = 11;

function parseSlot(value: JsonValue | undefined, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_INVITE_SLOT
  ) {
    throw new ControlError(
      400,
      "invalid_body",
      `${field} must be a whole number between 0 and ${String(MAX_INVITE_SLOT)}`,
    );
  }
  return value;
}

function integerParam(raw: string | undefined): number | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
