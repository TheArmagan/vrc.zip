/**
 * The typed client for the local daemon's control API.
 *
 * This file is the UI's view of the daemon contract, and every screen reads its types from here.
 * It does not import from `daemon/` — the UI is a browser bundle and the daemon is a Bun program.
 * Shapes that both sides must agree on live in `@vrcz/shared` and are re-exported below, so a
 * screen still writes `from "$lib/api.ts"` and gets the shared definition rather than a copy.
 *
 * The event-kind vocabulary went first, because the hand-copied version had drifted: it was missing
 * ten kinds the daemon emits daily (`group.joined`, `instance.queue_ready`, `user.badge_assigned`
 * and the rest), and nothing could notice while every producer typed its kinds as bare `string`.
 *
 * Shapes still written down here were read off `daemon/src/servers/control.ts` and
 * `daemon/src/wiring/control-deps.ts`, not guessed. All timestamps are integer unix milliseconds.
 */

import {
  type AccountConnection,
  type AppAuditEntry,
  type AuditOutcome,
  type AvatarDetail,
  type AvatarFileResolution,
  type ControlAccount,
  type DaemonStatus,
  EVENT_FAMILIES,
  type EventFamily,
  type EventKind,
  type EventKindCount,
  type EventQuery,
  type FeedEvent,
  type FriendPresence,
  type FriendStatus,
  familyOf,
  fileIdFromImageUrl,
  type GameSession,
  type Graph,
  type GraphCreate,
  type GraphExport,
  type GraphImportResult,
  type GraphMemoryEntry,
  type GraphRunSummary,
  type GraphStoreEntry,
  type GraphStoreSummary,
  type GraphSummary,
  type GraphTemplate,
  type GraphUpdate,
  type GroupGalleryImagePage,
  type GroupGalleryImageSummary,
  type GroupGallerySummary,
  type GroupInstanceList,
  type GroupInstanceSummary,
  type GroupMemberPage,
  type GroupMemberSummary,
  type GroupPostPage,
  type GroupPostSummary,
  type KnownEventKind,
  type LoginResult,
  type NodeTypeSummary,
  type RateLimitSnapshot,
  type RateSeries,
  type RetentionKindStat,
  type RetentionRule,
  type RetentionRunResult,
  type RetentionSettings,
  type RetentionSource,
  type RetentionUpdate,
  type TwoFactorMethod,
  type VerifyTwoFactorResult,
  type WebhookSummary,
  type WorldInstanceList,
  type WorldInstanceOccupant,
  type WorldInstanceSource,
  type WorldInstanceSummary,
} from "@vrcz/shared";
import { API_BASE } from "./config.ts";

export type {
  Graph,
  GraphCreate,
  GraphDocument,
  GraphEdge,
  GraphExport,
  GraphImportResult,
  GraphMemoryEntry,
  GraphNode,
  GraphRunSummary,
  GraphStoreEntry,
  GraphStoreSummary,
  GraphSummary,
  GraphTemplate,
  GraphUpdate,
  NodeTypeSummary,
  RateSeries,
} from "@vrcz/shared";

import { getToken } from "./session.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/*
 * The wire shapes and the bus-kind vocabulary are `@vrcz/shared`'s, re-exported under the names
 * this app already uses so every screen keeps importing them from here.
 *
 * The two aliases are kept rather than renamed through forty screens: `Friend` reads better than
 * `FriendPresence` inside a friends list, and the drift the separate names used to hide is gone now
 * that both sides resolve to one declaration. See `packages/shared/src/wire.ts` for what the two
 * hand-copied sets had drifted into.
 *
 * `EventKind` stays widened (`KnownEventKind | (string & {})`) on purpose: an event from a daemon
 * newer than this bundle must still list in the feed and still match a filter rather than vanish.
 */
export {
  type AccountConnection,
  type AppAuditEntry,
  type AuditOutcome,
  type AvatarDetail,
  type AvatarFileResolution,
  type ControlAccount as Account,
  type DaemonStatus,
  EVENT_FAMILIES,
  type EventFamily,
  type EventKind,
  type EventKindCount,
  type EventQuery,
  type FeedEvent,
  type FriendPresence as Friend,
  type FriendStatus,
  familyOf,
  fileIdFromImageUrl,
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
  type KnownEventKind,
  type LoginResult,
  type RateLimitSnapshot as RateLimitStatus,
  type RetentionKindStat,
  type RetentionRule,
  type RetentionRunResult,
  type RetentionSettings,
  type RetentionSource,
  type RetentionUpdate,
  type TwoFactorMethod,
  type VerifyTwoFactorResult,
  type WebhookSummary,
  type WorldInstanceList,
  type WorldInstanceOccupant,
  type WorldInstanceSource,
  type WorldInstanceSummary,
};

/** Local aliases so this module's own signatures read the way its callers do. */
type Account = ControlAccount;
type Friend = FriendPresence;

/**
 * One VRChat user, merged from VRChat's own profile and vrc.zip's local record of them.
 * Read off `UserDetail` in `daemon/src/servers/control.ts`.
 *
 * `GET /users/{id}` returns *fewer fields* for a caller who is not a friend — see PROGRESS.md
 * §Gotchas — which is why `accountId` is part of the answer rather than a detail of how it was
 * fetched, and why `isFriend` is worth carrying: it is the daemon saying plainly which of the two
 * shapes this is, so the modal never has to infer it from a run of empty fields.
 *
 * `friendedAt` and `note` are the two fields VRChat has never heard of. They come from vrc.zip's
 * own store, and they are what makes this screen worth having.
 */
export interface UserProfile {
  readonly id: string;
  readonly displayName: string;
  /** Whose eyes this was seen through. */
  readonly accountId: string;
  /** Unix ms the VRChat body was fetched. */
  readonly fetchedAt: number;
  /** True when the daemon answered from `user_cache` rather than a live fetch. */
  readonly cached: boolean;
  readonly bio: string | null;
  readonly bioLinks: readonly string[];
  readonly pronouns: string | null;
  readonly status: FriendStatus;
  readonly statusDescription: string | null;
  /** VRChat's coarser presence field (`online`/`active`/`offline`), distinct from `status`. */
  readonly state: string | null;
  /** VRChat's own tag strings (`system_trust_veteran`, `language_eng`, …). An open set. */
  readonly tags: readonly string[];
  /** Resolved out of `tags` by the daemon: `trusted`, `known`, `user`, `visitor`, … */
  readonly trustLevel: string;
  readonly platform: string | null;
  readonly lastPlatform: string | null;
  /** `offline`, `private`, `traveling`, `""`, or a full instance id — VRChat's raw string. */
  readonly location: string | null;
  readonly worldId: string | null;
  readonly isFriend: boolean;
  /** Unix ms. VRChat sends a date string; the daemon converts, so the wire stays integer ms. */
  readonly dateJoined: number | null;
  readonly lastLogin: number | null;
  /** Absolute VRChat user-icon URL, or null. Load it through `imageUrl()`, never directly. */
  readonly iconUrl: string | null;
  /**
   * The **non-thumbnail** original of `iconUrl`, or null — what "Open profile image" opens.
   *
   * Never a fallback to the thumbnail: null means there is no full-size original, and the action
   * hides rather than opening a 256px crop that looks like it worked. Same `imageUrl()` route as
   * every other VRChat asset, because a browser cannot fetch these URLs itself.
   */
  readonly iconUrlFull: string | null;
  /**
   * The avatar this user is *wearing*, as VRChat's picture of it, or null.
   *
   * Not the same claim as `iconUrl`, even when they happen to be the same URL: that one is "the
   * best picture of this person" and this one is "the thing they have on". Only this may be used to
   * look an avatar up, because VRChat exposes no avatar id on a public user and this URL's file id
   * is the only handle there is.
   */
  readonly currentAvatarImageUrl: string | null;
  readonly currentAvatarThumbnailImageUrl: string | null;
  /** VRChat's content tags for the worn avatar. An open set. */
  readonly currentAvatarTags: readonly string[];
  /** Unix ms this account first recorded the friendship. Null when never friends. */
  readonly friendedAt: number | null;
  /** The local, private note. Null when unset. */
  readonly note: string | null;
  readonly noteUpdatedAt: number | null;

  /**
   * VRChat's age-verification state: `verified`, `18+`, `hidden`, or null. `hidden` means the
   * user has one and chose not to publish it, which is **not** the same as not having one — the
   * UI must not render "unverified" for it, and does not. See `ageVerifiedLabel` in `format.ts`.
   */
  readonly ageVerificationStatus: string | null;
  readonly ageVerified: boolean;
  /**
   * The profile banner, an absolute VRChat URL — through `imageUrl()`, never directly.
   *
   * Null is the common case: most users have never set one. The header is built to look finished
   * without it rather than to leave a gap where an image should have been.
   */
  readonly bannerUrl: string | null;
  /** VRChat's own classification of the banner it sent (`profilePicOverride`, `none`, …). */
  readonly bannerType: string | null;
  /**
   * The group this user chose to display beside their name, or null.
   *
   * **Null is the ordinary answer** — most people represent no group — and it arrives on a plain
   * 200. It is not an empty state to apologise for, and not a reason to draw a placeholder.
   */
  readonly representedGroup: UserGroup | null;
  /**
   * The profile page's own half of this user — badges, languages, VRC+ — or **null when the
   * daemon got no answer for it**.
   *
   * Null is "unknown", not "empty": it is a second, best-effort call behind the profile, and the
   * modal must render without it rather than drawing an empty badge row that reads as a claim
   * this person has none. Nothing presence-shaped lives here; that all comes from the fields
   * above. See `UserProfileCard`.
   */
  readonly profileCard: UserProfileCard | null;
}

