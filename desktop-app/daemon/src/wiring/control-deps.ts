import type {
  Avatar,
  Badge,
  Group,
  GroupGallery,
  GroupGalleryImage,
  GroupInstance,
  GroupMember,
  GroupPost,
  Instance,
  LimitedUserGroups,
  LimitedUserInstance,
  MutualFriend,
  PublicProfile,
  RepresentedGroup,
  User,
  World,
} from "@vrcz/api/types";
import {
  isScope,
  type JsonValue,
  type RateCeilingSnapshot,
  type RateFrame,
  RETENTION_DEFAULT_KEY,
  type RetentionRunResult,
  type RetentionSettings,
  type RetentionUpdate,
  SCOPES,
  STREAM_RATE,
  type WebhookSummary,
  type WorldInstanceList,
  type WorldInstanceOccupant,
  type WorldInstanceSource,
  type WorldInstanceSummary,
} from "@vrcz/shared";
import type { Account, AccountSnapshot } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import { type PresenceService, trustLevelOf } from "../accounts/presence.ts";
import type { EventBus } from "../bus/event-bus.ts";
// The one thing the control layer borrows from the log subsystem: the location grammar. Both
// halves of `listWorldInstances` are location strings, and a second parser here would be a second
// opinion on what `~region(` means.
import { parseLocation } from "../game-logs/index.ts";
import { AvatarIdResolver } from "../net/avatar-ids.ts";
import { ImageCache } from "../net/image-cache.ts";
import type { RateBucketSnapshot, RateLimiter } from "../net/rate-limiter.ts";
import { vrcFetch } from "../net/request.ts";
import { emptySeries, type RequestMeter, WINDOW_SECONDS } from "../net/request-meter.ts";
import { buildUserAgent } from "../net/user-agent.ts";
import { pickUserImageUrl, pickUserImageUrlFull } from "../net/user-image.ts";
import type { ConsentRegistry, PendingConsent } from "../proxy/consent.ts";
import { BUDGET_WINDOW_MS, DEFAULT_GRANT_BUDGETS } from "../proxy/passthrough.ts";
import type { PipelineMirror } from "../proxy/pipeline-mirror.ts";
import type { SecretsStore } from "../security/secrets.ts";
import {
  type AppAuditEntry,
  type AppBudget,
  type AuditQuery,
  type AvatarDetail,
  type AvatarFileResolution,
  type ConnectedApp,
  type ControlAccount,
  type ControlDeps,
  ControlError,
  type EventQuery,
  type FeedEvent,
  type FriendPresence,
  type GameSession,
  type GroupDetail,
  type GroupGalleryImagePage,
  type GroupGalleryImageSummary,
  type GroupGallerySummary,
  type GroupInstanceList,
  type GroupInstanceSummary,
  type GroupMemberPage,
  type GroupMemberSummary,
  type GroupPostPage,
  type GroupPostSummary,
  type GroupSummary,
  type InstanceDetail,
  type InstanceInfo,
  type InstanceRoster,
  type InstanceUser,
  type LoginResult,
  type MutualFriendPage,
  type MutualFriendSummary,
  type NotificationItem,
  type PendingConsentRequest,
  type SettingsPatch,
  type StatusSnapshot,
  type StreamEvent,
  type UserBadge,
  type UserBatch,
  type UserDetail,
  type UserGroups,
  type UserNote,
  type UserProfileCard,
  type Settings as WireSettings,
  type WorldBatch,
  type WorldDetail,
  type WorldSummary,
} from "../servers/control.ts";
import type { Settings } from "../settings.ts";
import {
  applyRetentionUpdate,
  describeRetention,
  runRetention as runRetentionPass,
  type Store,
} from "../store/index.ts";
import type { GrantRow } from "../store/types.ts";
import type { WebhookManager } from "../webhooks/index.ts";
import { EPHEMERAL } from "./feed-writer.ts";
import { webhookSummary } from "./webhook-summary.ts";

/**
 * Implements the control API's `ControlDeps` against the live daemon.
 *
 * This is the only place daemon-internal shapes (snake_case rows, `AccountSnapshot`) are translated
 * into wire shapes. Keeping the mapping in one file is what lets the store change its column names
 * without touching HTTP, and lets the HTTP contract change without touching SQL.
 */

export interface ControlDepsOptions {
  readonly accounts: AccountManager;
  readonly store: Store;
  readonly bus: EventBus;
  readonly limiter: RateLimiter;
  readonly secrets: SecretsStore;
  readonly presence: PresenceService;
  /**
   * The proxy's pending consent sheets. Optional so a test that only exercises the Phase 1 surface
   * does not have to construct one; without it the consent routes answer as though nothing is
   * pending, which is exactly true.
   */
  readonly consent?: ConsentRegistry | undefined;
  /**
   * The pipeline mirror, so revoking an app can close the sockets it holds. Optional for the same
   * reason `consent` is; without it revocation still lands in the database, and a socket opened
   * before it survives until the app reconnects — which is the wrong half to lose, hence the wiring.
   */
  readonly pipelineMirror?: PipelineMirror | undefined;
  /**
   * What the daemon is actually spending, per second. Optional; absent, every rate reads as an
   * empty series rather than as a missing field, so the UI has nothing to branch on.
   */
  readonly meter?: RequestMeter | undefined;
  /**
   * When the nightly retention pass is next due, so `GET /api/retention` can say so.
   *
   * A getter rather than a number: the scheduler re-rolls its jitter after every pass, so a value
   * captured at construction would be wrong from the first night onward. Optional because a test
   * store has no scheduler, and "no pass scheduled" is an honest answer for one.
   */
  readonly nextRetentionRunAt?: (() => number) | undefined;
  /**
   * The outbound webhook subsystem, for the user's oversight view.
   *
   * Optional for the same reason `consent` is: a Phase 1 test constructing these deps has none, and
   * "no webhooks are registered" is exactly true for a daemon that cannot register any.
   */
  readonly webhooks?: WebhookManager | undefined;
  /**
   * The avtr.zip lookup, injected.
   *
   * Optional, and normally absent: the default is built lazily below, because it needs a valid
   * User-Agent and the contact that goes in one does not exist until first-run setup is done. A
   * test injects one to stub the third-party host without a network.
   */
  readonly avatarIds?: AvatarIdResolver | undefined;
  readonly settings: Settings;
  readonly env?: NodeJS.ProcessEnv;
  readonly connectPipeline: (accountId: string) => void;
  readonly onSettingsSaved: (settings: Settings) => Promise<void>;
}

/**
 * Maps an upstream failure onto a status the control API is allowed to return.
 *
 * Only the ones a sign-in can legitimately produce pass through; anything else becomes a 401 rather
 * than inventing a code the UI has no branch for.
 */
function loginStatusOf(error: unknown): 401 | 403 | 429 | 502 {
  const status = (error as { status?: unknown }).status;
  if (status === 403) return 403;
  if (status === 429) return 429;
  if (typeof status === "number" && status >= 500) return 502;
  return 401;
}

/** `AccountState` → the four states the UI's status dot knows about. */
function connectionOf(snapshot: AccountSnapshot): ControlAccount["connection"] {
  switch (snapshot.state) {
    case "online":
      return "connected";
    case "authenticating":
      return "connecting";
    case "awaiting-2fa":
      return "needs-2fa";
    default:
      return "disconnected";
  }
}

/**
 * How long a cached `GET /users/{id}` body stays fresh.
 *
 * Ten minutes. The fields this cache actually holds are slow-moving — bio, bio links, pronouns,
 * tags and therefore trust level, date joined — and a friend changes those on the order of weeks.
 * The two fields that *do* move minute to minute, `status` and `location`, already arrive live on
 * the pipeline and are what the friends list renders; the modal is a profile view, not a presence
 * view. Ten minutes is long enough that opening a profile, closing it, and opening it again costs
 * nothing, and short enough that an edit made while the app is open shows up in the same sitting.
 */
const USER_CACHE_TTL_MS = 10 * 60_000;

/**
 * How long an instance roster stays fresh.
 *
 * **Twenty seconds**, which is far shorter than any other cache here and deliberately so: a roster
 * is the one thing in this app that changes while you watch it. People walk through a portal every
 * few seconds in a busy public instance, so a minutes-long TTL — right for a profile, right for an
 * icon — would draw a room that emptied out five minutes ago.
 *
 * It is not shorter than twenty seconds because the *cheap* half of the screen is already live: the
 * game log delivers joins and leaves instantly, and this call only adds the per-person facts (rank,
 * age verification, friendship) which do not change at all while someone stands there. So the TTL
 * only has to bound how long a *newly arrived* person waits for their icons, and twenty seconds
 * caps that at three upstream calls per minute per instance no matter how fast the screen polls or
 * how many viewers it has — against a 16/s per-account budget shared with presence polling.
 */
const INSTANCE_ROSTER_TTL_MS = 20_000;

/**
 * How long a cached world stays fresh. **Twenty-four hours.**
 *
 * A world is the most static object VRChat serves: its name, author, capacity and thumbnail change
 * only when the author uploads a new version, which is a thing that happens on the order of months
 * for the worlds people actually sit in. The whole reason this cache exists is that a feed page is
 * a hundred rows naming a dozen worlds, and a name is not worth a request twice in one day.
 *
 * Two and a half hours of `USER_CACHE_TTL_MS` would be defensible and is still wrong: a user's
 * status moves minute to minute, which is why that one is ten minutes, and a world's does not move
 * at all. The one field that *does* drift, `occupants`, is documented on `WorldDetail` as being as
 * old as `fetchedAt` — anything wanting live occupancy asks about an *instance*, not a world.
 */
const WORLD_CACHE_TTL_MS = 24 * 60 * 60_000;

/**
 * How long a cached avatar stays fresh. **Twenty-four hours**, the same as a world and for the same
 * reason: an avatar record only changes when its author re-uploads it, and the rows that ask about
 * one are a feed page naming the same handful of avatars over and over.
 */
const AVATAR_CACHE_TTL_MS = 24 * 60 * 60_000;

/**
 * One instance response as fetched, before either route reads its half.
 *
 * `instance: null` covers both "VRChat 404'd" and "VRChat answered a literal `null`" — from here
 * down they mean the same thing, and neither is an error.
 */
interface CachedInstance {
  readonly fetchedAt: number;
  readonly instance: Partial<Instance> | null;
}

/** VRChat sends `""` for an unset text field, not `null`. `??` alone would keep the empty string. */
function emptyToNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A VRChat date string as integer unix ms, or null.
 *
 * The date-shaped guard is not decoration: `Date.parse("-5")` succeeds — it reads as a year — so
 * falling straight through to `Date.parse` turns VRChat's `""` and any other junk into a
 * confident wrong timestamp. `date_joined` is `YYYY-MM-DD` and `last_login` is a full ISO
 * date-time, so both start with the same ten characters, and nothing else is accepted.
 */