/** One VRChat badge. `imageUrl` goes through `imageUrl()` like every other VRChat asset. */
export interface UserBadge {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  /** The user features this one on their profile. The daemon sorts these first. */
  readonly showcased: boolean;
}

/**
 * What `GET /profile/{id}` adds to the user record: the decoration VRChat's profile page shows.
 *
 * Every field here is safe to render as absent. An account with no badges, no published
 * languages and no VRC+ is completely ordinary.
 */
export interface UserProfileCard {
  /** VRChat's short codes (`eng`, `jpn`, …) — see `languageLabel` in `format.ts`. */
  readonly languages: readonly string[];
  readonly badges: readonly UserBadge[];
  readonly hasVrcPlus: boolean;
  /** A CSS colour for the profile header, or null. */
  readonly bannerColor: string | null;
}

/**
 * The identifier is `id`. VRChat's own payload calls it `groupId` and additionally carries a
 * separate `id` meaning the *membership row*, which is a different thing entirely — the daemon
 * normalises that away and sends the group's own id as `id`, like every other entity here.
 *
 * This mismatched once and it is worth remembering how it presented: the daemon sent `id`, this
 * type said `groupId`, and the Groups tab keyed its list on `group.groupId`. Every key was
 * `undefined`, which Svelte 5 treats as a hard error, so the tab died while the network tab showed
 * a perfectly good 200. A wire contract that only the type system believes is not a contract.
 */
export interface UserGroup {
  readonly id: string;
  readonly name: string;
  /** The short code shown as `NAME.1234`, or null when VRChat did not send one. */
  readonly shortCode: string | null;
  readonly discriminator: string | null;
  readonly description: string | null;
  readonly memberCount: number | null;
  /** Absolute VRChat URLs. Load through `imageUrl()`, never directly. */
  readonly iconUrl: string | null;
  readonly bannerUrl: string | null;
  /** VRChat's group privacy string — `default` or `private`. Null when it did not say. */
  readonly privacy: string | null;
  /** The owner's `usr_…`, or null. VRChat sends no display name with it — see `GroupModal`. */
  readonly ownerId: string | null;
  readonly isRepresenting: boolean;
  /**
   * The account this list was read through is in this group too — VRChat's own `mutualGroup`.
   *
   * Only `GET /users/{id}/groups` carries it, so it is false on a group that arrived any other way
   * (a represented badge, `GET /groups/{id}`). False therefore means "not claimed here", and the
   * badge is rendered only in the Groups tab, which is the one place the claim is made.
   */
  readonly mutualGroup: boolean;
}

/**
 * One group in full — a `UserGroup` plus everything only `GET /groups/{id}` carries.
 *
 * It extends the summary rather than restating it, which is what lets the modal paint from a badge
 * or a list row the instant it opens and fill the rest in when the fetch lands. Two shapes
 * overlapping by nine fields would eventually disagree about one of them.
 */
export interface GroupDetail extends UserGroup {
  /** Integer unix ms, or null. The daemon converts; VRChat's own ISO string never reaches here. */
  readonly createdAt: number | null;
  /**
   * Members online now, against `memberCount` for the total.
   *
   * VRChat recomputes this on its own schedule and says when in `memberCountSyncedAt`, which is why
   * the modal prints the age beside it — a live-looking number with no age reads as this second's.
   */
  readonly onlineMemberCount: number | null;
  readonly memberCountSyncedAt: number | null;
  /** The group's rules, author-written, newlines and all. */
  readonly rules: string | null;
  readonly links: readonly string[];
  /** Three-letter language codes, as VRChat stores them. */
  readonly languages: readonly string[];
  /** VRChat's own tags, its `system_` bookkeeping ones included. */
  readonly tags: readonly string[];
  readonly isVerified: boolean;
  /** `open`, `invite`, `request`, `closed` — how one would join, in VRChat's word. */
  readonly joinState: string | null;
  /**
   * The *asking account's* standing: `member`, `requested`, `invited`, `userblocked`, or null.
   *
   * A statement about the viewer rather than about the group, so it moves when `accountId` does.
   */
  readonly membershipStatus: string | null;
  /**
   * The group's galleries.
   *
   * Rides in on the group record itself rather than costing a request of its own — VRChat puts it
   * on the group body. The *images* in each are paged separately.
   */
  readonly galleries: readonly GroupGallerySummary[];
}

/** A friend the asking account and the viewed user have in common. */
export interface MutualFriend {
  readonly id: string;
  readonly displayName: string;
  /** Resolved by the daemon out of VRChat's tags, the same way `UserProfile.trustLevel` is. */
  readonly trustLevel: string;
  readonly status: FriendStatus;
  readonly iconUrl: string | null;
}

/**
 * One page of mutual friends.
 *
 * Paged on purpose: two people with a thousand friends each have a mutual list nobody wants
 * fetched in one breath, and the daemon walks a friend list to compute it. `hasMore` is the
 * daemon's word for it, not a guess from the page length.
 */
export interface MutualFriendPage {
  readonly users: readonly MutualFriend[];
  readonly hasMore: boolean;
}

/** The window into the mutual-friends list. `n` is VRChat's own name for a page size. */
export interface MutualFriendQuery {
  readonly accountId?: string | undefined;
  readonly n?: number | undefined;
  readonly offset?: number | undefined;
}

/** What `PUT /api/users/:id/note` answers with. `note` is null when the note was cleared. */
export interface UserNote {
  readonly accountId: string;
  readonly userId: string;
  readonly note: string | null;
  readonly updatedAt: number | null;
}

/** The daemon's cap (`MAX_NOTE_LENGTH`). Enforced here too, so the 400 is never the first hint. */
export const MAX_NOTE_LENGTH = 256;

/**
 * One row of a VRChat notification inbox, as the daemon stores it.
 *
 * Rows are never deleted — VRChat's `clear-notification` frame carries no content at all, so
 * deleting on it would mean guessing which rows it meant. `seen` is therefore the only thing that
 * changes, and the screen filters on it rather than waiting for rows to disappear.
 */
export interface NotificationItem {
  readonly id: string;
  readonly accountId: string;
  readonly ts: number;
  /**
   * VRChat's own type string: `friendRequest`, `invite`, `requestInvite`, `message`, `votetokick`,
   * group announcements, and whatever they add next. An open set — unknown types render
   * generically rather than being dropped.
   */
  readonly type: string;
  readonly senderUserId: string | null;
  readonly senderDisplayName: string | null;
  readonly message: string | null;
  readonly seen: boolean;
  readonly data: unknown;
}

/**
 * How the inbox is narrowed and paged. Read off `NotificationQuery` in
 * `daemon/src/servers/control.ts`.
 *
 * Every field narrows, and every one of them is applied in SQL. The screen used to filter a fixed
 * fifty-per-account window in the browser, which meant "show read" and the account filter searched
 * only the newest rows and nothing older could be reached at all.
 */
export interface NotificationQuery {
  readonly accountId?: string | undefined;
  readonly types?: readonly string[] | undefined;
  /** `false` hides what has been read. Absent shows both. */
  readonly seen?: boolean | undefined;
  readonly search?: string | undefined;
  readonly limit?: number | undefined;
  /** Unix milliseconds; return notifications strictly older than this. */
  readonly before?: number | undefined;
}

/** One entry of `GET /api/notification-types`. */
export interface NotificationTypeCount {
  readonly type: string;
  readonly count: number;
}

/**
 * Just enough of a world to render `wrld_0ae3e886-52e…` as somewhere a person has heard of.
 *
 * The shape the **batch** resolver serves, and small on purpose: a feed page is a hundred rows and
 * a row needs a name, a thumbnail and an author — not a tag list and a visit count a hundred times
 * over. Read off `WorldSummary` in `daemon/src/servers/control.ts`.
 */
export interface WorldSummary {
  readonly id: string;
  /** The daemon falls back to the id, so this is never empty. */
  readonly name: string;
  /** Absolute VRChat URL. Never an `<img src>` — run it through `imageUrl()`. */
  readonly thumbnailImageUrl: string | null;
  readonly authorName: string | null;
  readonly capacity: number | null;
}

/** The full world record, for the world modal. All timestamps are integer unix milliseconds. */
export interface WorldDetail extends WorldSummary {
  readonly description: string | null;
  readonly authorId: string | null;
  /** Absolute VRChat URL. Through `imageUrl()`, never directly. */
  readonly imageUrl: string | null;
  readonly recommendedCapacity: number | null;
  /** VRChat's own tag strings (`author_tag_…`, `system_approved`, …). An open set. */
  readonly tags: readonly string[];
  /** `public`, `private`, `hidden` — VRChat's word for who may find this world. */
  readonly releaseStatus: string | null;
  readonly visits: number | null;
  readonly favorites: number | null;
  /** VRChat's own metrics. Passed through verbatim; vrc.zip derives nothing from them. */
  readonly heat: number | null;
  readonly popularity: number | null;
  /**
   * How many people are in this world across every instance, as of `fetchedAt` — which under the
   * daemon's cache TTL can be hours old. For "who is in *this* instance", read the instance.
   */
  readonly occupants: number | null;
  /** Null for an unpublished world — VRChat sends the literal string `"none"`, the daemon nulls it. */
  readonly publicationDate: number | null;
  readonly labsPublicationDate: number | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly version: number | null;
  readonly fetchedAt: number;
  /** True when the daemon answered from `world_cache` rather than a live fetch. */
  readonly cached: boolean;
}

/** The most ids `GET /api/worlds` accepts at once — the daemon 400s on more. */
export const MAX_WORLD_IDS = 50;

/** One instance's own record: the live counts, the access type, the region. */
export interface InstanceInfo {
  readonly worldId: string;
  /** The instance id *with* its tags, as VRChat quotes it. */
  readonly instanceId: string;
  /**
   * The name whoever opened the instance gave it, or null. Group instances are the case that
   * matters: "Movie Night" is what the people in the room call it, and the instance number is not.
   */
  readonly displayName: string | null;
  /** VRChat's own `name`, usually the instance number again. Rarely worth printing. */
  readonly name: string | null;
  /** `public`, `hidden`, `friends`, `private`, `group` — VRChat's own word, not `parseLocation`'s. */
  readonly type: string | null;
  readonly ownerId: string | null;
  readonly region: string | null;
  readonly capacity: number | null;
  readonly userCount: number | null;
  /** VRChat sends both `userCount` and `n_users` and they can disagree; both come through. */
  readonly nUsers: number | null;
  readonly full: boolean;
  readonly canRequestInvite: boolean;
  /** Unix ms, or null while the instance is open. */
  readonly closedAt: number | null;
  readonly hardClose: boolean | null;
  readonly queueEnabled: boolean;
  readonly queueSize: number | null;
  readonly tags: readonly string[];
  readonly active: boolean;
  /** Free: VRChat embeds the whole world record in the instance response. */
  readonly world: WorldSummary | null;
}

/**
 * The answer to `GET /api/instances`.
 *
 * Shaped like `InstanceUsers`, `unavailable` included, so callers branch the same way on both.
 * Two upstream answers land in `unavailable` and **neither is a failure**: a closed instance 404s
 * — every instance ends that way — and an id VRChat dislikes comes back as a literal `null` body
 * with a 200.
 */
export interface InstanceDetail {
  readonly location: string;
  readonly fetchedAt: number;
  readonly source: "instance" | "unavailable";
  readonly instance: InstanceInfo | null;
}

/**
 * One app waiting at the consent sheet. See `PLAN.md` §Phase 2 "Pending consent".
 *
 * **`code` is the point of the screen.** The user reads it here and types it into the app, and that
 * gesture is the consent — it proves the person operating the app is the person at this screen. It
 * is never sent to the app.
 */
export interface PendingConsent {
  readonly id: string;
  /** Null when the app asked the user to choose, or named an account not added yet. */
  readonly accountId: string | null;
  readonly accountName: string | null;
  /** What the app typed in the username field, shown verbatim so the user recognises it. */
  readonly requestedUsername: string;
  readonly app: { readonly name: string; readonly version: string; readonly contact: string };
  readonly scopes: readonly ConsentScope[];
  /** The app already holds a grant and is asking for more; the sheet leads with the new ones. */
  readonly escalation: boolean;
  readonly code: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ConsentScope {
  readonly scope: string;
  readonly description: string;
  /** Shown in its own block, and never reachable through a wildcard request. */
  readonly dangerous: boolean;
  /** False when the app already holds it — an escalation greys those rather than hiding them. */
  readonly isNew: boolean;
}

/**
 * One app holding a live grant, as the Connected apps page renders it.
 *
 * **Carries no token and no code.** The grant's token is stored hashed and cannot be handed back
 * even by the daemon; this page answers "who has access to what, and since when", which needs none
 * of it. `PendingConsent` above is the one shape in this file that holds a secret, and it is
 * transient by design.
 */
export interface ConnectedApp {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly app: { readonly name: string; readonly version: string; readonly contact: string };
  readonly scopes: readonly ConsentScope[];
  readonly createdAt: number;
  /** When the app last called through the mirror. Null if it never has. */
  readonly lastUsedAt: number | null;
  /** Live pipeline sockets this grant holds right now. */
  readonly liveSockets: number;
  /** A minute of one-second request counts, oldest first. Seeds the card's sparkline. */
  readonly rate: RateSeries;
  /**
   * The three risky scopes' hourly allowances, and what this app has spent against each.
   *
   * All three are always present, including scopes the app does not hold — `granted` says which.
   * A row that vanished for an app without the scope would hide the control exactly when someone
   * wants to confirm it is closed.
   */
  readonly budgets: readonly AppBudget[];
}

/**
 * One installed plugin, as the plugins page renders it.
 *
 * `scopes` and `accountIds` are what the **grant** carries, not what the manifest asked for. The
 * difference is the whole point of the consent sheet: a user who unticked something must see the
 * narrower list here, or the page is reporting the request rather than the approval.
 */
export interface InstalledPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  /** The supervisor's own word: `idle`, `starting`, `running`, `backoff`, `disabled`, … */
  readonly state: string;
  readonly installedAt: number;
  readonly disabledReason: string | null;
  /** `user` or `crash-loop` — whether a person or the daemon turned it off. */
  readonly disabledBy: string | null;
  readonly restarts: number;
  readonly rssBytes: number | null;
  readonly lastFailure: string | null;
  /**
   * Why this plugin's bundle would not load, when it would not.
   *
   * Distinct from `disabledReason`: a tampered artifact is not a disable, it is a refusal to run a
   * file that no longer matches the hash it was installed under.
   */
  readonly refusal: string | null;
  readonly scopes: readonly string[];
  readonly accountIds: readonly string[];
  /**
   * The three risky scopes, always all three.
   *
   * Present even for scopes this plugin was not granted — `granted` says which — because a row that
   * vanished would hide the control exactly when someone wants to confirm it is closed.
   */
  readonly budgets: readonly PluginBudget[];
  /**
   * What the plugin declared it contributes.
   *
   * Present whether or not it is running — a sidebar entry for a stopped plugin is how someone
   * notices that it stopped, rather than the entry silently vanishing.
   */
  readonly panels: readonly { id: string; title: string; placement: string }[];
  readonly commands: readonly { id: string; title: string; description: string | null }[];
}

/**
 * One panel a plugin is drawing.
 *
 * `tree` is typed loosely on the wire and cast to `UINode` by the renderer, which imports the real
 * type from `@vrcz/plugin-api/ui`. It has already been validated by the daemon.
 */
export interface PluginPanel {
  readonly pluginId: string;
  readonly panelId: string;
  readonly tree: unknown;
  readonly updatedAt: number;
}

/** One risky scope on a plugin's card: what it has spent this hour, and whether it is shadowed. */
export interface PluginBudget {
  readonly scope: string;
  readonly description: string;
  readonly granted: boolean;
  readonly used: number;
  /** Null for a scope carrying no budget at all. */
  readonly limit: number | null;
  readonly windowMs: number;
  /** True while calls under this scope would be logged and not performed. */
  readonly dryRun: boolean;
}

/**
 * One install waiting for an answer.
 *
 * The request is **parked on a socket** while this exists: the daemon's `POST /api/plugins` returns
 * only once this is approved or denied, or five minutes pass. So a sheet that renders this and
 * never answers it is a sheet that times the user's install out.
 */
export interface PendingPluginConsent {
  readonly id: string;
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly description: string | null;
  /** Where it is being installed from, so "which copy is this" has an answer. */
  readonly source: string;
  readonly requestedAt: number;
  readonly isUpdate: boolean;
  /**
   * Every scope requested, described and flagged — the same shape the app consent sheet renders.
   *
   * `isNew` is the escalation highlight: on an update it marks what the last approved grant did not
   * have, and on a first install nothing is new.
   */
  readonly scopes: readonly ConsentScope[];
  readonly capabilities: readonly ConsentScope[];
  readonly events: readonly string[];
  readonly fetchDomains: readonly string[];
  readonly accountMode: string;
  readonly accountsOptional: boolean;
  readonly performance: string;
}

/** What the sheet sends back. Every list narrows the request; none may exceed it. */
export interface PluginConsentChoice {
  readonly accountIds: readonly string[];
  /** Omit for "everything asked for". `[]` means none of it — the two are not the same. */
  readonly scopes?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly events?: readonly string[];
}

/** One risky scope's hourly allowance for one app, as the Connected apps card edits it. */
export interface AppBudget {
  readonly scope: string;
  readonly description: string;
  /** Calls permitted per rolling hour. `0` means never. */
  readonly limit: number;
  /** What this build ships, so "Reset" can say what it goes back to. */
  readonly defaultLimit: number;
  /** True when `limit` was set here rather than inherited from `defaultLimit`. */
  readonly overridden: boolean;
  /** Calls of this scope that reached VRChat inside the current hour. */
  readonly used: number;
  readonly granted: boolean;
}

export interface SettingsPorts {
  readonly ui: number;
  readonly proxy: number;
  readonly control: number;
}