function unixMsFromDate(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** VRChat's arrays arrive as `Array<string>` but a defensive filter costs nothing. */
function stringArray(value: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/**
 * One entry of an instance's `users` array as the wire shape, or `null` for an entry we cannot
 * name.
 *
 * Defensive about every field including the required ones: this array is the only place in the app
 * where a *whole list* of strangers' records arrives at once, so one malformed entry must cost that
 * entry rather than the roster. An entry with no id is dropped — the UI keys rows by it, and the
 * log-derived name is a better answer than a row that cannot be clicked.
 *
 * `ageVerificationStatus` is passed through **verbatim**, never collapsed into a boolean. VRChat's
 * `hidden` means *verified but not published*, not unverified, so folding it in with an absent
 * status would turn "we were told nothing" into an implied claim that a real person is not age
 * verified. That distinction is the UI's to draw, and it can only draw it if this layer keeps it.
 */
function toInstanceUser(raw: Partial<LimitedUserInstance>, isFriend: boolean): InstanceUser | null {
  if (typeof raw.id !== "string" || raw.id === "") return null;

  return {
    id: raw.id,
    displayName:
      typeof raw.displayName === "string" && raw.displayName !== "" ? raw.displayName : raw.id,
    iconUrl: pickUserImageUrl(raw),
    // Free: the same roster response carries the full-size fields alongside the thumbnails.
    iconUrlFull: pickUserImageUrlFull(raw),
    // Reused, never re-derived — the trust ladder has one definition, in `presence.ts`.
    trustLevel: trustLevelOf(stringArray(raw.tags)),
    ageVerificationStatus: emptyToNull(raw.ageVerificationStatus),
    ageVerified: raw.ageVerified === true,
    isFriend,
    status: emptyToNull(raw.status),
    /*
     * Verbatim, including the word `offline`.
     *
     * VRChat sets `platform` to `"offline"` for somebody it considers offline — which it will say
     * about a person the game log has standing in the room, because the two answers come from
     * different places at different times. Deciding what that means is the UI's job and it has the
     * log to decide it with; collapsing it here would only move the guess somewhere with less
     * information.
     */
    platform: emptyToNull(raw.platform),
    developerType: emptyToNull(raw.developerType),
  };
}

/**
 * A VRChat group as the wire shape, or `null` when it cannot be identified.
 *
 * **Every field of both `RepresentedGroup` and `LimitedUserGroups` is optional upstream**, which is
 * why this is defensive to the point of tedium: without an id the UI has nothing to key a row on or
 * link to, so such an entry is dropped rather than rendered as a group with no identity. The name
 * falls back through the short code to the id so a row always has something to print.
 *
 * The parameter is a structural subset rather than `RepresentedGroup & LimitedUserGroups`, because
 * those two genuinely conflict: `memberVisibility` is a three-way union on one and a bare `string`
 * on the other, so under `exactOptionalPropertyTypes` their intersection is a type neither can
 * satisfy. Naming the fields actually read is narrower *and* honest about what this needs — the
 * same reasoning as `UserImageFields`.
 */
interface GroupFields {
  readonly groupId?: string | undefined;
  readonly name?: string | undefined;
  readonly shortCode?: string | undefined;
  readonly discriminator?: string | undefined;
  readonly iconUrl?: string | null | undefined;
  readonly bannerUrl?: string | null | undefined;
  readonly memberCount?: number | undefined;
  readonly privacy?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly description?: string | undefined;
  readonly isRepresenting?: boolean | undefined;
  readonly mutualGroup?: boolean | undefined;
}

function toGroupSummary(raw: GroupFields): GroupSummary | null {
  const id = emptyToNull(raw.groupId);
  if (id === null) return null;

  const shortCode = emptyToNull(raw.shortCode);

  return {
    id,
    name: emptyToNull(raw.name) ?? shortCode ?? id,
    shortCode,
    discriminator: emptyToNull(raw.discriminator),
    iconUrl: emptyToNull(raw.iconUrl),
    bannerUrl: emptyToNull(raw.bannerUrl),
    memberCount: typeof raw.memberCount === "number" ? raw.memberCount : null,
    privacy: emptyToNull(raw.privacy),
    ownerId: emptyToNull(raw.ownerId),
    description: emptyToNull(raw.description),
    // Passed through, never inferred from which endpoint answered. `/groups/represented` returning
    // a group is not itself proof of representation — VRChat owns that flag, and a UI that draws a
    // "representing" badge should be drawing VRChat's answer rather than ours.
    isRepresenting: raw.isRepresenting === true,
    // Passed through on the same terms. `LimitedUserGroups` is the only payload that carries it,
    // so every other caller of this mapper gets `false` — see `GroupSummary.mutualGroup`.
    mutualGroup: raw.mutualGroup === true,
  };
}

/**
 * One gallery off `Group.galleries`, or `null` when it has no id.
 *
 * Dropped rather than defaulted, for the reason every mapper in this file drops: without an id there
 * is nothing to fetch its images with and nothing to key the tab on, and a duplicate key in an
 * `{#each}` is a hard runtime error in Svelte 5 rather than a warning.
 */
function toGroupGallery(raw: GroupGallery): GroupGallerySummary | null {
  const id = emptyToNull(raw.id);
  if (id === null) return null;

  return {
    id,
    name: emptyToNull(raw.name) ?? id,
    description: emptyToNull(raw.description),
    membersOnly: raw.membersOnly === true,
  };
}

/**
 * One row of a group's member list, or `null` when it cannot be identified.
 *
 * **`GroupMember` is `| null` upstream** — the spec says so, for "a user who is not part of the
 * group" — so an entry can legally be a bare `null` inside the array, and a `.map` that assumed an
 * object would throw on the whole page rather than lose one row.
 *
 * Both ids are kept and neither substitutes for the other: `id` is the *membership* row, which is
 * what a moderation action names, and `userId` is the person, which is what the user modal opens on.
 * VRChat gives the membership row the shorter name, which is exactly how they get swapped.
 */
function toGroupMember(raw: GroupMember): GroupMemberSummary | null {
  if (raw === null || typeof raw !== "object") return null;

  const id = emptyToNull(raw.id);
  const userId = emptyToNull(raw.userId);
  if (id === null || userId === null) return null;

  const user = raw.user ?? null;

  return {
    id,
    userId,
    displayName: emptyToNull(user?.displayName) ?? userId,
    /*
     * `GroupMemberLimitedUser` carries the same images under different names — `iconUrl` is what
     * every other shape calls `userIcon`, and `thumbnailUrl` is its thumbnail — so the fields are
     * renamed onto `UserImageFields` rather than picked here by hand. One preference order for the
     * whole app is the point of that helper; a second one written out inline is how the group
     * screen ends up preferring a different image from the friends list for the same person.
     */
    iconUrl: pickUserImageUrl({
      userIcon: user?.iconUrl,
      profilePicOverrideThumbnail: user?.thumbnailUrl,
      profilePicOverride: user?.profilePicOverride,
      currentAvatarThumbnailImageUrl: user?.currentAvatarThumbnailImageUrl,
    }),
    joinedAt: unixMsFromDate(raw.joinedAt),
    roleIds: stringArray(raw.roleIds),
    isRepresenting: raw.isRepresenting === true,
  };
}

/**
 * One announcement, or `null` when it has no id.
 *
 * `authorDisplayName` is handed in rather than read off the body: **`GroupPost` carries an
 * `authorId` and no name at all.** The caller resolves it from local state — the same trick, and the
 * same zero-request cost, as `trustLevel` on a mutual friend — and null is the ordinary answer,
 * because group staff are usually strangers to whoever is reading the board.
 */
function toGroupPost(raw: GroupPost, authorDisplayName: string | null): GroupPostSummary | null {
  const id = emptyToNull(raw.id);
  if (id === null) return null;

  return {
    id,
    title: emptyToNull(raw.title),
    text: emptyToNull(raw.text),
    authorId: emptyToNull(raw.authorId),
    authorDisplayName,
    createdAt: unixMsFromDate(raw.createdAt),
    imageUrl: emptyToNull(raw.imageUrl),
  };
}

/**
 * One open group instance, or `null` when it has no location.
 *
 * The world is flattened onto the row — see {@link GroupInstanceSummary} for why it is four fields
 * rather than a nested summary. They cost nothing either way: VRChat embeds the entire `World`
 * record in this response, so fetching the world separately would be paying twice for bytes already
 * on the wire.
 *
 * `location` is what is required rather than `instanceId`, because the location is the only one of
 * the two a join or an instance lookup can be built from.
 */
function toGroupInstance(raw: Partial<GroupInstance>): GroupInstanceSummary | null {
  const location = emptyToNull(raw.location);
  if (location === null) return null;

  const world = toWorldSummary(raw.world);

  return {
    instanceId: emptyToNull(raw.instanceId) ?? location,
    location,
    memberCount: numberOrNull(raw.memberCount),
    worldId: world?.id ?? null,
    worldName: world?.name ?? null,
    worldThumbnailImageUrl: world?.thumbnailImageUrl ?? null,
    worldCapacity: world?.capacity ?? null,
  };
}

/** One gallery image, or `null` when it has no id. */
function toGroupGalleryImage(raw: GroupGalleryImage): GroupGalleryImageSummary | null {
  const id = emptyToNull(raw.id);
  if (id === null) return null;

  return {
    id,
    imageUrl: emptyToNull(raw.imageUrl),
    submittedByUserId: emptyToNull(raw.submittedByUserId),
    createdAt: unixMsFromDate(raw.createdAt),
  };
}

/**
 * One mutual friend as the wire shape, or `null` when it has no id.
 *
 * `trustLevel` cannot come from the payload: **`MutualFriend` carries no `tags`**, and
 * `trustLevelOf(undefined)` is `"visitor"` — so deriving it from the response would confidently
 * label every mutual friend a visitor. It comes from `trustLevel` instead, which the caller reads
 * out of local state: a mutual friend is by definition one of *your* friends, so presence and
 * `friend_log` both already know their rank, for free.
 */
function toMutualFriend(
  raw: Partial<MutualFriend>,
  trustLevel: string,
  knownStatus: string | null,
): MutualFriendSummary | null {
  if (typeof raw.id !== "string" || raw.id === "") return null;

  return {
    id: raw.id,
    displayName:
      typeof raw.displayName === "string" && raw.displayName !== "" ? raw.displayName : raw.id,
    iconUrl: pickUserImageUrl(raw),
    trustLevel,
    /*
     * Presence is the fallback, and it is doing the real work here.
     *
     * The spec gives `MutualFriend` a `status`, and in practice the field arrives empty — the same
     * way `tags` is absent despite being specified, two lines up. Defaulting an empty one straight
     * to `"offline"` meant the whole tab rendered every mutual friend as offline, confidently and
     * always, next to a hover card reading their real status off `GET /users/{id}`.
     *
     * A mutual friend is by definition one of this account's own friends, so presence is holding a
     * live answer for them already, kept current by the socket. It costs nothing to ask.
     */
    status: emptyToNull(raw.status) ?? knownStatus ?? "offline",
  };
}

/**
 * A world as the batch resolver serves it, or `null` when it has no id.
 *
 * The name falls back to the id rather than to `""`, because the entire point of this endpoint is
 * that the UI stops printing `wrld_0ae3e886-52e…` — an empty label would be a worse answer than the
 * id the UI already had.
 */
function toWorldSummary(raw: Partial<World> | null | undefined): WorldSummary | null {
  if (!raw || typeof raw.id !== "string" || raw.id === "") return null;

  return {
    id: raw.id,
    name: emptyToNull(raw.name) ?? raw.id,
    thumbnailImageUrl: emptyToNull(raw.thumbnailImageUrl),
    authorName: emptyToNull(raw.authorName),
    capacity: numberOrNull(raw.capacity),
  };
}

/** The full world record. `cached` and `fetchedAt` carry the same meaning as on `UserDetail`. */
/**
 * `World.instances`, which the spec types as `Array<[unknown, unknown]>` and means it.
 *
 * There is no item schema upstream, so every element is validated rather than trusted: in practice
 * each is `[instanceId, occupantCount]`, but a build that assumed that and met something else would
 * throw inside a list route. Anything unrecognisable is skipped, because one malformed tuple is not
 * a reason to lose the instances that did decode.
 *
 * The instance id arrives *with* its tags (`12345~region(eu)`), which is what makes
 * `${worldId}:${instanceId}` a real location string rather than a prefix of one.
 */
function readWorldInstances(
  world: { instances?: unknown } | null,
): { instanceId: string; userCount: number | null }[] {
  const raw = world?.instances;
  if (!Array.isArray(raw)) return [];

  const out: { instanceId: string; userCount: number | null }[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const [id, count] = entry as [unknown, unknown];
    if (typeof id !== "string" || id === "") continue;
    out.push({
      instanceId: id,
      userCount: typeof count === "number" && Number.isFinite(count) ? count : null,
    });
  }
  return out;
}

function toWorldDetail(raw: World, fetchedAt: number, cached: boolean): WorldDetail {
  const summary = toWorldSummary(raw);

  return {
    id: summary?.id ?? raw.id,
    name: summary?.name ?? raw.id,
    thumbnailImageUrl: summary?.thumbnailImageUrl ?? null,
    authorName: summary?.authorName ?? null,
    capacity: summary?.capacity ?? null,

    description: emptyToNull(raw.description),
    authorId: emptyToNull(raw.authorId),
    imageUrl: emptyToNull(raw.imageUrl),
    recommendedCapacity: numberOrNull(raw.recommendedCapacity),
    tags: stringArray(raw.tags),
    releaseStatus: emptyToNull(raw.releaseStatus),
    visits: numberOrNull(raw.visits),
    favorites: numberOrNull(raw.favorites),
    heat: numberOrNull(raw.heat),
    popularity: numberOrNull(raw.popularity),
    occupants: numberOrNull(raw.occupants),
    // VRChat sends the literal string `"none"` for an unpublished world, and `Date.parse("-5")`
    // succeeds as a *year* — so the date-shaped guard is what stands between "not published" and a
    // confident wrong timestamp. Same function, same reason, as `dateJoined`.
    publicationDate: unixMsFromDate(raw.publicationDate),
    labsPublicationDate: unixMsFromDate(raw.labsPublicationDate),
    createdAt: unixMsFromDate(raw.created_at),
    updatedAt: unixMsFromDate(raw.updated_at),
    version: numberOrNull(raw.version),

    fetchedAt,
    cached,
  };
}

/**
 * The avatar record, projected.
 *
 * Named fields rather than a passthrough, and the omissions are the point: `unityPackages`,
 * `assetUrl` and `unityPackageUrl` are download locations for the avatar's actual build, and
 * `publishedListings` is store inventory. None of it belongs on a card, and re-serving asset URLs
 * from a local API is a distribution question this app has no reason to open.
 */
function toAvatarDetail(
  raw: Partial<Avatar>,
  fetchedAt: number,
  cached: boolean,
  seenByAccountId: string | null,
): AvatarDetail {
  const id = emptyToNull(raw.id) ?? "";

  return {
    id,
    name: emptyToNull(raw.name) ?? id,
    description: emptyToNull(raw.description),
    authorId: emptyToNull(raw.authorId),
    authorName: emptyToNull(raw.authorName),
    imageUrl: emptyToNull(raw.imageUrl),
    thumbnailImageUrl: emptyToNull(raw.thumbnailImageUrl),
    releaseStatus: emptyToNull(raw.releaseStatus),
    tags: stringArray(raw.tags),
    version: numberOrNull(raw.version),
    // Same date-shaped guard as everywhere else here: `Date.parse("-5")` succeeds as a year, so
    // VRChat's `""` would otherwise become a confident wrong timestamp.
    createdAt: unixMsFromDate(raw.created_at),
    updatedAt: unixMsFromDate(raw.updated_at),
    fetchedAt,
    cached,
    seenByAccountId,
  };
}

/** One instance record as the wire shape. The two ids come from the *validated* location. */
function toInstanceInfo(raw: Partial<Instance>, worldId: string, instanceId: string): InstanceInfo {
  return {
    // Taken from the location the caller asked about rather than echoed from the body: those two
    // halves have already been through the allowlist, and the body's have not.
    worldId,
    instanceId,
    // The name a group instance was given, when it has one. `name` is usually the instance number
    // again, so it is passed through separately rather than folded in: a caller that wants a
    // heading wants `displayName` or nothing, not the number twice.
    displayName: emptyToNull(raw.displayName),
    name: emptyToNull(raw.name),
    type: emptyToNull(raw.type),
    ownerId: emptyToNull(raw.ownerId),
    region: emptyToNull(raw.region),
    capacity: numberOrNull(raw.capacity),
    userCount: numberOrNull(raw.userCount),
    // Both, because they can disagree: `n_users` and `userCount` are computed differently upstream
    // and picking one silently would make the header argue with the roster underneath it.
    nUsers: numberOrNull(raw.n_users),
    full: raw.full === true,
    canRequestInvite: raw.canRequestInvite === true,
    closedAt: unixMsFromDate(raw.closedAt),
    hardClose: typeof raw.hardClose === "boolean" ? raw.hardClose : null,
    queueEnabled: raw.queueEnabled === true,
    queueSize: numberOrNull(raw.queueSize),
    tags: stringArray(raw.tags),
    active: raw.active === true,
    world: toWorldSummary(raw.world),
  };
}

/** A finite number, or null. Guards against VRChat's occasional `null` in a numeric field. */
function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One entry of `PublicProfile.badges`, or null when VRChat sent something unidentifiable.
 *
 * Dropped rather than defaulted: a badge with no id cannot be keyed in an `{#each}`, and a
 * duplicate key is a hard runtime error in Svelte 5 rather than a warning.
 */
function toUserBadge(raw: Badge): UserBadge | null {
  const id = emptyToNull(raw.badgeId);
  if (id === null) return null;

  return {
    id,
    name: emptyToNull(raw.badgeName) ?? id,
    description: emptyToNull(raw.badgeDescription),
    imageUrl: emptyToNull(raw.badgeImageUrl),
    showcased: raw.showcased === true,
  };
}

/** `GET /profile/{id}`'s body, reduced to the fields the modal renders. */
function toProfileCard(raw: PublicProfile): UserProfileCard {
  const badges = Array.isArray(raw.badges)
    ? raw.badges.map(toUserBadge).filter((badge): badge is UserBadge => badge !== null)
    : [];

  return {
    languages: stringArray(raw.languages),
    // Two passes rather than a sort on a boolean: VRChat's own order within each half is the
    // user's chosen order, and partitioning keeps it without depending on sort stability.
    badges: [...badges.filter((b) => b.showcased), ...badges.filter((b) => !b.showcased)],
    hasVrcPlus: raw.hasVrcPlus === true,
    bannerColor: emptyToNull(raw.bannerColor),
  };
}

/**
 * What one `user_cache` row holds.
 *
 * The row used to be VRChat's `/users/{id}` body verbatim. The represented group and the profile
 * card are *further* upstream calls with the same staleness profile, so they belong in the same row
 * under the same TTL rather than in caches that could disagree with the first — hence an envelope.
 * `v` is what tells a new daemon what an older one wrote: a bare user body (no `v`), or a `v: 2`
 * row with no profile card. Neither is discarded; both simply lack the newer halves and are
 * rewritten complete on their next miss, within one TTL of the upgrade.
 */
interface UserCacheEnvelope {
  v: 3;
  user: User;
  representedGroup: GroupSummary | null;
  profileCard: UserProfileCard | null;
}

interface CachedUser {
  user: User;
  representedGroup: GroupSummary | null;
  profileCard: UserProfileCard | null;
}

function readUserCache(data: string): CachedUser | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const version = (parsed as Partial<UserCacheEnvelope>).v;
  if (version === 3) {
    const envelope = parsed as UserCacheEnvelope;
    return {
      user: envelope.user,
      representedGroup: envelope.representedGroup,
      profileCard: envelope.profileCard,
    };
  }
  if (version === 2) {
    // Written before the profile card existed. The group is trustworthy; the card is genuinely
    // unknown, which is exactly what `null` means on the wire — not "this person has no badges".
    const envelope = parsed as { user: User; representedGroup: GroupSummary | null };
    return { user: envelope.user, representedGroup: envelope.representedGroup, profileCard: null };
  }
  // A pre-envelope row. Legible, just missing both later halves.
  return { user: parsed as User, representedGroup: null, profileCard: null };
}

function toControlAccount(
  snapshot: AccountSnapshot,
  addedAt: number,
  meter: RequestMeter | null,
): ControlAccount {
  return {
    id: snapshot.id,
    displayName: snapshot.displayName ?? snapshot.username,
    addedAt,
    enabled: true,
    lastSeenAt: snapshot.state === "online" ? Date.now() : null,
    connection: connectionOf(snapshot),
    iconUrl: snapshot.iconUrl,
    // An empty series rather than a missing field when nothing is metered: the card draws a flat
    // line, which is true, instead of branching on whether the daemon happens to be measuring.
    rate: meter?.account(snapshot.id) ?? emptySeries(),
  };
}

export function createControlDeps(options: ControlDepsOptions): ControlDeps {
  const { accounts, store, bus, limiter, secrets, presence, connectPipeline } = options;
  let settings = options.settings;

  /**
   * Live event-stream sockets. The consent alerts read it to decide whether anyone is watching:
   * with a UI connected the app raises its own sheet, and an OS notification plus an unbidden
   * browser tab on top of that is the kind of "help" that trains people to dismiss things unread.
   */
  let streamClients = 0;

  /**
   * The once-a-second reading, built fresh per tick.
   *
   * Only non-zero keys are carried. An idle daemon with six accounts and four connected apps sends
   * `{total:0,accounts:{},grants:{}}` rather than ten zeroes, and a key's absence means zero — the
   * same statement, an order of magnitude smaller, every second, forever.
   */
  function rateFrame(): RateFrame {
    const meter = options.meter;
    const live = limiter.snapshot();
    const accountRates: Record<string, number> = {};
    const grantRates: Record<string, number> = {};

    if (meter !== undefined) {
      for (const snapshot of accounts.list()) {
        const rate = meter.currentAccount(snapshot.id);
        if (rate > 0) accountRates[snapshot.id] = rate;
      }
      for (const grant of store.listGrants()) {
        if (grant.revoked_at !== null) continue;
        const rate = meter.currentGrant(grant.id);
        if (rate > 0) grantRates[grant.id] = rate;
      }
    }

    return {
      total: meter?.currentTotal() ?? 0,
      accounts: accountRates,
      grants: grantRates,
      limit: limiter.globalRatePerSecond,
      queued: live.queuedTotal,
      retryAfter: live.retryAfter,
    };
  }

  /**
   * The display name of one game client, memoised across every stream subscriber.
   *
   * A `SELECT` per event per socket would be a query per player join per open tab, and a busy
   * public instance is dozens of joins a second. The cache is keyed by session row id, which never
   * changes meaning, and is refreshed when a `session.*` event says the identity moved — a session
   * starts before its log has revealed who is signed in, so the first answer for a new session is
   * legitimately null and must not be the last one.
   */
  const sessionNames = new Map<number, string | null>();

  function sessionDisplayName(sessionId: number | null): string | null {
    if (sessionId === null) return null;
    const cached = sessionNames.get(sessionId);
    if (cached !== undefined) return cached;
    const name = store.getSession(sessionId)?.display_name ?? null;
    sessionNames.set(sessionId, name);
    return name;
  }

  // The identity line arrives after the session row does, so a cached null is provisional. Every
  // session event drops the entry rather than trying to patch it — the store is the authority and
  // re-reading one row is cheaper than getting this subtly wrong.
  bus.subscribe(
    (event) => {
      if (event.sessionId !== null && event.sessionId !== undefined) {
        sessionNames.delete(event.sessionId);
      }
    },
    { kinds: ["session.*"] },
  );

  // One cache for the whole daemon. Its de-duplication only works if every caller shares it, and a
  // per-request instance would also re-run the eviction sweep on every avatar.
  const images = new ImageCache(options.env === undefined ? {} : { env: options.env });

  /**
   * The account named, if it can actually act right now.
   *
   * Distinct from `onlineAccount` below, which answers "whose eyes should read this?" and falls
   * back to any signed-in account. This one never falls back: these routes act *as* a named person,
   * so guessing which person would be the worst possible kind of helpful.
   *
   * Every "do a thing to another person" route needs the same two checks, and both are worth making
   * *before* the call rather than letting `vrcFetch` discover them: an account sitting on a 2FA
   * challenge has no auth cookie, and a 401 inside the request would trigger a re-auth into a
   * challenge nobody is watching.
   */
  function actingAccount(accountId: string, doing: string): Account {
    const account = accounts.get(accountId);
    if (!account) throw new ControlError(404, "unknown_account");
    if (account.snapshot().state !== "online") {
      throw new ControlError(
        409,
        "account_offline",
        `That account is not signed in, so vrc.zip cannot ${doing}.`,
      );
    }
    return account;
  }

  /**
   * A POST made in the user's name, with the three upstream answers that mean different things kept
   * apart.
   *
   * 403 and 404 are *outcomes*, not faults: the person has invites off, or they are not there any
   * more. Collapsing them into one "it failed" is what makes an app feel broken when it is in fact
   * working and the answer is simply no. Everything else is a 502, because it is VRChat's problem
   * and the user can do nothing about it.
   */
  async function sendAsUser(
    account: Account,
    path: string,
    body: Record<string, JsonValue>,
    what: string,
  ): Promise<void> {
    const response = await vrcFetch(account.context(), path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Drained either way: an undrained body holds the connection open, and the success signal here
    // is the status rather than the notification object VRChat hands back.
    const text = await response.text().catch(() => "");
    if (response.ok) return;

    if (response.status === 403) {
      throw new ControlError(
        403,
        "send_forbidden",
        `VRChat will not deliver that ${what}. They may not accept them from you.`,
      );
    }
    if (response.status === 404) {
      throw new ControlError(404, "unknown_target", "VRChat does not know that user any more.");
    }
    throw new ControlError(
      502,
      "send_failed",
      `VRChat returned ${String(response.status)}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
    );
  }

  /**
   * Instance records, keyed `accountId\nlocation`, serving both the roster and the header.
   *
   * The account is **in the key**, not just in the value. VRChat fills in `users` only for the
   * account that created the instance, and `isFriend` is one account's fact about another
   * person — so a record read through one account is not an answer for a different one, exactly as
   * `user_cache` is keyed per viewer (migration 002). In memory rather than in SQLite because it is
   * stale within a minute; persisting it would only serve a dead room to the next cold start.
   */
  const instances = new Map<string, CachedInstance>();
  /**
   * The single fetch currently in flight per key, so a polling screen with three viewers open makes
   * one upstream call rather than three. Cleared in a `finally` — same shape, and the same reason,
   * as `ImageCache`'s in-flight map: a failure must not pin a rejected promise that every later
   * caller inherits.
   */
  const instancesInFlight = new Map<string, Promise<CachedInstance>>();
  /** The same de-duplication for worlds, keyed by world id alone. See {@link loadWorld}. */
  const worldsInFlight = new Map<string, Promise<{ world: World; fetchedAt: number } | null>>();

  function accountRowAddedAt(id: string): number {
    return store.getAccount(id)?.added_at ?? Date.now();
  }

  /**
   * Resolves "whose eyes" for the per-account user routes.
   *
   * A named account must exist — a 404 rather than a silent fall back to a different account,
   * because "the app acted as the wrong account" is the worst failure mode this system has
   * (decision 7). With no name, an online account is preferred and any configured account will
   * do: the note routes need no network, and a fresh cache row can be served by an account that
   * has since gone offline.
   */
  function pickAccount(accountId: string | null): Account {
    if (accountId !== null) {
      const named = accounts.get(accountId);
      if (!named) throw new ControlError(404, "unknown_account");
      return named;
    }

    const snapshots = accounts.list();
    const chosen = snapshots.find((s) => s.state === "online") ?? snapshots[0];
    const account = chosen ? accounts.get(chosen.id) : undefined;
    if (!account) {
      throw new ControlError(503, "no_account", "No account is configured.");
    }
    return account;
  }

  /**
   * The account for a user route, guaranteed to be signed in.
   *
   * Split out because all four user routes want the same two sentences: a named account must exist
   * (404, never a silent fall back to someone else's eyes), and a live fetch needs a live cookie.
   * Saying so beats letting `vrcFetch` discover it as a 401 and re-auth into a 2FA challenge that
   * nobody is watching.
   */
  function onlineAccount(accountId: string | null): Account {
    const account = pickAccount(accountId);
    if (account.snapshot().state !== "online") {
      throw new ControlError(
        503,
        "no_account",
        "No account is signed in, so VRChat has nobody to ask about this user.",
      );
    }
    return account;
  }

  /**
   * One GET against VRChat, parsed, with the error mapping the profile routes share.
   *
   * `code` names the failure for the UI to branch on. A 404 defaults to `unknown_user` because
   * every path this started life serving hangs off `/users/{id}`; the group route passes its own,
   * because a 404 there means the group is gone or invisible to this account, and telling the UI a
   * *user* was not found would send it down the wrong branch entirely.
   */
  async function vrcJson(
    account: Account,
    path: string,
    code: string,
    missing: { code: string; message: string } = {
      code: "unknown_user",
      message: "VRChat has no such user.",
    },
    /**
     * What a 403 means on this path, when it means anything in particular.
     *
     * Left undefined by default so a 403 falls through to the generic 502 below, which is right for
     * every route that had one before the group sub-resources: an account that is signed in should
     * not be forbidden its own friends list, so a 403 there is genuinely an upstream surprise. The
     * group routes are the opposite case — a non-member being refused a member list is the *normal*
     * answer, and it needs a code the UI can branch on.
     */
    forbidden?: { code: string; message: string },
  ): Promise<unknown> {
    const response = await vrcFetch(account.context(), path);
    const body = await response.text();

    if (response.status === 404) {
      throw new ControlError(404, missing.code, missing.message);
    }
    if (response.status === 403 && forbidden !== undefined) {
      throw new ControlError(403, forbidden.code, forbidden.message);
    }
    if (!response.ok) {
      throw new ControlError(502, code, `VRChat returned ${String(response.status)}`);
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new ControlError(502, code, "VRChat returned a non-JSON body");
    }
  }

  /**
   * A GET against one of the group sub-resources, with the error contract all four share.
   *
   * The **403 is the whole reason this exists**. Membership is required to read the member list, the
   * board, or a members-only gallery on most groups, and VRChat refuses a non-member with a 403
   * rather than an empty body. Letting that fall through to the generic 502 — or worse, swallowing
   * it into `[]` — would put "this group has no members" on screen in front of a group with four
   * hundred of them. `group_forbidden` is what lets the UI say "membership required" instead.
   *
   * The 404 stays `unknown_group` and keeps `getGroup`'s wording, because the two causes VRChat
   * cannot distinguish there are the same two here.
   */
  function groupSubresource(account: Account, path: string, code: string): Promise<unknown> {
    return vrcJson(
      account,
      path,
      code,
      {
        code: "unknown_group",
        message: "VRChat has no such group, or this account cannot see it.",
      },
      {
        code: "group_forbidden",
        message: "This group only shows that to its members.",
      },
    );
  }

  /**
   * The group this user represents, or null — and null is the *common* case.
   *
   * VRChat answers this endpoint `200 {}` for someone representing nothing, so an empty object is
   * a normal answer rather than a broken one. A genuine failure is swallowed too, deliberately: the
   * represented group is one badge on a modal, and letting it fail the whole profile would trade a
   * missing badge for a missing person.
   */
  async function fetchRepresentedGroup(
    account: Account,
    userId: string,
  ): Promise<GroupSummary | null> {
    let raw: unknown;
    try {
      raw = await vrcJson(account, `/users/${userId}/groups/represented`, "group_fetch_failed");
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null) return null;
    return toGroupSummary(raw as Partial<RepresentedGroup>);
  }

  /**
   * The profile page's own half of this user, or null — best-effort, exactly like the represented
   * group and for the same reason: it decorates the modal, so losing it must cost a badge row, not
   * the person. Every failure mode (404, 502, non-JSON) lands on the same null.
   *
   * `/profile/{id}` is a **supplement to** `/users/{id}`, never a replacement: it answers with the
   * profile page's cosmetics — badges, languages, VRC+, banner colour — and carries no presence at
   * all. Anything the app knows about where somebody is still comes from the user record.
   *
   * Returns whether the user represents a group alongside the card, because
   * `PublicProfile.representedGroup` settles that yes/no in a call we are already making. Its shape
   * there is thinner than `/users/{id}/groups/represented`'s — no member count, no short code, no
   * privacy — so it is used as a **predicate, never as the value**. See `getUser`.
   */
  async function fetchPublicProfile(
    account: Account,
    userId: string,
  ): Promise<{ card: UserProfileCard; representsGroup: boolean } | null> {
    let raw: unknown;
    try {
      raw = await vrcJson(account, `/profile/${userId}`, "profile_fetch_failed");
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null) return null;

    const profile = raw as PublicProfile;
    return {
      card: toProfileCard(profile),
      representsGroup: emptyToNull(profile.representedGroup?.id) !== null,
    };
  }

  /**
   * The one upstream call behind both `GET /api/instance-users` and `GET /api/instances`.
   *
   * `location` has already been through `parseInviteLocation`, so every character in it is one
   * percent-encoding leaves alone — which is what makes interpolating it into the path safe, and
   * is the same argument as `inviteSelfTo`'s.
   *
   * Returns the raw record rather than either wire shape, because the two routes read *different
   * halves of the same response*: the roster wants `users`, the header wants the counts and the
   * region. Mapping here would mean fetching twice for one answer.
   */
  async function fetchInstance(account: Account, location: string): Promise<CachedInstance> {
    const fetchedAt = Date.now();

    const response = await vrcFetch(account.context(), `/instances/${location}`);
    const body = await response.text();

    // A 404 is an instance that has closed, which is the ordinary end of every instance rather
    // than a fault. The screen keeps the names the game log gave it instead of showing an error
    // for a room everybody left.
    if (response.status === 404) return { fetchedAt, instance: null };
    if (!response.ok) {
      throw new ControlError(
        502,
        "instance_fetch_failed",
        `VRChat returned ${String(response.status)}`,
      );
    }

    let instance: Partial<Instance> | null;
    try {
      instance = JSON.parse(body) as Partial<Instance> | null;
    } catch {
      throw new ControlError(502, "instance_fetch_failed", "VRChat returned a non-JSON body");
    }

    // `getInstance` answers a bare `null` — with a 200! — for an instance id it does not like.
    // Documented upstream, and a `TypeError` here if it were not checked.
    if (instance === null || typeof instance !== "object") return { fetchedAt, instance: null };

    // The instance response embeds the *whole* world record, so the world cache gets warmed for
    // free. A feed row naming this world resolves without ever asking `/worlds/{id}`.
    const world = instance.world;
    if (world && typeof world.id === "string" && world.id !== "") {
      store.putWorldCache(world.id, fetchedAt, JSON.stringify(world));
    }

    return { fetchedAt, instance };
  }

  /**
   * A cached instance record, or a fresh one.
   *
   * `requireUsers` is what keeps the two routes honest about a shared cache: a record fetched for
   * the header may carry no `users` at all, and that is no roster, so the roster path refuses to be
   * answered from one and refetches. It does *not* refetch when the cached answer is "there is no
   * such instance": that is a complete answer to both questions, and a closed instance under a
   * polling screen would otherwise be re-asked every tick for as long as the screen is open.
   *
   * Worth knowing what this refetch can and cannot buy, because the reason it was written down was
   * wrong: `users` comes back for instances the account **created**, not for ones it is standing in
   * (see `InstanceRoster`), and that fact does not change while an instance lives. So the refetch
   * only ever helps in the narrow window where the header was read before the account's own
   * instance existed. It is kept because it is bounded — the UI holds an answer for 15s and the
   * record is evicted at the TTL — but it is not the safety net the old comment claimed.
   */
  async function loadInstance(
    account: Account,
    location: string,
    requireUsers: boolean,
  ): Promise<CachedInstance> {
    const key = `${account.id}\n${location}`;
    const now = Date.now();

    // Swept on every call. The map is one entry per instance a screen is watching — a handful — so
    // this is cheaper than any scheduled sweep, and it keeps a daemon left open for a week from
    // holding every room its user ever looked at.
    for (const [cachedKey, cached] of instances) {
      if (now - cached.fetchedAt >= INSTANCE_ROSTER_TTL_MS) instances.delete(cachedKey);
    }

    const fresh = instances.get(key);
    if (
      fresh !== undefined &&
      (!requireUsers || fresh.instance === null || Array.isArray(fresh.instance.users))
    ) {
      return fresh;
    }

    const pending = instancesInFlight.get(key);
    if (pending !== undefined) return await pending;

    const work = fetchInstance(account, location)
      .then((entry) => {
        instances.set(key, entry);
        return entry;
      })
      .finally(() => {
        instancesInFlight.delete(key);
      });

    instancesInFlight.set(key, work);
    return await work;
  }

  /**
   * One world, from `world_cache` if it is fresh there.
   *
   * The de-duplication is per world id and **not** per account, matching the cache: two screens
   * asking for the same world at once share one fetch even through different accounts, because a
   * world is the same object whoever asked.
   */
  async function loadWorld(
    account: Account,
    worldId: string,
  ): Promise<{ world: World; fetchedAt: number } | null> {
    const pending = worldsInFlight.get(worldId);
    if (pending !== undefined) return await pending;

    const work = (async (): Promise<{ world: World; fetchedAt: number } | null> => {
      const response = await vrcFetch(account.context(), `/worlds/${worldId}`);
      const body = await response.text();

      // A deleted or private world. Null rather than a throw: the batch turns it into an absent
      // key, and only the single-world route calls it a 404.
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ControlError(
          502,
          "world_fetch_failed",
          `VRChat returned ${String(response.status)}`,
        );
      }

      let world: World;
      try {
        world = JSON.parse(body) as World;
      } catch {
        throw new ControlError(502, "world_fetch_failed", "VRChat returned a non-JSON body");
      }
      if (typeof world !== "object" || world === null) return null;

      const fetchedAt = Date.now();
      // Stored verbatim and **not** keyed by account: unlike `user_cache`, VRChat answers the same
      // world record to everyone, which is why migration 002 left this table global.
      store.putWorldCache(worldId, fetchedAt, body);
      return { world, fetchedAt };
    })().finally(() => {
      worldsInFlight.delete(worldId);
    });

    worldsInFlight.set(worldId, work);
    return await work;
  }

  /** The same de-duplication for avatars, keyed by avatar id alone. See {@link loadWorld}. */
  const avatarsInFlight = new Map<
    string,
    Promise<{ avatar: Partial<Avatar>; fetchedAt: number; seenByAccountId: string } | null>
  >();

  /**
   * The avtr.zip lookup, built on first use.
   *
   * Lazy because the User-Agent it must send needs the first-run contact, which is empty until the
   * user has set one — building eagerly would throw during construction of the whole control layer.
   * Null means "no valid contact yet", and null resolves to no avatar, which is the same honest
   * answer as any other miss.
   */
  let avatarIds: AvatarIdResolver | null = options.avatarIds ?? null;
  function avatarIdResolver(): AvatarIdResolver | null {
    if (avatarIds !== null) return avatarIds;
    let userAgent: string;
    try {
      userAgent = buildUserAgent(settings.contact);
    } catch {
      return null;
    }
    avatarIds = new AvatarIdResolver({
      userAgent,
      store,
      // Read per call rather than captured, so the switch takes effect the moment it is flipped.
      enabled: () => settings.resolveAvatarIds,
    });
    return avatarIds;
  }

  /** One avatar, from `avatar_cache` if it is fresh there. De-duplicated exactly like a world. */
  async function loadAvatar(
    account: Account,
    avatarId: string,
  ): Promise<{ avatar: Partial<Avatar>; fetchedAt: number; seenByAccountId: string } | null> {
    const pending = avatarsInFlight.get(avatarId);
    if (pending !== undefined) return await pending;

    const work = (async (): Promise<{
      avatar: Partial<Avatar>;
      fetchedAt: number;
      seenByAccountId: string;
    } | null> => {
      const response = await vrcFetch(account.context(), `/avatars/${avatarId}`);
      const body = await response.text();

      // A 404 here is the *ordinary* answer: VRChat only serves an avatar record to accounts
      // allowed to see it, so most avatars a feed names are private to their author.
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ControlError(
          502,
          "avatar_fetch_failed",
          `VRChat returned ${String(response.status)}`,
        );
      }

      let avatar: Partial<Avatar>;
      try {
        avatar = JSON.parse(body) as Partial<Avatar>;
      } catch {
        throw new ControlError(502, "avatar_fetch_failed", "VRChat returned a non-JSON body");
      }
      if (typeof avatar !== "object" || avatar === null) return null;

      const fetchedAt = Date.now();
      /*
       * One row per avatar, not per account, but the row remembers *who could see it*.
       *
       * The record itself is the same bytes for everyone VRChat answers at all, exactly as
       * `world_cache` assumes. Visibility is the part that is not shared: an avatar private to its
       * author 404s for every other account, so which account got an answer is a real fact about
       * this avatar and the only one a reader can act on. Stored in an envelope so a cache hit can
       * still say it; a bare body from an older build parses as `avatar` with no account named.
       */
      store.putAvatarCache(
        avatarId,
        fetchedAt,
        JSON.stringify({ v: 1, avatar, seenByAccountId: account.id }),
      );
      return { avatar, fetchedAt, seenByAccountId: account.id };
    })().finally(() => {
      avatarsInFlight.delete(avatarId);
    });

    avatarsInFlight.set(avatarId, work);
    return await work;
  }

  /** A fresh `avatar_cache` row, or null. A corrupt row is a miss, never a throw. */
  function cachedAvatar(
    avatarId: string,
    now: number,
  ): { avatar: Partial<Avatar>; fetchedAt: number; seenByAccountId: string | null } | null {
    const row = store.getAvatarCache(avatarId);
    if (row === null || now - row.fetched_at >= AVATAR_CACHE_TTL_MS) return null;
    try {
      const parsed = JSON.parse(row.data) as
        | { v?: number; avatar?: Partial<Avatar>; seenByAccountId?: unknown }
        | Partial<Avatar>;
      if (typeof parsed !== "object" || parsed === null) return null;

      // The envelope, or a bare body written before there was one. Both are valid rows; the older
      // shape simply cannot say which account saw it, which is what `null` means here.
      const envelope = parsed as {
        v?: number;
        avatar?: Partial<Avatar>;
        seenByAccountId?: unknown;
      };
      const isEnvelope = envelope.v === 1 && typeof envelope.avatar === "object";
      const avatar = isEnvelope ? (envelope.avatar ?? null) : (parsed as Partial<Avatar>);
      if (avatar === null || typeof avatar !== "object") return null;

      return {
        avatar,
        fetchedAt: row.fetched_at,
        seenByAccountId:
          isEnvelope && typeof envelope.seenByAccountId === "string"
            ? envelope.seenByAccountId
            : null,
      };
    } catch {
      return null;
    }
  }

  /** A fresh `world_cache` row, or null. Never throws on a corrupt row — it is treated as a miss. */
  function cachedWorld(worldId: string, now: number): { world: World; fetchedAt: number } | null {
    const row = store.getWorldCache(worldId);
    if (row === null || now - row.fetched_at >= WORLD_CACHE_TTL_MS) return null;
    try {
      const world = JSON.parse(row.data) as World;
      if (typeof world !== "object" || world === null) return null;
      return { world, fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }

  /**
   * An account to fetch with, or null when none is signed in.
   *
   * The 404 for a named-but-unknown account stays — that is a caller bug, not a degraded state —
   * but "nobody is online" is answered with null rather than a throw, so the batch resolver can
   * serve its cache hits instead of failing a hundred rows over a sign-in.
   */
  /**
   * The signed-in account both instance routes need, or a 503.
   *
   * Saying so beats letting `vrcFetch` discover it as a 401 and re-auth into a 2FA challenge that
   * nobody is watching.
   */
  function onlineInstanceAccount(accountId: string | null): Account {
    const account = availableAccount(accountId);
    if (account === null) {
      throw new ControlError(
        503,
        "no_account",
        "No account is signed in, so VRChat has nobody to ask about that instance.",
      );
    }
    return account;
  }

  function availableAccount(accountId: string | null): Account | null {
    if (accountId !== null) {
      const named = accounts.get(accountId);
      if (!named) throw new ControlError(404, "unknown_account");
      return named.snapshot().state === "online" ? named : null;
    }
    const online = accounts.list().find((snapshot) => snapshot.state === "online");
    return online ? (accounts.get(online.id) ?? null) : null;
  }

  /** Makes sure an account has a row before anything references it by foreign key. */
  function ensureAccountRow(snapshot: AccountSnapshot): void {
    store.upsertAccount({
      id: snapshot.id,
      display_name: snapshot.displayName ?? snapshot.username,
      added_at: accountRowAddedAt(snapshot.id),
      enabled: 1,
      last_seen_at: snapshot.state === "online" ? Date.now() : null,
    });
  }

  return {
    async status(): Promise<StatusSnapshot> {
      const live = limiter.snapshot();
      return {
        degradedKeychain: secrets.degraded,
        backend: secrets.backend,
        accounts: accounts.list().length,
        // Read off the limiter's own buckets. Every number here is measured — see
        // `RateLimitSnapshot`, which used to carry one invented ceiling and two invented readings.
        // `available` is floored because a bucket at 19.6 tokens has nineteen it can spend.
        rateLimit: {
          api: ceiling(live.globalApi),
          files: ceiling(live.files),
          accounts: live.perAccount.map((bucket) => ({
            accountId: bucket.accountId,
            ...ceiling(bucket),
          })),
          perAccountRate: limiter.ratePerSecond,
          queued: live.queuedTotal,
          retryAfter: live.retryAfter,
          consecutive429: live.consecutive429,
          // What the daemon is doing with those ceilings, as opposed to what they permit.
          used: options.meter?.total() ?? emptySeries(),
          windowSeconds: WINDOW_SECONDS,
        },
      };
    },

    async listAccounts(): Promise<ControlAccount[]> {
      return accounts
        .list()
        .map((s) => toControlAccount(s, accountRowAddedAt(s.id), options.meter ?? null));
    },

    async login(input): Promise<LoginResult> {
      if (settings.contact.trim() === "") {
        throw new ControlError(
          409,
          "setup_required",
          "Set a contact address in settings before signing in — VRChat requires one in the User-Agent.",
        );
      }

      try {
        const { result, account } = await accounts.add(input.username, input.password);

        if (result.status === "requires-2fa") {
          return { status: "requires-2fa", accountId: account.id, methods: result.methods };
        }

        ensureAccountRow(account.snapshot());
        connectPipeline(account.id);
        return {
          status: "ok",
          account: toControlAccount(
            account.snapshot(),
            accountRowAddedAt(account.id),
            options.meter ?? null,
          ),
        };
      } catch (error) {
        // A wrong password is a 401, not a 500 — the UI shows it inline on the form. The upstream
        // status is preserved rather than flattened, because 401 and 403 mean different things to
        // the person reading the message: one is "that password is wrong", the other is "VRChat
        // will not let this sign-in through", and only the second needs action outside vrc.zip.
        const message = error instanceof Error ? error.message : "Sign-in failed.";
        throw new ControlError(loginStatusOf(error), "login_failed", message);
      }
    },

    async verifyTwoFactor(accountId, input): Promise<ControlAccount> {
      const account = accounts.get(accountId);
      if (!account) throw new ControlError(404, "unknown_account");

      try {
        await accounts.verifyTwoFactor(accountId, input.method, input.code);
      } catch (error) {
        const message = error instanceof Error ? error.message : "That code was not accepted.";
        throw new ControlError(401, "verification_failed", message);
      }

      ensureAccountRow(account.snapshot());
      connectPipeline(account.id);
      return toControlAccount(
        account.snapshot(),
        accountRowAddedAt(account.id),
        options.meter ?? null,
      );
    },

    async removeAccount(accountId): Promise<void> {
      if (!accounts.get(accountId)) throw new ControlError(404, "unknown_account");
      await accounts.remove(accountId);
      // Cascades to events and sets sessions.account_id null, which is what the schema is for.
      store.deleteAccount(accountId);
    },

    async inviteSelfTo(accountId, target): Promise<void> {
      const account = accounts.get(accountId);
      if (!account) throw new ControlError(404, "unknown_account");

      // A self-invite needs a live auth cookie, and an account that is signed out or sitting on a
      // 2FA challenge has none. Saying so is better than letting `vrcFetch` discover it as a 401
      // and re-auth into a challenge nobody is watching.
      if (account.snapshot().state !== "online") {
        throw new ControlError(
          409,
          "account_offline",
          "That account is not signed in, so VRChat has nobody to send the invite to.",
        );
      }

      // Interpolated, not encoded: `parseInviteLocation` has already restricted both halves to
      // characters percent-encoding leaves alone, so encoding here would be a no-op that only
      // makes the path harder to read against VRChat's own spec.
      const path = `/invite/myself/to/${target.worldId}:${target.instanceId}`;
      const response = await vrcFetch(account.context(), path, { method: "POST" });

      // Drained either way — an undrained body holds the connection open, and nothing here wants
      // VRChat's notification object back. The UI's success signal is the HTTP status.
      const body = await response.text().catch(() => "");
      if (response.ok) return;

      // Three upstream answers mean genuinely different things to the person who clicked, so they
      // keep their own codes rather than collapsing into one "it failed".
      if (response.status === 403) {
        throw new ControlError(
          403,
          "invite_forbidden",
          "VRChat will not let this account into that instance.",
        );
      }
      if (response.status === 404) {
        throw new ControlError(404, "unknown_instance", "That instance no longer exists.");
      }
      throw new ControlError(
        502,
        "invite_failed",
        `VRChat returned ${String(response.status)}${body === "" ? "" : `: ${body.slice(0, 200)}`}`,
      );
    },

    async inviteUserTo(accountId, userId, target, messageSlot): Promise<void> {
      const account = actingAccount(accountId, "send the invite");
      await sendAsUser(
        account,
        `/invite/${userId}`,
        {
          instanceId: `${target.worldId}:${target.instanceId}`,
          ...(messageSlot === undefined ? {} : { messageSlot }),
        },
        "invite",
      );
    },

    async requestInviteFrom(accountId, userId, requestSlot): Promise<void> {
      const account = actingAccount(accountId, "ask for the invite");
      await sendAsUser(
        account,
        `/requestInvite/${userId}`,
        requestSlot === undefined ? {} : { requestSlot },
        "invite request",
      );
    },

    async boop(accountId, userId): Promise<void> {
      const account = actingAccount(accountId, "send the boop");
      // An empty body on purpose: `emojiId` and `inventoryItemId` decorate a boop, and neither the
      // palette nor anything else in the UI has a picker for one yet. Sending `{}` is the plain
      // boop, which is the thing being asked for.
      await sendAsUser(account, `/users/${userId}/boop`, {}, "boop");
    },

    async listInstanceUsers(target, accountId): Promise<InstanceRoster> {
      // Always a live fetch — there is no offline path worth serving, because a roster older than
      // the TTL is a list of people who have left.
      const account = onlineInstanceAccount(accountId);
      // Reassembled rather than carried alongside the split halves: `parseInviteLocation` cut the
      // raw string at its *first* colon, so this is character-for-character what the caller sent,
      // and there is only one validated copy of it in play.
      const location = `${target.worldId}:${target.instanceId}`;

      const entry = await loadInstance(account, location, true);
      const raw = entry.instance;

      // `users` is *optional* upstream, and rarer than it sounds: VRChat sends it only for an
      // instance this account created, so the roster for a group or public instance you are simply
      // standing in is absent. Not an error, and not unusual — see `InstanceRoster`.
      if (raw === null || !Array.isArray(raw.users)) {
        return { location, fetchedAt: entry.fetchedAt, source: "unavailable", users: [] };
      }

      /*
       * Friendship comes from the presence service — the friend list this account already holds in
       * memory — and therefore costs nothing. Asking VRChat per head would be exactly the forty
       * requests this whole route exists to avoid.
       *
       * The instance record's own `isFriend` is OR'd in rather than ignored: it rode along in the
       * response that was already being made, so it is free too, and it is the only answer
       * available in the seconds before an account's first friends poll lands.
       */
      const friends = new Set(presence.list(account.id).map((record) => record.id));

      const users = raw.users
        .map((entryUser: Partial<LimitedUserInstance>) =>
          toInstanceUser(
            entryUser,
            (typeof entryUser.id === "string" && friends.has(entryUser.id)) ||
              entryUser.isFriend === true,
          ),
        )
        .filter((user): user is InstanceUser => user !== null);

      return { location, fetchedAt: entry.fetchedAt, source: "instance", users };
    },

    async getInstance(target, accountId): Promise<InstanceDetail> {
      const account = onlineInstanceAccount(accountId);
      const location = `${target.worldId}:${target.instanceId}`;

      // `false`: unlike the roster, this route reads only fields VRChat sends on every instance
      // record, so a record cached by either route answers it.
      const entry = await loadInstance(account, location, false);

      if (entry.instance === null) {
        return { location, fetchedAt: entry.fetchedAt, source: "unavailable", instance: null };
      }

      return {
        location,
        fetchedAt: entry.fetchedAt,
        source: "instance",
        instance: toInstanceInfo(entry.instance, target.worldId, target.instanceId),
      };
    },

    async getWorld(worldId, accountId): Promise<WorldDetail> {
      // The cache is consulted **before** any account is resolved, because it is not per account:
      // a world is the same record whoever asks, so a warm cache answers with nobody signed in at
      // all. That is what lets a feed render world names on a laptop that just woke up.
      const hit = cachedWorld(worldId, Date.now());
      if (hit !== null) return toWorldDetail(hit.world, hit.fetchedAt, true);

      const account = availableAccount(accountId);
      if (account === null) {
        throw new ControlError(
          503,
          "no_account",
          "No account is signed in, so VRChat has nobody to ask about this world.",
        );
      }

      const fetched = await loadWorld(account, worldId);
      if (fetched === null) {
        throw new ControlError(404, "unknown_world", "VRChat has no such world.");
      }
      return toWorldDetail(fetched.world, fetched.fetchedAt, false);
    },

    async resolveAvatarByFile(fileId): Promise<AvatarFileResolution> {
      // No try/catch and no error branch on purpose: `resolve` is documented never to throw, and
      // every way it can fail to find an id — setting off, no contact yet, avtr.zip down, avtr.zip
      // simply does not know — is the same answer to the caller. See `net/avatar-ids.ts`.
      const avatarId = (await avatarIdResolver()?.resolve(fileId)) ?? null;
      return { fileId, avatarId };
    },

    /**
     * One avatar, asked of every signed-in account until one can see it.
     *
     * **A 404 is about the asker, not the avatar.** VRChat serves an avatar record only to accounts
     * allowed to see it, so an avatar private to its author is a 404 for everybody else. Asking
     * through one account and reporting "no such avatar" would therefore be wrong most of the time
     * on a multi-account setup: the account that *can* see it is very often the one that is wearing
     * it. The accounts are tried in turn rather than at once, because the first answer ends the
     * question and firing N requests to use one is waste the rate limiter would rather not carry.
     *
     * The answer names the account that produced it. That is the difference between "this avatar is
     * gone" and "your other account can see this one", which is a distinction the reader can act on.
     */
    async getAvatar(avatarId, accountId): Promise<AvatarDetail> {
      // Cache before account, exactly as `getWorld` does: the *record* is the same bytes for
      // everyone VRChat answers, so a warm row answers with nobody signed in.
      const hit = cachedAvatar(avatarId, Date.now());
      if (hit !== null) {
        return toAvatarDetail(hit.avatar, hit.fetchedAt, true, hit.seenByAccountId);
      }

      const named = accountId === null ? null : availableAccount(accountId);
      const candidates =
        named !== null
          ? [named]
          : accounts
              .list()
              .filter((snapshot) => snapshot.state === "online")
              .map((snapshot) => accounts.get(snapshot.id))
              .filter((account): account is Account => account !== undefined);

      if (candidates.length === 0) {
        throw new ControlError(
          503,
          "no_account",
          "No account is signed in, so VRChat has nobody to ask about this avatar.",
        );
      }

      for (const account of candidates) {
        const fetched = await loadAvatar(account, avatarId);
        if (fetched !== null) {
          return toAvatarDetail(fetched.avatar, fetched.fetchedAt, false, fetched.seenByAccountId);
        }
      }

      throw new ControlError(
        404,
        "unknown_avatar",
        candidates.length === 1
          ? "VRChat has no such avatar, or this account cannot see it."
          : `VRChat has no such avatar, or none of your ${String(candidates.length)} signed-in accounts can see it.`,
      );
    },

    async listWorlds(worldIds, accountId): Promise<WorldBatch> {
      const now = Date.now();
      const worlds: Record<string, WorldSummary> = {};
      const misses: string[] = [];

      for (const worldId of worldIds) {
        const hit = cachedWorld(worldId, now);
        const summary = hit === null ? null : toWorldSummary(hit.world);
        if (summary === null) misses.push(worldId);
        else worlds[worldId] = summary;
      }

      // Cache hits are already in hand, so a signed-out daemon still answers with them. Misses
      // simply stay absent — see `WorldBatch`.
      const account = misses.length === 0 ? null : availableAccount(accountId);

      if (account !== null) {
        const fetched = await Promise.all(
          // Each miss fails on its own: a 404 or a 502 on one world leaves the other forty-nine
          // alone, which is the entire reason this endpoint exists rather than the UI looping.
          misses.map(async (worldId) => {
            try {
              return await loadWorld(account, worldId);
            } catch {
              return null;
            }
          }),
        );

        for (const entry of fetched) {
          const summary = entry === null ? null : toWorldSummary(entry.world);
          if (summary !== null) worlds[summary.id] = summary;
        }
      }

      return { worlds };
    },

    async listSessions(): Promise<GameSession[]> {
      return store.listOpenSessions().map((row) => ({
        id: row.id,
        accountId: row.account_id,
        displayName: row.display_name,
        startedAt: row.started_at,
        vrMode: row.vr_mode,
        currentLocation: row.current_location,
        currentWorldId: row.current_world_id,
      }));
    },

    async listEvents(query: EventQuery): Promise<FeedEvent[]> {
      const before = query.before ?? Date.now() + 1;
      const limit = query.limit ?? 100;
      const kind = query.kind ?? null;

      /*
       * One SQL query per selector, chosen here. The route has already guaranteed at most one of
       * the three is set.
       *
       * The no-selector branch is `store.listAllEvents`, not a fan-out over `accounts.list()`.
       * The fan-out this replaces could not see rows with `account_id IS NULL` — a game client
       * signed into an account vrc.zip does not manage (PLAN.md §1.7) — so the unified feed
       * silently omitted exactly the rows the game log exists to show. It also merged N pages of
       * `limit` rows and sliced, which spends N× the work to return one page.
       */
      /*
       * Anything the fixed statements cannot express — several kinds, a family prefix, a text
       * search — goes through the assembled page instead. The narrowing still happens in SQL:
       * filtering a page after `LIMIT` returns short pages and then an empty one, which the
       * infinite scroll reads as the end of history.
       */
      const filtered =
        (query.kinds?.length ?? 0) > 0 ||
        (query.families?.length ?? 0) > 0 ||
        (query.search ?? "") !== "";

      const rows = filtered
        ? store.listEventsFiltered({
            ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
            ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
            ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
            // A single `kind` and a `kinds` list both narrow; folding them into one list is what
            // makes "both were given" mean the union rather than one silently winning.
            kinds: [...(kind === null ? [] : [kind]), ...(query.kinds ?? [])],
            ...(query.families === undefined ? {} : { families: query.families }),
            ...(query.search === undefined ? {} : { search: query.search }),
            before,
            limit,
          })
        : query.sessionId !== undefined
          ? store.listEventsBySession(query.sessionId, before, limit, kind)
          : query.subjectId !== undefined
            ? store.listEventsBySubject(query.subjectId, before, limit, kind)
            : query.accountId !== undefined
              ? store.listEvents(query.accountId, before, limit, kind)
              : store.listAllEvents(before, limit, kind);

      return rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        ts: row.ts,
        sessionId: row.session_id,
        kind: row.kind,
        subjectId: row.subject_id,
        location: row.location,
        payload: row.payload === null ? null : (JSON.parse(row.payload) as FeedEvent["payload"]),
      }));
    },

    async listEventKinds() {
      // Bookkeeping kinds are excluded, not because they are secret but because a filter chip for
      // a kind nothing renders is a chip that turns the list blank. The feed writer refuses to
      // store them today; older databases still hold rows for them.
      return store
        .countEventsByKind()
        .filter((row) => !EPHEMERAL.has(row.kind))
        .map((row) => ({ kind: row.kind, count: row.count }));
    },

    async listFriends(accountId): Promise<FriendPresence[]> {
      // Presence is live in-memory state, not a table — see PresenceService. Reading it from
      // `friend_log` would serve stale "online" rows after a restart until the first poll landed.
      const records = accountId === null ? presence.listAll() : presence.list(accountId);

      return records.map((record) => ({
        id: record.id,
        displayName: record.displayName,
        status: record.status,
        statusDescription: record.statusDescription,
        location: record.location,
        worldId: record.worldId,
        platform: record.platform,
        iconUrl: record.iconUrl,
        lastSeenAt: record.lastSeenAt,
      }));
    },

    /**
     * The instances of one world that vrc.zip can currently see.
     *
     * **Derived, not fetched.** VRChat has no "list the instances of this world" endpoint — only
     * `GET /instances/{worldId}:{instanceId}`, which needs an id you already hold. So the list is
     * assembled from three partial sources, and `sources` on each row says which ones vouched for
     * it. See {@link WorldInstanceList} for what each can and cannot see.
     *
     * **The world record is read once per signed-in account, not once.** `World.instances` is empty
     * for an unauthenticated caller and differs by *which* caller: a friends-only instance is listed
     * for an account that may enter it and withheld from one that may not. Reading it through a
     * single account would therefore silently present one account's view as the whole picture, which
     * is exactly the failure a multi-account app exists to avoid.
     *
     * One account failing never fails the list. A stale cookie or a rate-limited account is an
     * ordinary state, and the other accounts' answers are the entire point of asking several.
     */
    async listWorldInstances(worldId, accountId): Promise<WorldInstanceList> {
      interface Draft {
        readonly location: string;
        readonly instanceId: string | null;
        readonly friends: Map<string, WorldInstanceOccupant>;
        readonly clientSessionIds: number[];
        readonly seenBy: Set<string>;
        userCount: number | null;
      }

      const drafts = new Map<string, Draft>();

      /**
       * An instance is only real here if its location parses as one.
       *
       * `private`, `traveling`, `offline` and the empty string all mean "somewhere, but not
       * anywhere you can be told about", and a friend in one of those is not evidence that an
       * instance of *this* world exists. `parseLocation` returning null is that test.
       */
      const draftFor = (location: string | null): Draft | null => {
        if (location === null) return null;
        const parsed = parseLocation(location);
        if (parsed === null || parsed.worldId !== worldId) return null;
        const existing = drafts.get(location);
        if (existing !== undefined) return existing;
        const created: Draft = {
          location,
          instanceId: parsed.instanceId,
          friends: new Map(),
          clientSessionIds: [],
          seenBy: new Set(),
          userCount: null,
        };
        drafts.set(location, created);
        return created;
      };

      /*
       * The world record, through every signed-in account.
       *
       * `allSettled` rather than `all`: one rejection must not discard the accounts that answered,
       * and which ones failed is reported rather than swallowed. The rate limiter serialises these
       * per account, so N accounts is N requests spread across N buckets rather than a burst on one.
       */
      const asking =
        accountId === null
          ? accounts
              .list()
              .filter((snapshot) => snapshot.state === "online")
              .map((snapshot) => snapshot.id)
          : [accountId];

      const failedAccountIds: string[] = [];
      await Promise.all(
        asking.map(async (id) => {
          const account = accounts.get(id);
          if (account === undefined || account.snapshot().state !== "online") return;
          try {
            const response = await vrcFetch(account.context(), `/worlds/${worldId}`);
            // A 404 is a deleted world and a 403 is one this account may not see. Neither is a
            // fault worth reporting as a failed account: the account answered, with "nothing".
            if (response.status === 404 || response.status === 403) return;
            if (!response.ok) throw new Error(`VRChat returned ${String(response.status)}`);
            const world = JSON.parse(await response.text()) as { instances?: unknown };
            for (const entry of readWorldInstances(world)) {
              const draft = draftFor(`${worldId}:${entry.instanceId}`);
              if (draft === null) continue;
              draft.seenBy.add(id);
              // The largest count any account reported. They should agree; when they do not, the
              // bigger number is the one that saw more of the room.
              if (entry.userCount !== null) {
                draft.userCount = Math.max(draft.userCount ?? 0, entry.userCount);
              }
            }
          } catch {
            // Deliberately swallowed and named instead. See the method comment: a partial answer
            // is the normal outcome across several accounts and is worth more than a failure.
            failedAccountIds.push(id);
          }
        }),
      );

      const records = accountId === null ? presence.listAll() : presence.list(accountId);
      for (const record of records) {
        const draft = draftFor(record.location);
        // Keyed by user id, so the same friend seen through two accounts is one person in the
        // room rather than two. `listAll` genuinely returns them twice.
        draft?.friends.set(record.id, {
          id: record.id,
          displayName: record.displayName,
          iconUrl: record.iconUrl,
          status: record.status,
        });
      }

      // Your own clients, which is what lets the UI say "you are here" — and what makes an
      // instance you are standing in alone appear at all, since it has no friends to reveal it.
      for (const session of store.listOpenSessions()) {
        draftFor(session.current_location)?.clientSessionIds.push(session.id);
      }

      const instances: WorldInstanceSummary[] = [...drafts.values()].map((draft) => {
        const sources: WorldInstanceSource[] = [];
        if (draft.seenBy.size > 0) sources.push("vrchat");
        if (draft.friends.size > 0) sources.push("friend");
        if (draft.clientSessionIds.length > 0) sources.push("client");
        return {
          id: draft.location,
          location: draft.location,
          instanceId: draft.instanceId,
          worldId,
          sources,
          friends: [...draft.friends.values()].sort((left, right) =>
            left.displayName.localeCompare(right.displayName),
          ),
          clientSessionIds: draft.clientSessionIds,
          userCount: draft.userCount,
          seenByAccountIds: [...draft.seenBy],
        };
      });

      /*
       * The room you are already in, then the busiest, then the one with the most friends in it.
       *
       * `userCount` outranks `friends.length` because it is a count and the other is a floor: an
       * instance VRChat says holds thirty belongs above one where two friends are standing, even
       * though the second is the one this app knows more about.
       */
      instances.sort(
        (left, right) =>
          Number(right.clientSessionIds.length > 0) - Number(left.clientSessionIds.length > 0) ||
          (right.userCount ?? -1) - (left.userCount ?? -1) ||
          right.friends.length - left.friends.length ||
          left.location.localeCompare(right.location),
      );

      return { instances, accountsConsulted: asking.length, failedAccountIds };
    },

    async listNotificationTypes() {
      return store.countNotificationsByType();
    },

    async listNotifications(query): Promise<NotificationItem[]> {
      /*
       * One query, not a fan-out over the accounts.
       *
       * The fan-out this replaces took `limit` rows *per account* and sorted them here, which
       * cannot be paged: the merged result is a fixed newest-N window, and asking for the next
       * page would have meant a cursor per account. It also spent N queries to answer one, exactly
       * as `listAllEvents` used to.
       */
      return store
        .listNotificationsFiltered({
          ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
          ...(query.types === undefined ? {} : { types: query.types }),
          ...(query.seen === undefined ? {} : { seen: query.seen }),
          ...(query.search === undefined ? {} : { search: query.search }),
          before: query.before ?? Date.now() + 1,
          limit: query.limit ?? 100,
        })
        .map((row) => ({
          id: row.id,
          accountId: row.account_id,
          ts: row.ts,
          type: row.type,
          senderUserId: row.sender_user_id,
          senderDisplayName: row.sender_display_name,
          message: row.message,
          seen: row.seen === 1,
          data: row.data === null ? null : (JSON.parse(row.data) as NotificationItem["data"]),
        }));
    },

    async listPendingConsent(): Promise<PendingConsentRequest[]> {
      return (options.consent?.list() ?? []).map((pending) => toConsentRequest(pending, accounts));
    },

    async setConsentAccount(pairingId, accountId): Promise<PendingConsentRequest> {
      const registry = options.consent;
      if (registry === undefined) {
        throw new ControlError(404, "unknown_consent", "no consent request is pending");
      }
      // Checked before the attach rather than after: binding a grant to an account that is not
      // there is the one outcome this whole flow exists to prevent.
      if (accounts.get(accountId) === undefined) {
        throw new ControlError(404, "unknown_account", `no account ${accountId}`);
      }
      if (!registry.attachAccount(pairingId, accountId)) {
        throw new ControlError(404, "unknown_consent", "that consent request has expired");
      }

      const pending = registry.get(pairingId);
      if (pending === null) {
        throw new ControlError(404, "unknown_consent", "that consent request has expired");
      }
      return toConsentRequest(pending, accounts);
    },

    async listConnectedApps(): Promise<ConnectedApp[]> {
      // Newest first: the app someone just paired is the one they are most likely looking for, and
      // it is also the one they might want to undo.
      return (
        store
          .listGrants()
          // `listGrants` deliberately returns revoked rows — it is the audit view, and history is the
          // point of keeping them. This page is not that: a revoked app has no access to show and no
          // button to offer, and listing it greyed out would make "is this thing still connected?"
          // harder to answer rather than easier.
          .filter((grant) => grant.revoked_at === null)
          .map((grant) =>
            toConnectedApp(
              grant,
              accounts,
              store,
              options.pipelineMirror ?? null,
              options.meter ?? null,
            ),
          )
          .sort((a, b) => b.createdAt - a.createdAt)
      );
    },

    async setAppBudget(grantId, scope, limit): Promise<ConnectedApp> {
      const grant = store.getGrant(grantId);
      if (grant === null || grant.revoked_at !== null) {
        throw new ControlError(404, "unknown_app", `no app grant ${grantId}`);
      }
      // Only the scopes that *have* a budget can be given one. Accepting any scope string would let
      // this route invent an hourly cap on `worlds:read`, which the proxy would then ignore — a
      // control that visibly saves and silently does nothing is worse than no control.
      if (!isScope(scope) || DEFAULT_GRANT_BUDGETS[scope] === undefined) {
        throw new ControlError(
          400,
          "unbudgeted_scope",
          `"${scope}" does not carry an hourly allowance`,
        );
      }

      if (limit === null) store.deleteGrantBudget(grantId, scope);
      else store.setGrantBudget(grantId, scope, limit, Date.now());

      return toConnectedApp(
        grant,
        accounts,
        store,
        options.pipelineMirror ?? null,
        options.meter ?? null,
      );
    },

    async listWebhooks(): Promise<WebhookSummary[]> {
      const hooks = options.webhooks;
      if (hooks === undefined) return [];
      return hooks.list().map((row) => webhookSummary(row, store));
    },

    async deleteWebhook(webhookId): Promise<void> {
      // Idempotent, like `revokeConnectedApp`: deleting something already gone is the outcome the
      // user asked for, and a 404 would make a double-click look like a failure.
      options.webhooks?.remove(webhookId);
    },

    async revokeConnectedApp(grantId): Promise<void> {
      // Idempotent, like `denyConsent`: revoking something already gone is the outcome asked for.
      store.revokeGrant(grantId, Date.now());
      // The database half alone is not enough. A pipeline socket authenticated once at its
      // handshake and would otherwise keep streaming a revoked app events until it reconnected.
      options.pipelineMirror?.disconnectGrant(grantId);
    },

    async revokeAllConnectedApps(): Promise<number> {
      const now = Date.now();
      const live = store.listGrants();
      const revoked = store.revokeGrants(now);
      for (const grant of live) options.pipelineMirror?.disconnectGrant(grant.id);
      return revoked;
    },

    async listAppAudit(grantId, query: AuditQuery): Promise<AppAuditEntry[]> {
      // Checked against the grant table rather than against the audit rows: an app that has changed
      // nothing has no rows, and answering 404 for it would tell the user their app is gone when it
      // is merely quiet. Revoked grants resolve here too — the log outlives the access.
      if (store.getGrant(grantId) === null) {
        throw new ControlError(404, "unknown_app", `no app grant ${grantId}`);
      }

      // `before` is left off entirely rather than passed as undefined: `exactOptionalPropertyTypes`
      // makes the two different, and the store reads absence as "from now".
      const rows =
        query.before === undefined
          ? store.listAudit({ grantId, limit: query.limit })
          : store.listAudit({ grantId, limit: query.limit, before: query.before });

      return rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        grantId: row.grant_id,
        accountId: row.account_id,
        appName: row.app_name,
        method: row.method,
        path: row.path,
        operationId: row.operation_id,
        scope: row.scope,
        outcome: row.outcome,
        status: row.status,
      }));
    },

    async denyConsent(pairingId): Promise<void> {
      // Idempotent on purpose. A user who clicks Deny twice, or denies a request that has just
      // expired, has got the outcome they wanted either way.
      options.consent?.deny(pairingId);
    },

    async markNotificationSeen(id): Promise<void> {
      store.markNotificationSeen(id);
    },

    async getUser(userId, accountId): Promise<UserDetail> {
      const account = pickAccount(accountId);
      // The cache row has a foreign key to `accounts`; a cold start that reads a profile before
      // anything else has upserted the account would otherwise fail on the write, not the read.
      ensureAccountRow(account.snapshot());

      const now = Date.now();
      const cached = store.getUserCache(account.id, userId);
      const cachedEnvelope = cached === null ? null : readUserCache(cached.data);
      const fresh =
        cached !== null && cachedEnvelope !== null && now - cached.fetched_at < USER_CACHE_TTL_MS;

      let user: User;
      let representedGroup: GroupSummary | null;
      let profileCard: UserProfileCard | null;
      let fetchedAt: number;

      if (fresh && cached !== null && cachedEnvelope !== null) {
        user = cachedEnvelope.user;
        representedGroup = cachedEnvelope.representedGroup;
        profileCard = cachedEnvelope.profileCard;
        fetchedAt = cached.fetched_at;
      } else {
        // Only a live fetch needs a signed-in account; a fresh cache row can be served by an
        // account that has since gone offline, which is what makes the modal usable on a laptop
        // that just woke up.
        if (account.snapshot().state !== "online") {
          throw new ControlError(
            503,
            "no_account",
            "No account is signed in, so VRChat has nobody to ask about this user.",
          );
        }

        const response = await vrcFetch(account.context(), `/users/${userId}`);
        const body = await response.text();

        if (response.status === 404) {
          throw new ControlError(404, "unknown_user", "VRChat has no such user.");
        }
        if (!response.ok) {
          throw new ControlError(
            502,
            "user_fetch_failed",
            `VRChat returned ${String(response.status)}`,
          );
        }

        try {
          user = JSON.parse(body) as User;
        } catch {
          throw new ControlError(502, "user_fetch_failed", "VRChat returned a non-JSON body");
        }

        // Sequential, not concurrent: two calls to the same account in the same tick would each
        // take a token from a 16/s per-account bucket that presence polling also draws on, and the
        // modal is not so urgent that it should elbow ahead of the friends list.
        const profile = await fetchPublicProfile(account, userId);
        profileCard = profile?.card ?? null;

        // Two upstream calls on the common path, not three: the profile has already said whether
        // there is a group to fetch, and for most people there is not. When the profile itself did
        // not answer we ask anyway, so the badge behaves exactly as it did before this existed —
        // a missing supplement never costs a field the modal used to have.
        representedGroup =
          profile !== null && !profile.representsGroup
            ? null
            : await fetchRepresentedGroup(account, userId);

        fetchedAt = now;
        // Keyed by the account that fetched it. See migration 002: the body itself differs per
        // viewer, so the viewer belongs in the key. The envelope carries the group under the same
        // TTL rather than giving it a second cache that could disagree with this one.
        const envelope: UserCacheEnvelope = { v: 3, user, representedGroup, profileCard };
        store.putUserCache(account.id, userId, fetchedAt, JSON.stringify(envelope));

        /*
         * A live read is the freshest thing anyone has about this person, so presence takes it.
         *
         * Only on this branch: a cache hit is as old as the row it came from and would push stale
         * status back over a socket frame that had already corrected it. `observe` no-ops for
         * anybody who is not already a friend of this account, and reports whether it changed
         * anything — so the announcement below is real news, not one event per hover.
         */
        if (presence.observe(account.id, user)) {
          bus.emit({
            kind: "friend.presence",
            accountId: account.id,
            ts: fetchedAt,
            subjectId: userId,
            payload: { source: "profile" },
          });
        }
      }

      const friend = store.getFriend(account.id, userId);
      const note = store.getNote(account.id, userId);

      return {
        id: user.id ?? userId,
        displayName: user.displayName,
        accountId: account.id,
        fetchedAt,
        cached: fresh,

        bio: emptyToNull(user.bio),
        bioLinks: stringArray(user.bioLinks),
        pronouns: emptyToNull(user.pronouns),
        status: user.status,
        statusDescription: emptyToNull(user.statusDescription),
        state: emptyToNull(user.state),
        tags: stringArray(user.tags),
        // Reused, never re-derived: the trust ladder has one definition and it lives in
        // `presence.ts`, so the modal and the friends list can never disagree about a rank.
        trustLevel: trustLevelOf(stringArray(user.tags)),
        // Verbatim, never collapsed: `hidden` is *verified but not published*. See `UserDetail`.
        ageVerificationStatus: emptyToNull(user.ageVerificationStatus),
        ageVerified: user.ageVerified === true,
        platform: emptyToNull(user.platform),
        lastPlatform: emptyToNull(user.last_platform),
        location: emptyToNull(user.location),
        worldId: emptyToNull(user.worldId),
        isFriend: user.isFriend === true,
        dateJoined: unixMsFromDate(user.date_joined),
        lastLogin: unixMsFromDate(user.last_login),
        iconUrl: pickUserImageUrl(user),
        // The non-thumbnail original, for "open image in a new tab". Null rather than a crop.
        iconUrlFull: pickUserImageUrlFull(user),
        // Plain fields on VRChat's `User`, so they cost nothing — they were simply never passed
        // through. `""` is how VRChat spells "unset" here as everywhere else.
        // The worn avatar's picture. Its file id is the only handle on avatar identity VRChat
        // gives for somebody who is not you; see `net/avatar-ids.ts`.
        currentAvatarImageUrl: emptyToNull(user.currentAvatarImageUrl),
        currentAvatarThumbnailImageUrl: emptyToNull(user.currentAvatarThumbnailImageUrl),
        currentAvatarTags: stringArray(user.currentAvatarTags),
        bannerUrl: emptyToNull(user.bannerUrl),
        bannerType: emptyToNull(user.bannerType),
        representedGroup,
        profileCard,

        friendedAt: friend?.friended_at ?? null,
        note: note?.note ?? null,
        noteUpdatedAt: note?.updated_at ?? null,
      };
    },

    async listUsers(userIds, accountId): Promise<UserBatch> {
      const account = pickAccount(accountId);
      const online = account.snapshot().state === "online";
      ensureAccountRow(account.snapshot());

      const now = Date.now();
      // From the friend list this account already holds, so friendship costs nothing here either.
      const friends = new Set(presence.list(account.id).map((record) => record.id));
      const users: InstanceUser[] = [];

      for (const userId of userIds) {
        const cached = store.getUserCache(account.id, userId);
        const envelope = cached === null ? null : readUserCache(cached.data);
        if (cached !== null && envelope !== null && now - cached.fetched_at < USER_CACHE_TTL_MS) {
          const user = toInstanceUser(
            envelope.user as Partial<LimitedUserInstance>,
            friends.has(userId) || envelope.user.isFriend === true,
          );
          if (user !== null) users.push(user);
          continue;
        }

        // Cache-first, and this is where the line is drawn: with nobody signed in, an id we have
        // never read is simply left out. Failing the batch would take a whole room's chips down
        // over one stranger nobody has looked at.
        if (!online) continue;

        /*
         * Sequential, deliberately. Eighty concurrent `GET /users/{id}` would empty a 16/s
         * per-account bucket that presence polling and the modal also draw on, and this is the
         * least urgent thing on the screen — the names and join times are already correct without
         * it. The limiter would queue them anyway; issuing them in order keeps the queue legible
         * and lets a slow room degrade into "some chips now, more in a moment" rather than a
         * stall.
         */
        let user: User;
        try {
          // `"low"` on purpose. Sequential ordering keeps the queue legible, but ordering alone
          // does not stop eighty of these draining the account bucket; the priority leaves a
          // reserve so presence polling, a re-auth, or something the user just clicked always
          // finds a token waiting. See PROGRESS.md decision 102.
          const response = await vrcFetch(account.context(), `/users/${userId}`, {
            priority: "low",
          });
          const body = await response.text();
          // Left out rather than thrown, per the contract on `ControlDeps.listUsers`.
          if (!response.ok) continue;
          user = JSON.parse(body) as User;
        } catch {
          continue;
        }

        /*
         * Written to `user_cache` under the same key the modal reads, with no group and no profile
         * card — which is honest rather than lossy, because both halves are only ever *added* by
         * the modal's own fetch. What it must not do is fetch them per head: that would triple an
         * already-expensive path for decoration no roster row shows.
         */
        store.putUserCache(
          account.id,
          userId,
          now,
          JSON.stringify({
            v: 3,
            user,
            representedGroup: null,
            profileCard: null,
          } satisfies UserCacheEnvelope),
        );

        /*
         * The id comes from the request, not from the body, and that is deliberate on both counts.
         * Every field of `User` is optional upstream, so a body with no `id` would be dropped by
         * `toInstanceUser` as unidentifiable — when we know exactly who we asked about. And a body
         * whose id disagreed with the path would be a row filed under the wrong person, which is
         * worse than no row at all.
         */
        const mapped = toInstanceUser(
          { ...(user as Partial<LimitedUserInstance>), id: userId },
          friends.has(userId) || user.isFriend === true,
        );
        if (mapped !== null) users.push(mapped);
      }

      return { users };
    },

    async listUserGroups(userId, accountId): Promise<UserGroups> {
      const account = onlineAccount(accountId);
      const raw = await vrcJson(account, `/users/${userId}/groups`, "groups_fetch_failed");

      // Not an error, and not cached as one: VRChat filters this list by what the asking account
      // is permitted to see, so `[]` is a correct answer about a user in a dozen groups. Anything
      // that is not an array at all is treated the same way rather than thrown — a modal section
      // that renders empty beats a modal that will not open.
      if (!Array.isArray(raw)) return { groups: [] };

      const groups = raw
        .map((entry: LimitedUserGroups) => toGroupSummary(entry))
        .filter((group): group is GroupSummary => group !== null);

      return { groups };
    },

    async getGroup(groupId, accountId): Promise<GroupDetail> {
      const account = onlineAccount(accountId);
      // Two causes behind a 404, and the daemon cannot tell them apart: VRChat answers it both for
      // a group that no longer exists and for a private one this account may not see. The sentence
      // says both rather than picking the more likely.
      const raw = (await vrcJson(account, `/groups/${groupId}`, "group_fetch_failed", {
        code: "unknown_group",
        message: "VRChat has no such group, or this account cannot see it.",
      })) as Partial<Group>;

      // The summary half is shared with the represented badge and the Groups tab, so a group that
      // cannot even be identified is dropped there and refused here — a card with no id has no
      // link, no copy button, and nothing to key on.
      const summary = toGroupSummary({
        ...raw,
        // `Group` names the group's own id `id`; `LimitedUserGroups` names it `groupId` and uses
        // `id` for the *membership row*. `toGroupSummary` speaks the latter, so the translation
        // happens here, once, rather than in a second near-identical mapper.
        groupId: raw.id,
      });
      if (summary === null) {
        throw new ControlError(502, "group_fetch_failed", "VRChat sent a group with no id");
      }

      return {
        ...summary,
        // A group is not represented by virtue of being fetched. Only the endpoints that carry the
        // flag may set it, and this one does not.
        isRepresenting: false,
        createdAt: unixMsFromDate(raw.createdAt),
        onlineMemberCount: typeof raw.onlineMemberCount === "number" ? raw.onlineMemberCount : null,
        memberCountSyncedAt: unixMsFromDate(raw.memberCountSyncedAt),
        rules: emptyToNull(raw.rules),
        links: stringArray(raw.links),
        languages: stringArray(raw.languages),
        tags: stringArray(raw.tags),
        isVerified: raw.isVerified === true,
        joinState: emptyToNull(raw.joinState),
        membershipStatus: emptyToNull(raw.membershipStatus),
        // Free: the galleries are part of the group body, so the tab strip costs no request and
        // only opening a gallery does.
        galleries: (Array.isArray(raw.galleries) ? raw.galleries : [])
          .map((entry: GroupGallery) => toGroupGallery(entry))
          .filter((gallery): gallery is GroupGallerySummary => gallery !== null),
      };
    },

    async listGroupMembers(groupId, accountId, page): Promise<GroupMemberPage> {
      const account = onlineAccount(accountId);
      const raw = await groupSubresource(
        account,
        `/groups/${groupId}/members?n=${String(page.n)}&offset=${String(page.offset)}`,
        "group_members_fetch_failed",
      );

      if (!Array.isArray(raw)) return { members: [], hasMore: false };

      const members = raw
        .map((entry: GroupMember) => toGroupMember(entry))
        .filter((member): member is GroupMemberSummary => member !== null);

      // `hasMore` is derived from `returned === n`, because VRChat sends no total on this endpoint
      // — a full page is the only evidence another exists. Measured on the **raw** array rather
      // than on `members`: a dropped `null` entry shortens the mapped list without meaning the page
      // was short, and reading it off the mapped one would end the scroll early.
      return { members, hasMore: raw.length >= page.n };
    },

    async listGroupPosts(groupId, accountId, page): Promise<GroupPostPage> {
      const account = onlineAccount(accountId);
      // The one sub-resource that answers with an **object**, not an array: `{ posts: [...] }`.
      // The other three return a bare array, which is exactly why this is worth a line of its own.
      const raw = (await groupSubresource(
        account,
        `/groups/${groupId}/posts?n=${String(page.n)}&offset=${String(page.offset)}`,
        "group_posts_fetch_failed",
      )) as { posts?: GroupPost[] } | null;

      const entries = Array.isArray(raw?.posts) ? raw.posts : [];

      /*
       * `GroupPost` has an `authorId` and no display name, so the name comes from what this account
       * already holds — presence first, since the socket keeps it current, then `friend_log`, which
       * covers the window before the first friends poll of a cold start lands. Same trick as
       * `trustLevel` on a mutual friend, and it costs no request.
       *
       * Unlike a mutual friend, though, a post author is usually *not* one of the reader's friends,
       * so null is the ordinary answer here rather than the edge case. Resolving it properly would
       * be one `GET /users/{id}` per distinct author on every page of the board — real spend, for
       * decoration the UI can render an id fallback for.
       */
      const known = new Map(presence.list(account.id).map((record) => [record.id, record]));
      const posts = entries
        .map((post: GroupPost) => {
          const authorId = emptyToNull(post.authorId);
          const name =
            authorId === null
              ? null
              : (known.get(authorId)?.displayName ??
                store.getFriend(account.id, authorId)?.display_name ??
                null);
          return toGroupPost(post, emptyToNull(name));
        })
        .filter((post): post is GroupPostSummary => post !== null);

      return { posts, hasMore: entries.length >= page.n };
    },

    async listGroupInstances(groupId, accountId): Promise<GroupInstanceList> {
      const account = onlineAccount(accountId);
      const raw = await groupSubresource(
        account,
        `/groups/${groupId}/instances`,
        "group_instances_fetch_failed",
      );

      // No paging: upstream takes no `n` and no `offset`, so there is no `hasMore` that could mean
      // anything. See `GroupInstanceList`.
      if (!Array.isArray(raw)) return { instances: [] };

      const instances = raw
        .map((entry: Partial<GroupInstance>) => toGroupInstance(entry))
        .filter((instance): instance is GroupInstanceSummary => instance !== null);

      return { instances };
    },

    async listGroupGalleryImages(
      groupId,
      galleryId,
      accountId,
      page,
    ): Promise<GroupGalleryImagePage> {
      const account = onlineAccount(accountId);
      // Upstream the images *are* the gallery — there is no `/images` segment on VRChat's path.
      const raw = await groupSubresource(
        account,
        `/groups/${groupId}/galleries/${galleryId}?n=${String(page.n)}&offset=${String(page.offset)}`,
        "group_gallery_fetch_failed",
      );

      if (!Array.isArray(raw)) return { images: [], hasMore: false };

      const images = raw
        .map((entry: GroupGalleryImage) => toGroupGalleryImage(entry))
        .filter((image): image is GroupGalleryImageSummary => image !== null);

      return { images, hasMore: raw.length >= page.n };
    },

    async listMutualFriends(userId, accountId, page): Promise<MutualFriendPage> {
      const account = onlineAccount(accountId);
      const query = `?n=${String(page.n)}&offset=${String(page.offset)}`;
      const raw = await vrcJson(
        account,
        `/users/${userId}/mutuals/friends${query}`,
        "mutuals_fetch_failed",
      );

      if (!Array.isArray(raw)) return { users: [], hasMore: false };

      /*
       * Trust ranks come from local state, and they have to: **`MutualFriend` carries no `tags`**,
       * so `trustLevelOf` on the response would rank every single row "visitor" — a wrong answer
       * printed confidently, which is the failure mode this codebase keeps finding.
       *
       * A mutual friend is by definition one of this account's own friends, so presence already
       * holds their rank. `friend_log` is the fallback for the window before the first friends poll
       * lands, since it persists the rank from the last time it did. Neither costs a request.
       *
       * The same record supplies the presence status, for the same reason and with the same
       * evidence behind it — see `toMutualFriend`.
       */
      const known = new Map(presence.list(account.id).map((r) => [r.id, r]));

      const users = raw
        .map((entry: Partial<MutualFriend>) => {
          const id = typeof entry.id === "string" ? entry.id : "";
          const record = known.get(id);
          const rank =
            record?.trustLevel ?? store.getFriend(account.id, id)?.trust_level ?? "visitor";
          return toMutualFriend(entry, rank, record?.status ?? null);
        })
        .filter((user): user is MutualFriendSummary => user !== null);

      // VRChat sends no total, so a full page is the only evidence another may exist. Measured on
      // the raw array, not on `users`: a dropped malformed entry shortens the mapped list without
      // meaning the page was short, and reading `hasMore` off it would end the scroll early.
      return { users, hasMore: raw.length >= page.n };
    },

    async setUserNote(userId, accountId, note): Promise<UserNote> {
      // No online check: the note is vrc.zip's own row, and refusing to let someone annotate a
      // profile because VRChat is unreachable would be a rule with no reason behind it.
      const account = pickAccount(accountId);
      ensureAccountRow(account.snapshot());

      if (note === "") {
        store.deleteNote(account.id, userId);
        return { accountId: account.id, userId, note: null, updatedAt: null };
      }

      const updatedAt = Date.now();
      store.putNote(account.id, userId, note, updatedAt);
      return { accountId: account.id, userId, note, updatedAt };
    },

    async fetchImage(url) {
      // The URL has already cleared the host allowlist in `control.ts`. Everything below still goes
      // through an `Account` and therefore through `vrcFetch` — the rate limiter, the mandatory
      // User-Agent, and one account's cookies are all structural here, not optional. `vrcFetch`
      // passes an absolute URL through untouched, which is what makes an image URL usable at all.
      return await images.load(url, async (absolute) => {
        const online = accounts.list().find((snapshot) => snapshot.state === "online");
        const account = online ? accounts.get(online.id) : undefined;
        if (!account) {
          throw new ControlError(
            503,
            "no_account",
            "No account is online, and VRChat images cannot be fetched without one.",
          );
        }

        // Charged to the file tier, not the API tier: VRChat meters files separately at 300/s
        // per IP, and a friends screen is a few hundred icons. Billing those to the 100/s API
        // budget would queue presence polling behind pictures on every cold start.
        const response = await vrcFetch(account.context(), absolute, {
          headers: { Accept: "image/*" },
          rateClass: "file",
        });

        if (response.status === 404) {
          await response.arrayBuffer().catch(() => undefined);
          return null;
        }
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          throw new ControlError(502, "image_fetch_failed", `VRChat returned ${response.status}`);
        }

        // Refuse an oversized body before buffering it. A wrong or hostile URL that still cleared
        // the allowlist should not be able to pull hundreds of megabytes into memory on its way to
        // being rejected by the cache's own cap.
        const declared = Number(response.headers.get("Content-Length") ?? "");
        if (Number.isFinite(declared) && declared > images.maxImageBytes) {
          await response.arrayBuffer().catch(() => undefined);
          throw new ControlError(502, "image_too_large", "VRChat image exceeds the size cap");
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, contentType: response.headers.get("Content-Type") };
      });
    },

    async getRetention(): Promise<RetentionSettings> {
      return describeRetention(store, { nextRunAt: options.nextRetentionRunAt?.() ?? null });
    },

    async updateRetention(update: RetentionUpdate): Promise<RetentionSettings> {
      const nextRunAt = options.nextRetentionRunAt?.() ?? null;

      // A dry run resolves the patch into `overrides` and never touches the table. Note that the
      // patch's deletions cannot be previewed this way — `overrides` can only add or replace a
      // rule, not remove one — so a delete is reported against the rule it is replacing rather
      // than against the inherited window it will fall back to. Deleting a rule can only ever
      // *lengthen* what is kept (the default is the longest thing it can fall back to in practice),
      // so the preview under-promises rather than over-deletes, which is the safe direction.
      if (update.dryRun === true) {
        const overrides: Record<string, number> = {};
        if (update.defaultRetainDays !== undefined) {
          overrides[RETENTION_DEFAULT_KEY] = update.defaultRetainDays;
        }
        for (const [kind, days] of Object.entries(update.rules ?? {})) {
          if (days !== null) overrides[kind] = days;
        }
        return describeRetention(store, { overrides, nextRunAt, preview: true });
      }

      applyRetentionUpdate(store, update);
      return describeRetention(store, { nextRunAt });
    },

    async runRetention(): Promise<RetentionRunResult> {
      const result = runRetentionPass(store);
      return {
        deletedByKind: result.deletedByKind,
        totalDeleted: result.totalDeleted,
        durationMs: result.durationMs,
        settings: describeRetention(store, { nextRunAt: options.nextRetentionRunAt?.() ?? null }),
      };
    },

    async getSettings(): Promise<WireSettings> {
      return settings as unknown as WireSettings;
    },

    async updateSettings(patch: SettingsPatch): Promise<WireSettings> {
      const next: Settings = {
        ...settings,
        ...(typeof patch.contact === "string" ? { contact: patch.contact } : {}),
        ...(typeof patch.openBrowserOnStart === "boolean"
          ? { openBrowserOnStart: patch.openBrowserOnStart }
          : {}),
        // The third-party avatar lookup. See `Settings.resolveAvatarIds` and `net/avatar-ids.ts`.
        ...(typeof patch.resolveAvatarIds === "boolean"
          ? { resolveAvatarIds: patch.resolveAvatarIds }
          : {}),
        ...(Array.isArray(patch.logDirectories)
          ? { logDirectories: patch.logDirectories.filter((d) => typeof d === "string") }
          : {}),
      };

      settings = next;
      await options.onSettingsSaved(next);
      return next as unknown as WireSettings;
    },

    streamClientCount(): number {
      return streamClients;
    },

    subscribeEvents(listener: (event: StreamEvent) => void): () => void {
      streamClients += 1;

      /*
       * A `rate` frame every second, for as long as this client is attached.
       *
       * Per client rather than one shared ticker fanned out, because the interval is the thing that
       * has to stop: a daemon nobody is watching should not be sampling a meter once a second
       * forever, and tying the timer's life to the socket's makes that automatic rather than
       * another counter to keep in step with `streamClients`.
       *
       * `unref` so it cannot hold the process open on the way out.
       */
      const ticker = setInterval(() => {
        listener({ type: STREAM_RATE, ts: Date.now(), payload: rateFrame() });
      }, 1000);
      ticker.unref?.();
      const subscription = bus.subscribe((event) => {
        // No casts: the envelope is `StreamEnvelope` from `@vrcz/shared` and the UI reads the same
        // interface, so a field added on one side without the other now fails to compile. `data` is
        // the one place a cast survives, because the bus deliberately types `payload` as `unknown`
        // - a producer may put anything there - while the wire can only carry JSON.
        listener({
          type: event.kind,
          ts: event.ts,
          payload: {
            accountId: event.accountId,
            sessionId: event.sessionId ?? null,
            displayName: sessionDisplayName(event.sessionId ?? null),
            subjectId: event.subjectId ?? null,
            location: event.location ?? null,
            data: (event.payload ?? null) as JsonValue,
          },
        });
      });

      let released = false;
      return () => {
        clearInterval(ticker);
        // Guarded because `onClose` and an explicit teardown can both fire for one socket, and a
        // count that drifts below zero would make `streamClientCount() > 0` permanently false —
        // silently disabling every OS notification for the rest of the run.
        if (released) return;
        released = true;
        streamClients -= 1;
        subscription.unsubscribe();
      };
    },
  };
}

/**
 * A pending consent request, as the sheet renders it.
 *
 * The plain-English scope descriptions come from the shared registry rather than being written
 * here, because that registry is also what the plugin consent screen and the generated docs read.
 * A scope described one way in the docs and another on the screen that actually grants it is a
 * documentation bug with security consequences.
 */
/**
 * A grant as the Connected apps page reads it.
 *
 * Every field of `GrantRow` that is a credential — `token_hash`, `two_factor_hash` — is absent by
 * construction rather than by omission: this builds a new object out of the four things the page
 * needs, so a field added to the row later cannot arrive here by accident.
 */
function toConnectedApp(
  grant: GrantRow,
  accounts: AccountManager,
  store: Store,
  mirror: PipelineMirror | null,
  meter: RequestMeter | null,
): ConnectedApp {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(grant.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((scope) => typeof scope === "string");
  } catch {
    // A row we cannot read still describes an app the user may want to revoke, so it is listed
    // with no scopes rather than hidden. Hiding it would make the one grant nobody can explain
    // also the one grant nobody can remove.
  }

  // The manager only knows accounts that are *loaded*, and a grant outlives a session — a user who
  // signed an account out still needs to see what it granted, and under a name they recognise. The
  // `accounts` table is the durable record of that name, so it is the fallback before the raw id.
  const account = accounts.get(grant.account_id);
  const stored = store.getAccount(grant.account_id);
  return {
    id: grant.id,
    accountId: grant.account_id,
    accountName:
      account?.user?.displayName ?? account?.username ?? stored?.display_name ?? grant.account_id,
    app: { name: grant.app_name, version: grant.app_version, contact: grant.app_contact },
    scopes: scopes.map((scope) => ({
      scope,
      description: isScope(scope) ? SCOPES[scope].description : scope,
      // An unrecognised scope is shown as dangerous. It is the safe direction to be wrong in, and
      // it is visible rather than silent.
      dangerous: isScope(scope) ? SCOPES[scope].dangerous : true,
      // Nothing here is "new" — the sheet's escalation highlight has no meaning on a standing grant.
      isNew: false,
    })),
    createdAt: grant.created_at,
    lastUsedAt: grant.last_used_at,
    liveSockets: mirror?.socketsForGrant(grant.id) ?? 0,
    rate: meter?.grant(grant.id) ?? emptySeries(),
    budgets: appBudgets(grant, new Set(scopes), store),
  };
}

/**
 * The three risky scopes' allowances for one app, with what it has spent against each.
 *
 * All three are always reported, including the ones the app does not hold. A card that hid
 * `invite:send` because the app cannot send invites would hide the control exactly when someone
 * wants to check that it is closed — `granted: false` says the same thing without the disappearing
 * act, and it also means the row does not appear out of nowhere if the app later escalates.
 */
function appBudgets(grant: GrantRow, held: ReadonlySet<string>, store: Store): AppBudget[] {
  const since = Date.now() - BUDGET_WINDOW_MS;
  const entries = Object.entries(DEFAULT_GRANT_BUDGETS) as [string, number][];
  return entries.map(([scope, defaultLimit]) => {
    const override = store.grantBudget(grant.id, scope);
    return {
      scope,
      description: isScope(scope) ? SCOPES[scope].description : scope,
      limit: override ?? defaultLimit,
      defaultLimit,
      overridden: override !== null,
      used: store.countGrantScopeUsage(grant.id, scope, since),
      granted: held.has(scope),
    };
  });
}

function toConsentRequest(
  pending: PendingConsent,
  accounts: AccountManager,
): PendingConsentRequest {
  const isNew = new Set<string>(pending.newScopes);
  return {
    id: pending.id,
    accountId: pending.accountId,
    accountName:
      pending.accountId === null
        ? null
        : (accounts.get(pending.accountId)?.user?.displayName ??
          accounts.get(pending.accountId)?.username ??
          null),
    requestedUsername: pending.requestedUsername,
    app: { ...pending.app },
    scopes: pending.scopes.map((scope) => ({
      scope,
      description: isScope(scope) ? SCOPES[scope].description : scope,
      dangerous: isScope(scope) ? SCOPES[scope].dangerous : true,
      isNew: isNew.has(scope),
    })),
    // An app asking for exactly what it already holds is not an escalation, and the sheet should
    // not imply the user is being asked for something new when they are not.
    escalation: pending.newScopes.length < pending.scopes.length,
    code: pending.code,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

/**
 * One limiter bucket, in wire shape.
 *
 * `available` is floored rather than rounded: a bucket holding 19.6 tokens can pay for nineteen
 * requests, and rounding it to twenty would show headroom that the next call is about to wait for.
 */
function ceiling(bucket: RateBucketSnapshot): RateCeilingSnapshot {
  return {
    rate: bucket.rate,
    burst: bucket.burst,
    available: Math.floor(bucket.available),
    queued: bucket.queued,
  };
}