export interface Settings {
  /**
   * The contact address VRChat sees in the User-Agent. First-run critical: the daemon refuses to
   * talk to VRChat at all until this is set, and `POST /api/accounts/login` 409s with
   * `setup_required`.
   */
  readonly contact: string;
  readonly ports: SettingsPorts;
  /** Overrides log discovery. Empty means "whatever discovery found". */
  readonly logDirectories: readonly string[];
  readonly openBrowserOnStart: boolean;
  /**
   * Whether the daemon may ask avtr.zip to turn an image file id into an avatar id.
   *
   * The only request vrc.zip makes to anything other than VRChat, which is why it is a setting at
   * all rather than a detail. VRChat exposes no avatar id on a public user, so without it a feed
   * row can say "switched avatar" and nothing more. See `daemon/src/net/avatar-ids.ts`.
   */
  readonly resolveAvatarIds: boolean;
  /**
   * Whether vrc.zip is registered to start when Windows does.
   *
   * Not stored in `settings.json` like the rest of this object, and the difference shows here: it
   * is a registry value the user can clear from Task Manager's Startup tab, so the daemon reads it
   * live on every `GET` rather than remembering what it last wrote.
   */
  readonly startWithWindows: boolean;
  /** False from a source checkout and everywhere that is not Windows. */
  readonly startWithWindowsSupported: boolean;
  /**
   * Why the switch will not move, in a sentence meant to be shown.
   *
   * Covers two different situations on purpose: a build that can never do this (running from
   * source), and a build that could but just refused, which is what running from Downloads gets.
   * Null when there is nothing to say.
   */
  readonly startWithWindowsReason: string | null;
  /** Whether this build can copy itself somewhere permanent. Packaged Windows builds only. */
  readonly installSupported: boolean;
  /** Whether the running process *is* the copy under `%LOCALAPPDATA%`. */
  readonly installed: boolean;
  /** Where an installed copy would live, so the screen can name it before installing. */
  readonly installPath: string | null;
  /**
   * The version of the installed copy, or null when there is not one.
   *
   * Distinguishes "nothing is installed" from "something older is installed and you are running a
   * newer build", which are two situations that want different words on the same button. vrc.zip
   * does not update itself, so the second is a thing the user has to be told about.
   */
  readonly installedVersion: string | null;
}

/** What `POST /api/settings/install` answers with. */
export interface InstallReport {
  readonly ok: boolean;
  /** What went wrong, or what is still not done. Null when it all worked. */
  readonly reason: string | null;
  readonly path: string | null;
}

/** The subset of `Settings` that `PUT /api/settings` accepts. Ports are read-only over the wire. */
export interface SettingsPatch {
  readonly contact?: string;
  readonly logDirectories?: readonly string[];
  readonly openBrowserOnStart?: boolean;
  readonly resolveAvatarIds?: boolean;
  readonly startWithWindows?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure this client can produce, tagged so screens branch on a field instead of
 * string-matching a message. `offline` means the request never reached a server at all — that is
 * the only state that earns the full-screen "daemon not running" treatment.
 */
export type ApiErrorKind = "offline" | "unauthorized" | "http" | "malformed";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** The daemon's machine-readable code — the `error` field of its JSON error body. */
  readonly code: string | null;

  constructor(kind: ApiErrorKind, message: string, status: number | null, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.kind === "offline";
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * True for the 503 `GET /api/users/:id` answers with when no account is signed in.
 *
 * This is a normal state, not a failure: a user profile can only be read through somebody's
 * credentials, and vrc.zip may hold none that are online. Callers say so in words rather than
 * showing an error.
 */
export function isNoAccountOnline(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

/** True for a 404 — the daemon looked and VRChat does not know that user id. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * True for a 403 — the account asking is not allowed to see this, and asking again will not help.
 *
 * Distinct from an error on purpose. Most VRChat groups show their member list only to members, so
 * this is the ordinary answer for a group you have not joined: a rule about who may look, not a
 * fault. Callers say "members only" and offer no retry, because a retry cannot acquire membership.
 */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** True for the 409 the daemon returns when no contact address has been configured yet. */
export function isSetupRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "setup_required";
}

/** A human-facing sentence for any thrown value, so no screen ever renders `[object Object]`. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Notified when the daemon's reachability flips, so the shell can swap in the offline screen. */
type ReachabilityListener = (reachable: boolean) => void;

const reachabilityListeners = new Set<ReachabilityListener>();
let lastReachable: boolean | null = null;

export function onReachabilityChange(listener: ReachabilityListener): () => void {
  reachabilityListeners.add(listener);
  return () => {
    reachabilityListeners.delete(listener);
  };
}

function reportReachable(reachable: boolean): void {
  if (lastReachable === reachable) return;
  lastReachable = reachable;
  for (const listener of reachabilityListeners) listener(reachable);
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const base = `${API_BASE}${path}`;
  if (query === undefined) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === "" ? base : `${base}?${qs}`;
}

/**
 * The same-origin path that serves a VRChat user icon.
 *
 * VRChat's image host requires the owning account's auth cookie and a User-Agent the browser is
 * not allowed to set, so an `<img src={account.iconUrl}>` gets a 401/403 every time. The daemon
 * fetches the bytes with those headers attached and streams them back from `GET /api/image`, which
 * is same-origin and therefore carries the page's `vrcz_session` cookie automatically.
 *
 * Returns `undefined` for a missing icon so the value can be handed straight to `<AvatarImage>` —
 * bits-ui treats a falsy `src` as a load error and leaves the initials fallback in place.
 */
export function imageUrl(iconUrl: string | null | undefined): string | undefined {
  if (iconUrl === null || iconUrl === undefined || iconUrl === "") return undefined;
  return buildUrl("/image", { url: iconUrl });
}

/** The daemon's error body is `{ error: <code>, message: <sentence> }`. */
async function readErrorBody(
  response: Response,
): Promise<{ message: string; code: string | null }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const code =
        typeof record.error === "string"
          ? record.error
          : typeof record.code === "string"
            ? record.code
            : null;
      const message = typeof record.message === "string" ? record.message : null;
      if (message !== null) return { message, code };
      if (code !== null) return { message: code, code };
    }
  } catch {
    /* not JSON — fall through to the status line */
  }
  return { message: response.statusText || `HTTP ${String(response.status)}`, code: null };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    // The UI port hands out an HttpOnly `vrcz_session` cookie on first navigation; sending it
    // keeps requests authenticated even if the in-memory token is ever lost.
    credentials: "same-origin",
  };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (cause) {
    // An abort is the caller withdrawing, not the daemon dying. Reporting it as unreachable
    // would flash the offline screen every time a screen unmounts with a request in flight.
    if (isAbort(cause)) throw cause;
    reportReachable(false);
    throw new ApiError("offline", "The vrc.zip daemon is not reachable.", null, null);
  }

  reportReachable(true);

  if (response.status === 401 || response.status === 403) {
    // The token is deliberately *not* discarded here. It arrived in the launch URL and cannot be
    // re-obtained from inside the page, so throwing it away turns a transient 401 into a dead tab.
    const { message, code } = await readErrorBody(response);
    throw new ApiError("unauthorized", message, response.status, code);
  }

  if (!response.ok) {
    const { message, code } = await readErrorBody(response);
    throw new ApiError("http", message, response.status, code);
  }

  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      "malformed",
      "The daemon sent a response this build cannot read.",
      response.status,
      null,
    );
  }
}

/** One person as VRChat describes them, scoped to the instance that was asked about. */
export interface InstanceUser {
  readonly id: string;
  readonly displayName: string;
  /** Absolute VRChat URL. Never an `<img src>` — run it through `imageUrl()` from `api.ts`. */
  readonly iconUrl: string | null;
  /** `trusted`, `known`, `user`, `basic`, `visitor`, … Resolved out of VRChat's tags. */
  readonly trustLevel: string;
  /**
   * `verified`, `18+`, `hidden`, or null. `hidden` means the person *is* verified and chose not to
   * publish it, so it must never render as "unverified" — see `ageVerifiedLabel` in `format.ts`.
   */
  readonly ageVerificationStatus: string | null;
  readonly ageVerified: boolean;
  /** Whether the *asking account* is friends with them. Two accounts get two different answers. */
  readonly isFriend: boolean;
  /**
   * VRChat's `status`: the person's *chosen* status, or `offline`. Null when unset.
   *
   * Never read as "are they here". Everyone in a roster is here — that is what the game log is for
   * — and VRChat answers `offline` for some of them anyway. `chosenStatus` in `format.ts` is the
   * one place that decides what is worth drawing.
   */
  readonly status: string | null;
  readonly platform: string | null;
  readonly developerType: string | null;
}

export interface InstanceUsers {
  readonly location: string;
  readonly fetchedAt: number;
  readonly source: "instance" | "unavailable";
  readonly users: readonly InstanceUser[];
}

function rosterRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rosterStr(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Defensive decoding, in the same spirit as the pipeline's.
 *
 * A row missing an `id` or a `displayName` is dropped rather than rendered as a blank name, and
 * every optional field is narrowed rather than cast. The cost of being wrong here is a roster row
 * that lies about somebody's trust rank, which is worse than a row with no chips on it.
 */
function decodeUser(value: unknown): InstanceUser | null {
  const row = rosterRecord(value);
  if (row === null) return null;
  const id = rosterStr(row, "id");
  const displayName = rosterStr(row, "displayName");
  if (id === null || displayName === null) return null;
  return {
    id,
    displayName,
    iconUrl: rosterStr(row, "iconUrl"),
    trustLevel: rosterStr(row, "trustLevel") ?? "",
    ageVerificationStatus: rosterStr(row, "ageVerificationStatus"),
    ageVerified: row.ageVerified === true,
    isFriend: row.isFriend === true,
    status: rosterStr(row, "status"),
    platform: rosterStr(row, "platform"),
    developerType: rosterStr(row, "developerType"),
  };
}

function decodeInstanceUsers(body: unknown, location: string): InstanceUsers {
  const root = rosterRecord(body);
  const rawUsers = root?.users;
  const users =
    Array.isArray(rawUsers) === true
      ? rawUsers.map(decodeUser).filter((user): user is InstanceUser => user !== null)
      : [];
  return {
    location: (root === null ? null : rosterStr(root, "location")) ?? location,
    fetchedAt: typeof root?.fetchedAt === "number" ? root.fetchedAt : Date.now(),
    // Anything other than the literal "instance" means we have no attributes to show, and saying
    // so is always the safe direction to be wrong in.
    source: root?.source === "instance" ? "instance" : "unavailable",
    users,
  };
}

/**
 * Worlds, decoded rather than cast.
 *
 * The batch resolver is the reason. Its whole contract is that one bad id must not cost the other
 * forty-nine their names, so a malformed *entry* is dropped for the same reason a malformed id is:
 * a row keeps its `shortId` fallback, which is exactly what an unresolved world should look like.
 * `tags` gets normalised in both shapes because it is the one field the UI iterates, and an
 * `undefined` there is a render-time crash rather than a missing chip.
 */
function decodeWorldSummary(value: unknown): WorldSummary | null {
  const row = rosterRecord(value);
  if (row === null) return null;
  const id = rosterStr(row, "id");
  if (id === null) return null;
  return {
    id,
    name: rosterStr(row, "name") ?? id,
    thumbnailImageUrl: rosterStr(row, "thumbnailImageUrl"),
    authorName: rosterStr(row, "authorName"),
    capacity: typeof row.capacity === "number" ? row.capacity : null,
  };
}

function decodeWorldBatch(body: unknown): Record<string, WorldSummary> {
  const worlds = rosterRecord(rosterRecord(body)?.worlds);
  if (worlds === null) return {};
  const out: Record<string, WorldSummary> = {};
  for (const [id, value] of Object.entries(worlds)) {
    const world = decodeWorldSummary(value);
    if (world !== null) out[id] = world;
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function decodeWorldDetail(body: unknown, worldId: string): WorldDetail {
  const row = rosterRecord(body) ?? {};
  const summary = decodeWorldSummary({ ...row, id: rosterStr(row, "id") ?? worldId });
  const numeric = (key: string): number | null =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? (row[key] as number) : null;
  return {
    ...(summary ?? {
      id: worldId,
      name: worldId,
      thumbnailImageUrl: null,
      authorName: null,
      capacity: null,
    }),
    description: rosterStr(row, "description"),
    authorId: rosterStr(row, "authorId"),
    imageUrl: rosterStr(row, "imageUrl"),
    recommendedCapacity: numeric("recommendedCapacity"),
    tags: stringList(row.tags),
    releaseStatus: rosterStr(row, "releaseStatus"),
    visits: numeric("visits"),
    favorites: numeric("favorites"),
    heat: numeric("heat"),
    popularity: numeric("popularity"),
    occupants: numeric("occupants"),
    publicationDate: numeric("publicationDate"),
    labsPublicationDate: numeric("labsPublicationDate"),
    createdAt: numeric("createdAt"),
    updatedAt: numeric("updatedAt"),
    version: numeric("version"),
    fetchedAt: numeric("fetchedAt") ?? Date.now(),
    cached: row.cached === true,
  };
}

function decodeInstanceDetail(body: unknown, location: string): InstanceDetail {
  const root = rosterRecord(body);
  const raw = rosterRecord(root?.instance);
  const fetchedAt = typeof root?.fetchedAt === "number" ? root.fetchedAt : Date.now();
  // Anything other than the literal "instance" means there is nothing to show, and saying so is
  // always the safe direction to be wrong in — a closed instance is the ordinary case here.
  if (raw === null || root?.source !== "instance") {
    return { location, fetchedAt, source: "unavailable", instance: null };
  }
  const numeric = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : null;
  return {
    location: rosterStr(root, "location") ?? location,
    fetchedAt,
    source: "instance",
    instance: {
      worldId: rosterStr(raw, "worldId") ?? "",
      instanceId: rosterStr(raw, "instanceId") ?? "",
      // `rosterStr` already treats "" as absent, which is what an unnamed instance sends.
      displayName: rosterStr(raw, "displayName"),
      name: rosterStr(raw, "name"),
      type: rosterStr(raw, "type"),
      ownerId: rosterStr(raw, "ownerId"),
      region: rosterStr(raw, "region"),
      capacity: numeric("capacity"),
      userCount: numeric("userCount"),
      nUsers: numeric("nUsers"),
      full: raw.full === true,
      canRequestInvite: raw.canRequestInvite === true,
      closedAt: numeric("closedAt"),
      hardClose: typeof raw.hardClose === "boolean" ? raw.hardClose : null,
      queueEnabled: raw.queueEnabled === true,
      queueSize: numeric("queueSize"),
      tags: stringList(raw.tags),
      active: raw.active === true,
      world: decodeWorldSummary(raw.world),
    },
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** `exactOptionalPropertyTypes` makes `{ signal }` with an undefined signal a type error. */
function withSignal(signal: AbortSignal | undefined): RequestOptions {
  return signal === undefined ? {} : { signal };
}

export const api = {
  status: (signal?: AbortSignal): Promise<DaemonStatus> =>
    request<DaemonStatus>("/status", withSignal(signal)),

  accounts: {
    list: (signal?: AbortSignal): Promise<Account[]> =>
      request<Account[]>("/accounts", withSignal(signal)),

    login: (username: string, password: string): Promise<LoginResult> =>
      request<LoginResult>("/accounts/login", {
        method: "POST",
        body: { username, password },
      }),

    verifyTwoFactor: (
      accountId: string,
      method: TwoFactorMethod,
      code: string,
    ): Promise<VerifyTwoFactorResult> =>
      request<VerifyTwoFactorResult>(`/accounts/${encodeURIComponent(accountId)}/verify-2fa`, {
        method: "POST",
        body: { method, code },
      }),

    remove: (accountId: string): Promise<void> =>
      request<void>(`/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),

    /**
     * Asks VRChat to invite this account to `location`, so the game client already signed into it
     * can travel there by accepting the notification.
     *
     * This is the "a client is already running" half of joining; `launchLink()` is the other half.
     * The daemon validates the location and answers 400 `invalid_location` for anything not
     * joinable, 409 `account_offline` when the account has no live session, and 403
     * `invite_forbidden` when VRChat will not let it in.
     */
    inviteSelf: (accountId: string, location: string): Promise<{ readonly status: "ok" }> =>
      request<{ readonly status: "ok" }>(`/accounts/${encodeURIComponent(accountId)}/invite-self`, {
        method: "POST",
        body: { location },
      }),

    /*
     * The three things you can do *to another person*, all of which arrive in their inbox with the
     * user's name on it. That is why the account is in the path rather than inferred: with two
     * clients signed in, which of them is asking is the whole question, and guessing would put the
     * wrong person's name on the invite.
     *
     * 403 means VRChat will not deliver it — invites off, or blocked — and 404 means they are gone.
     * Both are answers rather than faults, and the daemon keeps them apart so a screen can say
     * which happened.
     */
    invite: (
      accountId: string,
      userId: string,
      location: string,
      messageSlot?: number,
    ): Promise<{ readonly status: "ok" }> =>
      request<{ readonly status: "ok" }>(`/accounts/${encodeURIComponent(accountId)}/invite`, {
        method: "POST",
        body: { userId, location, ...(messageSlot === undefined ? {} : { messageSlot }) },
      }),

    requestInvite: (
      accountId: string,
      userId: string,
      requestSlot?: number,
    ): Promise<{ readonly status: "ok" }> =>
      request<{ readonly status: "ok" }>(
        `/accounts/${encodeURIComponent(accountId)}/request-invite`,
        {
          method: "POST",
          body: { userId, ...(requestSlot === undefined ? {} : { requestSlot }) },
        },
      ),

    boop: (accountId: string, userId: string): Promise<{ readonly status: "ok" }> =>
      request<{ readonly status: "ok" }>(`/accounts/${encodeURIComponent(accountId)}/boop`, {
        method: "POST",
        body: { userId },
      }),
  },

  /**
   * The proxy's consent sheets. There is deliberately no "approve" call here: approval is the user
   * typing the code into the app, which lands on the mirror port. A button that granted access
   * directly would defeat the code, whose whole job is to prove the person at this screen is the
   * person operating that app.
   */
  consent: {
    list: (signal?: AbortSignal): Promise<PendingConsent[]> =>
      request<PendingConsent[]>("/consent", withSignal(signal)),

    /** Binds a request to an account — the picker, and the "add this account first" case. */
    setAccount: (pairingId: string, accountId: string): Promise<PendingConsent> =>
      request<PendingConsent>(`/consent/${encodeURIComponent(pairingId)}/account`, {
        method: "POST",
        body: { accountId },
      }),

    /** Idempotent: denying something already gone is the outcome the user wanted anyway. */
    deny: (pairingId: string): Promise<void> =>
      request<void>(`/consent/${encodeURIComponent(pairingId)}/deny`, { method: "POST" }),
  },

  /**
   * Standing app access, and the way out of it.
   *
   * The counterpart to `consent`: that one is about a single moment, this is about access that is
   * already granted and still live. Revocation is a plain POST rather than a DELETE because it is
   * idempotent and returns nothing — and because `revokeAll` is a different decision that deserves
   * its own URL rather than a flag someone can forget to send.
   */
  apps: {
    list: (signal?: AbortSignal): Promise<ConnectedApp[]> =>
      request<ConnectedApp[]>("/apps", withSignal(signal)),

    revoke: (grantId: string): Promise<void> =>
      request<void>(`/apps/${encodeURIComponent(grantId)}/revoke`, { method: "POST" }),

    revokeAll: (): Promise<{ revoked: number }> =>
      request<{ revoked: number }>("/apps/revoke-all", { method: "POST" }),

    /**
     * Sets one app's hourly allowance for one risky scope.
     *
     * `null` clears the override and the scope falls back to the build's default — which is not the
     * same as `0`, and `0` is a real setting: "this app may never send an invite", without revoking
     * the grant and making the user pair it again.
     */
    setBudget: (grantId: string, scope: string, limit: number | null): Promise<ConnectedApp> =>
      request<ConnectedApp>(
        `/apps/${encodeURIComponent(grantId)}/budgets/${encodeURIComponent(scope)}`,
        { method: "PUT", body: { limit } },
      ),

    /**
     * What one app has actually done, newest first.
     *
     * Only mutating calls are recorded, so an empty list means "this app has changed nothing", not
     * "this app is idle". A grant the daemon has never issued is a 404; a revoked one still
     * answers, because the log outlives the access.
     */
    audit: (
      grantId: string,
      query: { limit?: number; before?: number } = {},
      signal?: AbortSignal,
    ): Promise<AppAuditEntry[]> =>
      request<AppAuditEntry[]>(`/apps/${encodeURIComponent(grantId)}/audit`, {
        query: { limit: query.limit, before: query.before },
        ...withSignal(signal),
      }),
  },

  /**
   * Plugins: what is installed, and what is waiting to be installed.
   *
   * Note the shape of `install`. It **blocks** — the daemon parks the request until someone answers
   * the consent sheet — so it is the one call in this file that can legitimately take minutes, and
   * the caller must not race it with a timeout of its own. `pending()` is how the sheet finds the
   * question that request is waiting on.
   */
  plugins: {
    list: (signal?: AbortSignal): Promise<InstalledPlugin[]> =>
      request<InstalledPlugin[]>("/plugins", withSignal(signal)),

    /** Resolves when the install is approved and started, or rejects with the daemon's sentence. */
    install: (path: string, accountIds: readonly string[] = []): Promise<InstalledPlugin> =>
      request<InstalledPlugin>("/plugins", {
        method: "POST",
        body: { path, accountIds: [...accountIds] },
      }),

    enable: (pluginId: string): Promise<InstalledPlugin> =>
      request<InstalledPlugin>(`/plugins/${encodeURIComponent(pluginId)}/enable`, {
        method: "POST",
      }),

    disable: (pluginId: string): Promise<InstalledPlugin> =>
      request<InstalledPlugin>(`/plugins/${encodeURIComponent(pluginId)}/disable`, {
        method: "POST",
      }),

    /**
     * Removes the plugin, and its data unless `keepData`.
     *
     * Deleting is the default because it is what a person means by "uninstall"; `keepData` is the
     * reinstall case, where losing a plugin's settings to replace it with a newer copy of itself
     * would be a surprise.
     */
    uninstall: (pluginId: string, options: { keepData?: boolean } = {}): Promise<void> =>
      request<void>(`/plugins/${encodeURIComponent(pluginId)}`, {
        method: "DELETE",
        query: { keepData: options.keepData === true ? "1" : undefined },
      }),

    /**
     * Lifts or restores dry-run for one scope of one plugin.
     *
     * Per plugin *and* per scope, and never on a timer: "it has behaved for seven days" says
     * nothing about the eighth, and a timed prompt only teaches people to dismiss prompts.
     */
    setDryRun: (pluginId: string, scope: string, lifted: boolean): Promise<InstalledPlugin> =>
      request<InstalledPlugin>(
        `/plugins/${encodeURIComponent(pluginId)}/dry-run/${encodeURIComponent(scope)}`,
        { method: "PUT", body: { lifted } },
      ),

    /** Every panel this plugin is drawing right now, as the daemon currently holds them. */
    panels: (pluginId: string, signal?: AbortSignal): Promise<PluginPanel[]> =>
      request<PluginPanel[]>(`/plugins/${encodeURIComponent(pluginId)}/panels`, withSignal(signal)),

    /**
     * Sends one user action to a plugin.
     *
     * Resolves when the plugin has *received* it, not when it has redrawn — the new tree arrives on
     * the event socket. That split is what lets the renderer mark one node busy rather than
     * blocking a panel on a redraw that may never come.
     */
    intent: (
      pluginId: string,
      panelId: string,
      intent: { name: string; payload?: Record<string, string | number | boolean> },
      formState: Record<string, string | number | boolean>,
    ): Promise<void> =>
      request<void>(
        `/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/intent`,
        { method: "POST", body: { intent, formState } },
      ),

    /** Runs one of a plugin's contributed commands. The plugin decides what that means. */
    runCommand: (pluginId: string, commandId: string): Promise<void> =>
      request<void>(
        `/plugins/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(commandId)}`,
        { method: "POST" },
      ),

    pending: (signal?: AbortSignal): Promise<PendingPluginConsent[]> =>
      request<PendingPluginConsent[]>("/plugins/pending", withSignal(signal)),

    /** Answers a parked install. The install request itself is what returns the outcome. */
    approve: (id: string, choice: PluginConsentChoice): Promise<void> =>
      request<void>(`/plugins/pending/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: {
          accountIds: [...choice.accountIds],
          // Spread, because omitted and empty are different answers: omitted means "everything
          // asked for", `[]` means "none of it".
          ...(choice.scopes === undefined ? {} : { scopes: [...choice.scopes] }),
          ...(choice.capabilities === undefined ? {} : { capabilities: [...choice.capabilities] }),
          ...(choice.events === undefined ? {} : { events: [...choice.events] }),
        },
      }),

    deny: (id: string): Promise<void> =>
      request<void>(`/plugins/pending/${encodeURIComponent(id)}/deny`, { method: "POST" }),
  },

  /**
   * Node graphs. See `PLAN.md` §Phase 4.
   *
   * The two switches are separate calls because they are separate gestures: `enable` says the graph
   * should run, `arm` says its outbound actions are real. Saving a document can do neither, which is
   * enforced in SQL rather than here — this shape only mirrors it.
   */
  graphs: {
    /** Every node type the palette can offer, built-in and plugin-contributed alike. */
    nodeTypes: (signal?: AbortSignal): Promise<NodeTypeSummary[]> =>
      request<NodeTypeSummary[]>("/nodes", withSignal(signal)),

    list: (signal?: AbortSignal): Promise<GraphSummary[]> =>
      request<GraphSummary[]>("/graphs", withSignal(signal)),

    get: (graphId: string, signal?: AbortSignal): Promise<Graph> =>
      request<Graph>(`/graphs/${encodeURIComponent(graphId)}`, withSignal(signal)),

    create: (input: GraphCreate): Promise<Graph> =>
      request<Graph>("/graphs", { method: "POST", body: { ...input } }),

    /**
     * Saves the editable half. Rejects with `invalid_graph` and every broken edge named, rather
     * than the first — a canvas that reports one problem per save is a canvas nobody finishes.
     */
    update: (graphId: string, input: GraphUpdate): Promise<Graph> =>
      request<Graph>(`/graphs/${encodeURIComponent(graphId)}`, {
        method: "PUT",
        body: { ...input },
      }),

    remove: (graphId: string): Promise<void> =>
      request<void>(`/graphs/${encodeURIComponent(graphId)}`, { method: "DELETE" }),

    setEnabled: (graphId: string, enabled: boolean): Promise<GraphSummary> =>
      request<GraphSummary>(
        `/graphs/${encodeURIComponent(graphId)}/${enabled ? "enable" : "disable"}`,
        { method: "POST" },
      ),

    /** Lifts or restores dry-run. The gesture behind it is a hold, never a timer. */
    setArmed: (graphId: string, armed: boolean): Promise<GraphSummary> =>
      request<GraphSummary>(`/graphs/${encodeURIComponent(graphId)}/armed`, {
        method: "PUT",
        body: { armed },
      }),

    /** Runs that have not finished. A completed run is a `graph.*` event in the feed, not a row. */
    runs: (graphId: string, signal?: AbortSignal): Promise<GraphRunSummary[]> =>
      request<GraphRunSummary[]>(`/graphs/${encodeURIComponent(graphId)}/runs`, withSignal(signal)),

    /** Fires the manual trigger. Rejects `no_manual_trigger` when the graph has no such node. */
    runNow: (graphId: string): Promise<void> =>
      request<void>(`/graphs/${encodeURIComponent(graphId)}/run`, { method: "POST" }),

    /** The graphs vrc.zip ships, so a first canvas is an edit rather than a blank page. */
    templates: (signal?: AbortSignal): Promise<GraphTemplate[]> =>
      request<GraphTemplate[]>("/graphs/templates", withSignal(signal)),

    /**
     * One graph as a portable document.
     *
     * Carries no secret, and not because anything strips one: a secret never enters the document,
     * so this is safe to hand to somebody by construction.
     */
    export: (graphId: string, signal?: AbortSignal): Promise<GraphExport> =>
      request<GraphExport>(`/graphs/${encodeURIComponent(graphId)}/export`, withSignal(signal)),

    /** Creates a graph from an exported document — off, unarmed, and reporting what is missing. */
    import: (document: unknown): Promise<GraphImportResult> =>
      request<GraphImportResult>("/graphs/import", {
        method: "POST",
        body: document as Record<string, never>,
      }),

    /**
     * Stores one node's secret field. Write-only: nothing reads it back, here or anywhere.
     *
     * An empty value clears it, which is why this is one call rather than a set and a delete.
     */
    setSecret: (graphId: string, nodeId: string, fieldId: string, value: string): Promise<void> =>
      request<void>(
        `/graphs/${encodeURIComponent(graphId)}/secrets/${encodeURIComponent(nodeId)}/${encodeURIComponent(fieldId)}`,
        { method: "PUT", body: { value } },
      ),

    /**
     * Which of a graph's nodes are remembering something.
     *
     * Asked rather than declared, which is what lets the editor show a "forget" button *only* where
     * there is something to forget — a node with no rows has nothing to reset, and offering the
     * gesture anyway teaches people it does nothing.
     */
    memory: (graphId: string, signal?: AbortSignal): Promise<GraphMemoryEntry[]> =>
      request<GraphMemoryEntry[]>(
        `/graphs/${encodeURIComponent(graphId)}/memory`,
        withSignal(signal),
      ),

    /** Forgets one node's memory, or the whole graph's when `nodeId` is null. Idempotent. */
    forget: (graphId: string, nodeId: string | null): Promise<void> =>
      request<void>(
        nodeId === null
          ? `/graphs/${encodeURIComponent(graphId)}/memory`
          : `/graphs/${encodeURIComponent(graphId)}/memory/${encodeURIComponent(nodeId)}`,
        { method: "DELETE" },
      ),
  },

  /*
   * The named stores. Beside graphs rather than under one, because a store is shared by name and
   * belongs to no single graph — `/graphs/:id/stores` would imply an owner that does not exist.
   */
  graphStores: {
    list: (signal?: AbortSignal): Promise<GraphStoreSummary[]> =>
      request<GraphStoreSummary[]>("/graph-stores", withSignal(signal)),

    browse: (name: string, signal?: AbortSignal): Promise<GraphStoreEntry[]> =>
      request<GraphStoreEntry[]>(`/graph-stores/${encodeURIComponent(name)}`, withSignal(signal)),

    /** Removes one entry. The raw collection rides in the query: `map:x` contains a path separator. */
    removeEntry: (name: string, collection: string, key: string): Promise<void> =>
      request<void>(
        `/graph-stores/${encodeURIComponent(name)}/entry?collection=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`,
        { method: "DELETE" },
      ),

    /** Removes a store and everything in it. A person's gesture; no graph and no plugin can do it. */
    remove: (name: string): Promise<void> =>
      request<void>(`/graph-stores/${encodeURIComponent(name)}`, { method: "DELETE" }),
  },

  /*
   * The user's oversight view of outbound webhooks. Read and delete only — there is no create call,
   * because a webhook is something an app asks for through the proxy after the user approved it at
   * consent, not something the Settings screen hands out.
   */
  webhooks: {
    list: (signal?: AbortSignal): Promise<WebhookSummary[]> =>
      request<WebhookSummary[]>("/webhooks", withSignal(signal)),

    remove: (webhookId: string): Promise<void> =>
      request<void>(`/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" }),
  },

  sessions: (signal?: AbortSignal): Promise<GameSession[]> =>
    request<GameSession[]>("/sessions", withSignal(signal)),

  /**
   * A page of the feed.
   *
   * `kinds`, `families` and `search` narrow in **SQL**, not here. Filtering a fetched page in the
   * browser silently changes what paging means: the daemon returns the newest N rows, the screen
   * throws most of them away, and "load older" walks history it then discards — so a filter looks
   * like an empty history rather than like a filter.
   */
  events: (query: EventQuery = {}, signal?: AbortSignal): Promise<FeedEvent[]> =>
    request<FeedEvent[]>("/events", {
      query: {
        accountId: query.accountId,
        kind: query.kind,
        // Comma-joined because that is what the route parses; the daemon trims, deduplicates and
        // caps the list.
        kinds:
          query.kinds === undefined || query.kinds.length === 0 ? undefined : query.kinds.join(","),
        families:
          query.families === undefined || query.families.length === 0
            ? undefined
            : query.families.join(","),
        q: query.search,
        subjectId: query.subjectId,
        sessionId: query.sessionId,
        limit: query.limit,
        before: query.before,
      },
      ...withSignal(signal),
    }),

  /**
   * The kinds actually present in the store, with row counts. What a filter list is built from.
   *
   * Counting the fetched page instead — which the feed's family tabs used to do — offers a filter
   * only while that kind happens to be among the newest rows, and withdraws it as they age out.
   */
  eventKinds: (signal?: AbortSignal): Promise<EventKindCount[]> =>
    request<EventKindCount[]>("/event-kinds", withSignal(signal)),

  users: {
    /**
     * One user, merged from VRChat and the local store.
     *
     * `accountId` picks whose credentials the lookup runs through, and it matters: VRChat answers
     * `GET /users/{id}` with different fields depending on whether the *caller* is a friend, so
     * two accounts asking about the same person get two different answers. Omit it and the daemon
     * chooses an online account itself.
     *
     * Throws 404 for a user id VRChat does not know and 503 when no account is online — the
     * latter is an ordinary state, see `isNoAccountOnline`.
     */
    get: (userId: string, accountId?: string, signal?: AbortSignal): Promise<UserProfile> =>
      request<UserProfile>(`/users/${encodeURIComponent(userId)}`, {
        query: { accountId },
        ...withSignal(signal),
      }),

    /**
     * Attributes for many users in one request — the roster's fallback path.
     *
     * `instanceUsers` is the cheap way to learn what a room full of people are like, and it almost
     * never answers: VRChat sends a roster only for an instance the account *created*. This is the
     * expensive way — one lookup per person, served from the daemon's user cache where it can be —
     * so callers ask only for the people they still have nothing about.
     *
     * **An id that could not be read is absent from the list**, never an error and never a null
     * entry, so one deleted account cannot cost a room of eighty their chips. It never throws
     * `no_account` either: with nobody signed in it answers with whatever the cache holds.
     */
    batch: async (
      ids: readonly string[],
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<InstanceUser[]> =>
      ids.length === 0
        ? []
        : (
            await request<{ readonly users: readonly InstanceUser[] }>("/users", {
              query: { ids: ids.join(","), accountId },
              ...withSignal(signal),
            })
          ).users.slice(),

    /**
     * The groups a user is in, with the represented one flagged.
     *
     * VRChat only returns the memberships the *asking* account is allowed to see, so a short list
     * — or an empty one — is an ordinary answer about a user with many groups, not a failed read.
     * The envelope is unwrapped here because it carries nothing else worth threading through.
     *
     * 503 when no account is online, exactly like `get` — see `isNoAccountOnline`.
     */
    groups: async (
      userId: string,
      accountId?: string,
      signal?: AbortSignal,
    ): Promise<UserGroup[]> =>
      (
        await request<{ readonly groups: readonly UserGroup[] }>(
          `/users/${encodeURIComponent(userId)}/groups`,
          { query: { accountId }, ...withSignal(signal) },
        )
      ).groups.slice(),

    /**
     * One page of the friends the asking account and this user have in common.
     *
     * Paged, and the envelope is kept whole: `hasMore` is the only honest basis for a "load more"
     * control, and inferring it from `users.length === n` would guess wrong on an exact fit.
     */
    mutualFriends: (
      userId: string,
      options: MutualFriendQuery = {},
      signal?: AbortSignal,
    ): Promise<MutualFriendPage> =>
      request<MutualFriendPage>(`/users/${encodeURIComponent(userId)}/mutual-friends`, {
        query: { accountId: options.accountId, n: options.n, offset: options.offset },
        ...withSignal(signal),
      }),

    /**
     * Writes the local, private note. Never leaves this machine — this is not VRChat's
     * `/userNotes`. An empty string clears it.
     */
    setNote: (userId: string, note: string, accountId?: string): Promise<UserNote> =>
      request<UserNote>(`/users/${encodeURIComponent(userId)}/note`, {
        method: "PUT",
        query: { accountId },
        body: { note },
      }),
  },

  groups: {
    /**
     * One group in full, for the group modal.
     *
     * Live every time — a group is not cached the way a world is, because the two numbers worth
     * opening the dialog for are the online member count and this account's own membership status,
     * and a cached answer would be neither.
     *
     * A 404 covers two cases the daemon cannot tell apart: the group is gone, or it is private to
     * this account. The modal says both rather than picking one. 503 when no account is signed in
     * — see `isNoAccountOnline`.
     */
    get: (groupId: string, accountId?: string | null, signal?: AbortSignal): Promise<GroupDetail> =>
      request<GroupDetail>(`/groups/${encodeURIComponent(groupId)}`, {
        query: { accountId },
        ...withSignal(signal),
      }),

    /*
     * The four paged sub-resources behind the group screen.
     *
     * Each one 403s for an account the group will not show it to, which `isForbidden` turns into a
     * sentence rather than an error — see `PagedSection`. `hasMore` is the daemon's call, derived
     * from a short page, because VRChat sends no total.
     *
     * `offset` is the count already held rather than a page number, which is what lets `PagedList`
     * stay ignorant of how many pages it has read.
     */
    members: (
      groupId: string,
      offset: number,
      n: number,
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<GroupMemberPage> =>
      request<GroupMemberPage>(`/groups/${encodeURIComponent(groupId)}/members`, {
        query: { accountId, n: String(n), offset: String(offset) },
        ...withSignal(signal),
      }),

    posts: (
      groupId: string,
      offset: number,
      n: number,
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<GroupPostPage> =>
      request<GroupPostPage>(`/groups/${encodeURIComponent(groupId)}/posts`, {
        query: { accountId, n: String(n), offset: String(offset) },
        ...withSignal(signal),
      }),

    /** Not paged: VRChat returns every open instance at once, and there are never many. */
    instances: (
      groupId: string,
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<GroupInstanceList> =>
      request<GroupInstanceList>(`/groups/${encodeURIComponent(groupId)}/instances`, {
        query: { accountId },
        ...withSignal(signal),
      }),

    /**
     * One gallery's images. The gallery *list* rides in on the group record itself
     * (`GroupDetail.galleries`), so opening the tab costs no extra request until an image loads.
     */
    galleryImages: (
      groupId: string,
      galleryId: string,
      offset: number,
      n: number,
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<GroupGalleryImagePage> =>
      request<GroupGalleryImagePage>(
        `/groups/${encodeURIComponent(groupId)}/galleries/${encodeURIComponent(galleryId)}/images`,
        { query: { accountId, n: String(n), offset: String(offset) }, ...withSignal(signal) },
      ),
  },

  avatars: {
    /**
     * The avatar id for one VRChat image file, or null when none is known.
     *
     * **This is the third-party lookup.** The daemon asks avtr.zip, because VRChat exposes no
     * avatar id on a public user and a picture is the only handle there is. It is a setting the
     * user can turn off (`resolveAvatarIds`), and when it is off this answers `avatarId: null`
     * rather than failing — "not resolved" and "could not resolve" look the same to a caller on
     * purpose, because neither is a reason to draw an error at somebody.
     */
    byFile: (fileId: string, signal?: AbortSignal): Promise<AvatarFileResolution> =>
      request<AvatarFileResolution>(`/avatars/by-file/${encodeURIComponent(fileId)}`, {
        ...withSignal(signal),
      }),

    /**
     * One avatar record. Needs a signed-in account, since this one really is VRChat's.
     *
     * A 404 is ordinary: avatars are deleted and made private constantly, and an id recovered from
     * a months-old feed row is exactly where a dead one comes from.
     */
    get: (
      avatarId: string,
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<AvatarDetail> =>
      request<AvatarDetail>(`/avatars/${encodeURIComponent(avatarId)}`, {
        query: { accountId },
        ...withSignal(signal),
      }),

    /**
     * Puts one of your accounts into this avatar. **A write, and the only one in this client that
     * changes something about you on VRChat's side rather than asking a question.**
     *
     * `accountId` is required rather than optional, and that is the point: with two accounts signed
     * in, "wear this" means nothing until it says who, and letting the daemon pick would silently
     * dress the wrong person. A 403 is VRChat refusing the entitlement, which is VRChat's decision
     * to make and not something vrc.zip checks or works around.
     */
    select: (avatarId: string, accountId: string, signal?: AbortSignal): Promise<void> =>
      request<{ status: "ok" }>(`/avatars/${encodeURIComponent(avatarId)}/select`, {
        method: "POST",
        query: { accountId },
        ...withSignal(signal),
      }).then(() => undefined),
  },

  worlds: {
    /**
     * One world in full, for the world modal.
     *
     * The daemon serves a cached world without any account signed in — a world is the same record
     * whoever asks — so a cold laptop still names the places in its own feed. A cache miss with
     * nobody online is a 503 (`isNoAccountOnline`), and a deleted world is a 404 (`isNotFound`).
     * Deleted worlds are common enough that the modal treats it as an outcome, not a fault.
     */
    get: (worldId: string, accountId?: string | null, signal?: AbortSignal): Promise<WorldDetail> =>
      request<unknown>(`/worlds/${encodeURIComponent(worldId)}`, {
        query: { accountId },
        ...withSignal(signal),
      }).then((body) => decodeWorldDetail(body, worldId)),

    /**
     * Names for many worlds in one request. The endpoint the world-name resolver exists to use.
     *
     * **An id that could not be resolved is simply absent from the map** — never an error, never a
     * null entry. Absent does not prove "deleted", either: with no account signed in the daemon
     * answers from cache alone, so everything it has never seen is missing. See
     * `state/world-names.svelte.ts` for why that makes "unresolvable" a cooldown rather than a
     * permanent verdict.
     */
    list: (
      ids: readonly string[],
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<Record<string, WorldSummary>> =>
      ids.length === 0
        ? Promise.resolve({})
        : request<unknown>("/worlds", {
            query: { ids: ids.join(","), accountId },
            ...withSignal(signal),
          }).then(decodeWorldBatch),

    /**
     * The instances of a world vrc.zip can currently see.
     *
     * **Derived, and it never reaches VRChat.** There is no "instances of this world" call upstream
     * to proxy — only `GET /instances/{worldId}:{instanceId}`, which needs an id you already have —
     * so the daemon answers from the friend presence it already holds and the game clients it can
     * already see. That is why this returns instantly and why it never 503s for "no account": an
     * empty list is a true statement about what is visible, not a failure to look.
     *
     * The caller has to render the caveat, because the list cannot carry it alone: an instance with
     * nobody you know in it does not appear, and its absence is not a claim that it is not there.
     */
    instances: (
      worldId: string,
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<WorldInstanceList> =>
      request<WorldInstanceList>(`/worlds/${encodeURIComponent(worldId)}/instances`, {
        query: { accountId },
        ...withSignal(signal),
      }),
  },

  /**
   * One instance's live record — occupancy, access type, region, queue, whether it is still open.
   *
   * `source: "unavailable"` is an ordinary answer, not a failure: instances close, and a closed one
   * is exactly what a location string from an hour ago points at.
   */
  instance: (
    location: string,
    accountId?: string | null,
    signal?: AbortSignal,
  ): Promise<InstanceDetail> =>
    request<unknown>("/instances", {
      query: {
        location,
        ...(accountId === null || accountId === undefined || accountId === "" ? {} : { accountId }),
      },
      ...withSignal(signal),
    }).then((body) => decodeInstanceDetail(body, location)),

  /**
   * Attributes for everyone VRChat believes is in `location`, seen through `accountId`.
   *
   * `accountId` is not decoration: `isFriend` is a statement about the asking account. Omit it and
   * the daemon picks an online account itself.
   *
   * A well-formed `source: "unavailable"` is the **normal** answer for nearly every instance:
   * VRChat sends `users` only for an instance the asking account *created*, not for one it is
   * standing in. The design working, not a failure — callers render the log-derived roster with a
   * plain sentence rather than an error state.
   */
  instanceUsers: async (
    location: string,
    accountId?: string | null,
    signal?: AbortSignal,
  ): Promise<InstanceUsers> => {
    const raw = await request<unknown>("/instance-users", {
      query: {
        location,
        ...(accountId === null || accountId === undefined || accountId === "" ? {} : { accountId }),
      },
      ...withSignal(signal),
    });
    return decodeInstanceUsers(raw, location);
  },

  friends: (accountId?: string, signal?: AbortSignal): Promise<Friend[]> =>
    request<Friend[]>("/friends", {
      query: { accountId },
      ...withSignal(signal),
    }),

  notifications: {
    /**
     * A page of the inbox. Every filter narrows in SQL, for the same reason the feed's do.
     *
     * `seen` is tri-state: omitted shows both, `false` hides what has been read. It is stringified
     * explicitly rather than left to the URL builder, so `seen: false` reaches the daemon as
     * `seen=false` and not as an omitted parameter.
     */
    list: (query: NotificationQuery = {}, signal?: AbortSignal): Promise<NotificationItem[]> =>
      request<NotificationItem[]>("/notifications", {
        query: {
          accountId: query.accountId,
          types:
            query.types === undefined || query.types.length === 0
              ? undefined
              : query.types.join(","),
          seen: query.seen === undefined ? undefined : String(query.seen),
          q: query.search,
          limit: query.limit,
          before: query.before,
        },
        ...withSignal(signal),
      }),

    /** Types present in the store with row counts — what the inbox's type filter is built from. */
    types: (signal?: AbortSignal): Promise<NotificationTypeCount[]> =>
      request<NotificationTypeCount[]>("/notification-types", withSignal(signal)),

    markSeen: (id: string): Promise<void> =>
      request<void>(`/notifications/${encodeURIComponent(id)}/seen`, { method: "POST" }),
  },

  settings: {
    get: (signal?: AbortSignal): Promise<Settings> =>
      request<Settings>("/settings", withSignal(signal)),

    update: (patch: SettingsPatch): Promise<Settings> =>
      request<Settings>("/settings", { method: "PUT", body: patch }),

    /**
     * Copies vrc.zip somewhere permanent, adds its shortcuts, and registers the autostart there.
     *
     * A `POST` rather than a settings field, because it is an action with a result to report and
     * the thing it changes is the filesystem. The answer's `reason` is worth showing even when `ok`
     * is true: a copy that landed with a shortcut that did not is a partial success, and saying so
     * beats claiming either outcome.
     */
    install: (options: {
      desktopShortcut: boolean;
      startMenuShortcut: boolean;
    }): Promise<InstallReport> =>
      request<InstallReport>("/settings/install", { method: "POST", body: options }),
  },

  /*
   * Retention. `update` is both save and preview — pass `dryRun` and nothing is written, which is
   * how the screen shows what a window would delete before anyone commits to it.
   */
  retention: {
    get: (signal?: AbortSignal): Promise<RetentionSettings> =>
      request<RetentionSettings>("/retention", withSignal(signal)),

    update: (update: RetentionUpdate): Promise<RetentionSettings> =>
      request<RetentionSettings>("/retention", { method: "PUT", body: update }),

    run: (): Promise<RetentionRunResult> =>
      request<RetentionRunResult>("/retention/run", { method: "POST" }),
  },
} as const;
