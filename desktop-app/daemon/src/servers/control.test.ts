import { describe, expect, test } from "bun:test";
import type { DaemonStatus } from "@vrcz/shared";
import { APP_VERSION } from "@vrcz/shared";
import { emptySeries, WINDOW_SECONDS } from "../net/request-meter.ts";
import { TOKEN_HEADER } from "../security/guards.ts";
import { generateSessionToken } from "../security/session-token.ts";
import type { ControlDeps } from "./control.ts";
import {
  type ControlAccount,
  ControlError,
  createControlApp,
  type EventQuery,
  type GroupDetail,
  type GroupGalleryImageSummary,
  type GroupGallerySummary,
  type GroupInstanceSummary,
  type GroupMemberSummary,
  type GroupPostSummary,
  type InstanceInfo,
  type InviteTarget,
  MAX_USER_IDS,
  MAX_WORLD_IDS,
  type PageQuery,
  parseInviteLocation,
  parseUserId,
  parseWorldId,
  parseWorldIds,
  type Settings,
  type StreamEvent,
  type UserBatch,
  type UserDetail,
  type WorldDetail,
  type WorldSummary,
} from "./control.ts";

const PORT = 7775;
const TOKEN = generateSessionToken();

/** A one-pixel PNG's worth of leading bytes — enough for anything that sniffs magic numbers. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const ICON_URL = "https://api.vrchat.cloud/api/1/file/file_icon/1/256";
/** The non-thumbnail original behind ICON_URL — what "open image in a new tab" opens. */
const ICON_URL_FULL = "https://api.vrchat.cloud/api/1/file/file_icon/1/1024";

const ACCOUNT: ControlAccount = {
  id: "usr_00000000-0000-0000-0000-000000000000",
  displayName: "Tester",
  addedAt: 1_700_000_000_000,
  enabled: true,
  lastSeenAt: null,
  connection: "connected",
  rate: emptySeries(),
  iconUrl: ICON_URL,
};

/** What `GET /api/users/:id` answers with in these tests. Only the merge fields matter here. */
const USER_DETAIL: UserDetail = {
  id: "usr_subject",
  displayName: "Subject",
  accountId: "usr_00000000-0000-0000-0000-000000000000",
  fetchedAt: 1_700_000_000_000,
  cached: false,
  bio: "hello",
  bioLinks: ["https://example.invalid"],
  pronouns: null,
  status: "active",
  statusDescription: null,
  state: "online",
  tags: ["system_trust_known"],
  trustLevel: "known",
  ageVerificationStatus: "18+",
  ageVerified: true,
  platform: "standalonewindows",
  lastPlatform: "standalonewindows",
  location: "wrld_x:1",
  worldId: "wrld_x",
  isFriend: true,
  dateJoined: 1_600_000_000_000,
  lastLogin: 1_700_000_000_000,
  iconUrl: ICON_URL,
  iconUrlFull: ICON_URL_FULL,
  bannerUrl: "https://api.vrchat.cloud/api/1/file/file_banner/1/1024",
  bannerType: "gallery",
  representedGroup: {
    id: "grp_ba913a96-fac4-4048-a062-9aa5db092812",
    name: "A Group",
    shortCode: "ABCD",
    discriminator: "1234",
    iconUrl: ICON_URL,
    bannerUrl: null,
    memberCount: 42,
    privacy: "default",
    ownerId: "usr_owner",
    description: null,
    mutualGroup: false,
    isRepresenting: true,
  },
  profileCard: {
    languages: ["eng", "jpn"],
    badges: [
      {
        id: "bdg_supporter",
        name: "Supporter",
        description: "Supported VRChat",
        imageUrl: "https://assets.vrchat.com/badges/bdg_supporter.png",
        showcased: true,
      },
    ],
    hasVrcPlus: true,
    bannerColor: "#112233",
  },
  friendedAt: 1_650_000_000_000,
  note: null,
  noteUpdatedAt: null,
};

/** One roster head, with every badge field the Live Sessions screen draws. */
const INSTANCE_USER = {
  id: "usr_roster",
  displayName: "In The Room",
  iconUrl: ICON_URL,
  iconUrlFull: ICON_URL_FULL,
  trustLevel: "trusted",
  ageVerificationStatus: "18+",
  ageVerified: true,
  isFriend: true,
  status: "join me",
  platform: "standalonewindows",
  developerType: "none",
};

/** One roster-shaped record per id, so a batch answer is checkable without a fixture per user. */
function instanceUserFor(id: string) {
  return { ...INSTANCE_USER, id, displayName: id.toUpperCase() };
}

/** The same normalised group shape the represented group uses — one type, one renderer. */
const GROUP = USER_DETAIL.representedGroup as NonNullable<UserDetail["representedGroup"]>;

const GROUP_ID = "grp_2c8e5f1a-4a3d-4b6e-8f0c-1d2e3f4a5b6c";
/** A group VRChat will not hand over — deleted, or private to this account. */
const MISSING_GROUP_ID = "grp_00000000-0000-0000-0000-000000000000";
/** A group this account can see but is not in: it 403s every sub-resource. */
const CLOSED_GROUP_ID = "grp_11111111-1111-1111-1111-111111111111";

const GALLERY_ID = "ggal_3f0d1c2b-5a6e-4d7c-8b9a-0e1f2a3b4c5d";

const GROUP_GALLERY: GroupGallerySummary = {
  id: GALLERY_ID,
  name: "Events",
  description: "Photos from our meetups.",
  membersOnly: false,
};

const GROUP_MEMBER: GroupMemberSummary = {
  // The membership row and the person are different identifiers, and both are on the wire.
  id: "gmem_9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
  userId: "usr_member",
  displayName: "A Member",
  iconUrl: ICON_URL,
  joinedAt: 1_650_000_000_000,
  roleIds: ["grol_moderator"],
  isRepresenting: true,
};

const GROUP_POST: GroupPostSummary = {
  id: "not_7f6e5d4c-3b2a-4190-8877-665544332211",
  title: "Meetup on Friday",
  text: "Doors at eight.",
  authorId: "usr_staff",
  // Null is the ordinary answer: `GroupPost` carries no name, and staff are usually strangers.
  authorDisplayName: null,
  createdAt: 1_690_000_000_000,
  imageUrl: ICON_URL,
};

/** Spelled out rather than reusing `WORLD_ID` below: this block is evaluated before that one. */
const GROUP_INSTANCE_WORLD_ID = "wrld_ba913a96-fac4-4048-a062-9aa5db092812";

const GROUP_INSTANCE: GroupInstanceSummary = {
  instanceId: `12345~group(${GROUP_ID})`,
  location: `${GROUP_INSTANCE_WORLD_ID}:12345~group(${GROUP_ID})`,
  memberCount: 9,
  worldId: GROUP_INSTANCE_WORLD_ID,
  worldName: "The Great Pug",
  worldThumbnailImageUrl: ICON_URL,
  worldCapacity: 40,
};

/**
 * The two refusals every group sub-resource shares, in the deps layer where they belong.
 *
 * 403 is not a variant of 404 here: "this group is gone or invisible" and "you are not in it" send
 * the UI down different branches, and the whole reason `group_forbidden` exists is that a non-member
 * must not be shown an empty list as though the group had nobody in it.
 */
function groupGate(groupId: string): void {
  if (groupId === MISSING_GROUP_ID) throw new ControlError(404, "unknown_group");
  if (groupId === CLOSED_GROUP_ID) throw new ControlError(403, "group_forbidden");
}

/** `n` rows with distinct ids, so a full page is checkable without a fixture per row. */
function rows<T extends { id: string }>(row: T, n: number): T[] {
  return Array.from({ length: n }, (_, i) => ({ ...row, id: `${row.id}-${String(i)}` }));
}

const GALLERY_IMAGE: GroupGalleryImageSummary = {
  id: "ggim_1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9",
  imageUrl: ICON_URL,
  submittedByUserId: "usr_member",
  createdAt: 1_680_000_000_000,
};

const GROUP_DETAIL: GroupDetail = {
  ...GROUP,
  // Fetching a group is not evidence that anybody represents it; only the endpoints carrying the
  // flag may set it. See `ControlDeps.getGroup`.
  isRepresenting: false,
  createdAt: 1_600_000_000_000,
  onlineMemberCount: 12,
  memberCountSyncedAt: 1_700_000_000_000,
  rules: "Be kind.",
  links: ["https://example.invalid/pug"],
  languages: ["eng"],
  tags: ["system_verified"],
  isVerified: true,
  joinState: "open",
  membershipStatus: "member",
  // Rides in on the group body, which is why the gallery tabs cost no request of their own.
  galleries: [GROUP_GALLERY],
};

const MUTUAL = {
  id: "usr_mutual",
  displayName: "Mutual",
  iconUrl: ICON_URL,
  trustLevel: "trusted",
  status: "active",
};

const WORLD_ID = "wrld_ba913a96-fac4-4048-a062-9aa5db092812";
/** A world the daemon cannot resolve — absent from a batch, a 404 on its own route. */
const WORLD_MISSING = "wrld_00000000-0000-0000-0000-000000000000";

const WORLD_SUMMARY: WorldSummary = {
  id: WORLD_ID,
  name: "The Great Pug",
  thumbnailImageUrl: ICON_URL,
  authorName: "Author",
  capacity: 40,
};

const WORLD_DETAIL: WorldDetail = {
  ...WORLD_SUMMARY,
  description: "a pub",
  authorId: "usr_author",
  imageUrl: ICON_URL,
  recommendedCapacity: 20,
  tags: ["author_tag_pub"],
  releaseStatus: "public",
  visits: 1000,
  favorites: 10,
  heat: 5,
  popularity: 6,
  occupants: 12,
  publicationDate: 1_600_000_000_000,
  labsPublicationDate: null,
  createdAt: 1_500_000_000_000,
  updatedAt: 1_600_000_000_000,
  version: 3,
  fetchedAt: 1_700_000_000_000,
  cached: false,
};

const INSTANCE_INFO: InstanceInfo = {
  worldId: WORLD_ID,
  instanceId: "12345",
  type: "hidden",
  ownerId: "usr_1",
  region: "eu",
  capacity: 40,
  userCount: 12,
  nUsers: 12,
  full: false,
  canRequestInvite: true,
  closedAt: null,
  hardClose: null,
  queueEnabled: false,
  queueSize: 0,
  tags: [],
  active: true,
  world: WORLD_SUMMARY,
};

interface Recorder {
  eventQueries: EventQuery[];
  worldLookups: string[];
  worldBatches: string[][];
  instanceLookups: { target: InviteTarget; accountId: string | null }[];
  friendQueries: (string | null)[];
  notificationQueries: (string | null)[];
  notificationsSeen: string[];
  imageUrls: string[];
  userLookups: { userId: string; accountId: string | null }[];
  groupLookups: { userId: string; accountId: string | null }[];
  groupFetches: { groupId: string; accountId: string | null }[];
  groupMemberPages: { groupId: string; accountId: string | null; page: PageQuery }[];
  groupPostPages: { groupId: string; accountId: string | null; page: PageQuery }[];
  groupInstanceFetches: { groupId: string; accountId: string | null }[];
  galleryPages: {
    groupId: string;
    galleryId: string;
    accountId: string | null;
    page: PageQuery;
  }[];
  userBatches: { userIds: string[]; accountId: string | null }[];
  mutualLookups: { userId: string; accountId: string | null; page: PageQuery }[];
  noteWrites: { userId: string; accountId: string | null; note: string }[];
  removed: string[];
  selfInvites: { accountId: string; target: InviteTarget }[];
  listeners: ((event: StreamEvent) => void)[];
  unsubscribed: number;
}

function fakeDeps(overrides: Partial<ControlDeps> = {}): { deps: ControlDeps; seen: Recorder } {
  const seen: Recorder = {
    eventQueries: [],
    worldLookups: [],
    worldBatches: [],
    instanceLookups: [],
    friendQueries: [],
    notificationQueries: [],
    notificationsSeen: [],
    imageUrls: [],
    userLookups: [],
    groupLookups: [],
    groupFetches: [],
    groupMemberPages: [],
    groupPostPages: [],
    groupInstanceFetches: [],
    galleryPages: [],
    userBatches: [],
    mutualLookups: [],
    noteWrites: [],
    removed: [],
    selfInvites: [],
    listeners: [],
    unsubscribed: 0,
  };
  let settings: Settings = { theme: "dark" };

  const deps: ControlDeps = {
    status: async () => ({
      degradedKeychain: false,
      backend: "windows-credential-manager",
      accounts: 1,
      rateLimit: {
        limit: 20,
        remaining: 20,
        queued: 0,
        retryAfter: null,
        used: emptySeries(),
        windowSeconds: WINDOW_SECONDS,
      },
    }),
    listAccounts: async () => [ACCOUNT],
    listPendingConsent: async () => [],
    setConsentAccount: async () => {
      throw new Error("unused");
    },
    denyConsent: async () => {},
    listConnectedApps: async () => [],
    revokeConnectedApp: async () => {},
    revokeAllConnectedApps: async () => 0,
    streamClientCount: () => 0,
    login: async ({ username }) =>
      username === "needs2fa"
        ? { status: "requires-2fa", accountId: ACCOUNT.id, methods: ["totp", "emailOtp"] }
        : { status: "ok", account: ACCOUNT },
    verifyTwoFactor: async () => ACCOUNT,
    removeAccount: async (id) => {
      if (id !== ACCOUNT.id) throw new ControlError(404, "no_such_account");
      seen.removed.push(id);
    },
    inviteSelfTo: async (accountId, target) => {
      if (accountId !== ACCOUNT.id) throw new ControlError(404, "unknown_account");
      seen.selfInvites.push({ accountId, target });
    },
    listInstanceUsers: async (target, accountId) => {
      seen.instanceLookups.push({ target, accountId });
      const location = `${target.worldId}:${target.instanceId}`;
      // An instance nobody signed in is standing in: VRChat omits `users` entirely, which is a
      // normal state and answers 200, not an error.
      if (target.instanceId.startsWith("99999")) {
        return { location, fetchedAt: 1_700_000_000_000, source: "unavailable", users: [] };
      }
      return {
        location,
        fetchedAt: 1_700_000_000_000,
        source: "instance",
        users: [INSTANCE_USER],
      };
    },
    listSessions: async () => [
      {
        id: 1,
        accountId: ACCOUNT.id,
        displayName: "Tester",
        startedAt: 1_700_000_000_000,
        vrMode: "Desktop",
        currentLocation: null,
        currentWorldId: null,
      },
    ],
    listEvents: async (query) => {
      seen.eventQueries.push(query);
      return [];
    },
    listFriends: async (accountId) => {
      seen.friendQueries.push(accountId);
      return [];
    },
    listNotifications: async (accountId) => {
      seen.notificationQueries.push(accountId);
      return [];
    },
    markNotificationSeen: async (id) => {
      seen.notificationsSeen.push(id);
    },
    getUser: async (userId, accountId) => {
      seen.userLookups.push({ userId, accountId });
      if (userId === "usr_missing") throw new ControlError(404, "unknown_user");
      return { ...USER_DETAIL, id: userId };
    },
    getWorld: async (worldId) => {
      seen.worldLookups.push(worldId);
      if (worldId === WORLD_MISSING) throw new ControlError(404, "unknown_world");
      return { ...WORLD_DETAIL, id: worldId };
    },
    listWorlds: async (worldIds) => {
      seen.worldBatches.push([...worldIds]);
      // One of the ids is a world that no longer exists: it is simply absent from the map rather
      // than failing the batch.
      const worlds: Record<string, WorldSummary> = {};
      for (const id of worldIds) {
        if (id !== WORLD_MISSING) worlds[id] = { ...WORLD_SUMMARY, id };
      }
      return { worlds };
    },
    getInstance: async (target, accountId) => {
      seen.instanceLookups.push({ target, accountId });
      const location = `${target.worldId}:${target.instanceId}`;
      // VRChat answers a bare `null` for an instance id it dislikes, and 404s a closed one. Both
      // are ordinary, and both land here as `unavailable`.
      if (target.instanceId.startsWith("99999")) {
        return { location, fetchedAt: 1_700_000_000_000, source: "unavailable", instance: null };
      }
      return {
        location,
        fetchedAt: 1_700_000_000_000,
        source: "instance",
        instance: { ...INSTANCE_INFO, worldId: target.worldId, instanceId: target.instanceId },
      };
    },
    listUsers: async (userIds, accountId) => {
      seen.userBatches.push({ userIds: [...userIds], accountId });
      // Unresolvable ids are absent rather than an error — the batch contract, not a shortcut.
      return { users: userIds.filter((id) => id !== "usr_missing").map(instanceUserFor) };
    },
    listUserGroups: async (userId, accountId) => {
      seen.groupLookups.push({ userId, accountId });
      if (userId === "usr_missing") throw new ControlError(404, "unknown_user");
      // A user in no visible group is a 200 with an empty list — see `UserGroups.groups`.
      return { groups: userId === "usr_loner" ? [] : [GROUP] };
    },
    getGroup: async (groupId, accountId) => {
      seen.groupFetches.push({ groupId, accountId });
      // A 404 here is both "gone" and "you may not see it" — the daemon cannot tell them apart,
      // and the route must pass whichever one VRChat meant through unchanged.
      if (groupId === MISSING_GROUP_ID) {
        throw new ControlError(404, "unknown_group");
      }
      return GROUP_DETAIL;
    },

    /*
     * The four sub-resources share one fake shape: the missing group 404s, the closed group 403s,
     * and everything else serves one full page then one short one. The 403 is the interesting case
     * — it is what a non-member gets from most groups, and the route must not flatten it into an
     * empty list.
     */
    listGroupMembers: async (groupId, accountId, page) => {
      seen.groupMemberPages.push({ groupId, accountId, page });
      groupGate(groupId);
      return page.offset === 0
        ? { members: rows(GROUP_MEMBER, page.n), hasMore: true }
        : { members: [], hasMore: false };
    },
    listGroupPosts: async (groupId, accountId, page) => {
      seen.groupPostPages.push({ groupId, accountId, page });
      groupGate(groupId);
      return page.offset === 0
        ? { posts: rows(GROUP_POST, page.n), hasMore: true }
        : { posts: [], hasMore: false };
    },
    listGroupInstances: async (groupId, accountId) => {
      seen.groupInstanceFetches.push({ groupId, accountId });
      groupGate(groupId);
      return { instances: [GROUP_INSTANCE] };
    },
    listGroupGalleryImages: async (groupId, galleryId, accountId, page) => {
      seen.galleryPages.push({ groupId, galleryId, accountId, page });
      groupGate(groupId);
      return page.offset === 0
        ? { images: rows(GALLERY_IMAGE, page.n), hasMore: true }
        : { images: [], hasMore: false };
    },

    listMutualFriends: async (userId, accountId, page) => {
      seen.mutualLookups.push({ userId, accountId, page });
      if (userId === "usr_missing") throw new ControlError(404, "unknown_user");
      // Two pages of one, so paging is observable through the route.
      return page.offset === 0 ? { users: [MUTUAL], hasMore: true } : { users: [], hasMore: false };
    },
    setUserNote: async (userId, accountId, note) => {
      seen.noteWrites.push({ userId, accountId, note });
      return {
        accountId: accountId ?? ACCOUNT.id,
        userId,
        note: note === "" ? null : note,
        updatedAt: note === "" ? null : 1_700_000_000_000,
      };
    },
    fetchImage: async (url) => {
      seen.imageUrls.push(url);
      if (url.includes("missing")) return null;
      return { bytes: PNG_BYTES, contentType: "image/png" };
    },
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    subscribeEvents: (listener) => {
      seen.listeners.push(listener);
      return () => {
        seen.unsubscribed += 1;
      };
    },
    ...overrides,
  };

  return { deps, seen };
}

function app(deps: ControlDeps) {
  return createControlApp({ port: PORT, deps, token: () => TOKEN });
}

async function call(
  deps: ControlDeps,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers };
  return await app(deps).fetch(
    new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers }),
  );
}

describe("control API guards", () => {
  test("a foreign Host is rejected", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/status", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("a missing token is 401", async () => {
    const { deps } = fakeDeps();
    const res = await app(deps).fetch(
      new Request(`http://127.0.0.1:${PORT}/api/status`, {
        headers: { host: `localhost:${PORT}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("all three token transports reach the route", async () => {
    const { deps } = fakeDeps();
    const host = `127.0.0.1:${PORT}`;
    const url = `http://127.0.0.1:${PORT}/api/status`;

    const bearer = await app(deps).fetch(
      new Request(url, { headers: { host, authorization: `Bearer ${TOKEN}` } }),
    );
    const header = await app(deps).fetch(
      new Request(url, { headers: { host, [TOKEN_HEADER]: TOKEN } }),
    );
    const query = await app(deps).fetch(
      new Request(`${url}?token=${TOKEN}`, { headers: { host } }),
    );

    expect([bearer.status, header.status, query.status]).toEqual([200, 200, 200]);
  });
});

describe("control API routes", () => {
  test("GET /api/status reports the app version alongside the daemon snapshot", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/status");
    // `used.history` is 600 zeroes and asserting it inline would bury everything else, so the
    // measured half is checked by shape and the rest by value.
    const body = (await res.json()) as DaemonStatus;
    const { rateLimit, ...rest } = body;
    expect(rest).toEqual({
      version: APP_VERSION,
      degradedKeychain: false,
      backend: "windows-credential-manager",
      accounts: 1,
    });
    expect(rateLimit).toMatchObject({ limit: 20, remaining: 20, queued: 0, retryAfter: null });
    expect(rateLimit.windowSeconds).toBe(WINDOW_SECONDS);
    expect(rateLimit.used.history).toHaveLength(WINDOW_SECONDS);
    expect(rateLimit.used.current).toBe(0);
  });

  test("GET /api/accounts lists accounts", async () => {
    const { deps } = fakeDeps();
    expect(await (await call(deps, "/api/accounts")).json()).toEqual([ACCOUNT]);
  });

  test("POST /api/accounts/login returns ok or a 2FA challenge", async () => {
    const { deps } = fakeDeps();
    const ok = await call(deps, "/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ username: "tester", password: "hunter2" }),
    });
    expect(await ok.json()).toEqual({ status: "ok", account: ACCOUNT });

    const challenge = await call(deps, "/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ username: "needs2fa", password: "hunter2" }),
    });
    expect(await challenge.json()).toEqual({
      status: "requires-2fa",
      accountId: ACCOUNT.id,
      methods: ["totp", "emailOtp"],
    });
  });

  test("POST /api/accounts/login 400s on a malformed body", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ username: "tester" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/accounts/:id/verify-2fa rejects an unknown method", async () => {
    const { deps } = fakeDeps();
    const bad = await call(deps, `/api/accounts/${ACCOUNT.id}/verify-2fa`, {
      method: "POST",
      body: JSON.stringify({ method: "carrier-pigeon", code: "123456" }),
    });
    expect(bad.status).toBe(400);

    const good = await call(deps, `/api/accounts/${ACCOUNT.id}/verify-2fa`, {
      method: "POST",
      body: JSON.stringify({ method: "totp", code: "123456" }),
    });
    expect(await good.json()).toEqual({ status: "ok", account: ACCOUNT });
  });

  test("DELETE /api/accounts/:id removes, and 404s for an unknown id", async () => {
    const { deps, seen } = fakeDeps();
    const ok = await call(deps, `/api/accounts/${ACCOUNT.id}`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(seen.removed).toEqual([ACCOUNT.id]);

    const missing = await call(deps, "/api/accounts/usr_nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "no_such_account" });
  });

  test("GET /api/sessions returns live sessions", async () => {
    const { deps } = fakeDeps();
    const sessions = (await (await call(deps, "/api/sessions")).json()) as unknown[];
    expect(sessions).toHaveLength(1);
  });

  test("GET /api/events forwards and clamps its query", async () => {
    const { deps, seen } = fakeDeps();
    await call(deps, "/api/events");
    await call(deps, "/api/events?accountId=usr_1&kind=friend.online&limit=5&before=1700000000000");
    await call(deps, "/api/events?limit=99999");
    await call(deps, "/api/events?limit=nonsense&before=nonsense&accountId=");

    expect(seen.eventQueries).toEqual([
      { limit: 100 },
      { limit: 5, accountId: "usr_1", kind: "friend.online", before: 1_700_000_000_000 },
      { limit: 500 },
      { limit: 100 },
    ]);
  });

  test("GET /api/events forwards the session and subject selectors", async () => {
    const { deps, seen } = fakeDeps();
    await call(deps, "/api/events?sessionId=42");
    await call(deps, "/api/events?subjectId=usr_a&kind=gamelog.player_join&before=1700000000000");
    await call(deps, "/api/events?sessionId=0&limit=10");

    expect(seen.eventQueries).toEqual([
      { limit: 100, sessionId: 42 },
      {
        limit: 100,
        subjectId: "usr_a",
        kind: "gamelog.player_join",
        before: 1_700_000_000_000,
      },
      { limit: 10, sessionId: 0 },
    ]);
  });

  /*
   * A `sessionId` that failed to parse would otherwise widen the query from one game client to
   * every row in the database — the same shape of silent wrong answer as a filter applied after
   * the LIMIT, and far harder to notice.
   */
  test("GET /api/events 400s on an unparseable or combined selector", async () => {
    const { deps, seen } = fakeDeps();
    const bad = await call(deps, "/api/events?sessionId=nonsense");
    const negative = await call(deps, "/api/events?sessionId=-1");
    const combined = await call(deps, "/api/events?sessionId=1&subjectId=usr_a");
    const alsoCombined = await call(deps, "/api/events?accountId=usr_1&sessionId=1");

    expect([bad.status, negative.status, combined.status, alsoCombined.status]).toEqual([
      400, 400, 400, 400,
    ]);
    expect(await combined.json()).toMatchObject({ error: "invalid_query" });
    // Nothing reached the daemon: a rejected query must not half-run.
    expect(seen.eventQueries).toEqual([]);
  });

  test("GET /api/users/:id passes the user id and the chosen account through", async () => {
    const { deps, seen } = fakeDeps();
    const anyAccount = await call(deps, "/api/users/usr_subject");
    await call(deps, `/api/users/usr_subject?accountId=${ACCOUNT.id}`);

    expect(await anyAccount.json()).toEqual(USER_DETAIL);
    expect(seen.userLookups).toEqual([
      { userId: "usr_subject", accountId: null },
      { userId: "usr_subject", accountId: ACCOUNT.id },
    ]);
  });

  test("GET /api/users/:id surfaces the dependency's 404", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/users/usr_missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_user" });
  });

  test("GET /api/users/:id/groups serves the list, and an empty one is still a 200", async () => {
    const { deps, seen } = fakeDeps();
    const listed = await call(deps, `/api/users/usr_subject/groups?accountId=${ACCOUNT.id}`);
    expect(await listed.json()).toEqual({ groups: [GROUP] });

    // VRChat filters this list by what the *viewer* may see, so nothing visible is a correct
    // answer about a user in a dozen groups — not a 404.
    const empty = await call(deps, "/api/users/usr_loner/groups");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ groups: [] });

    expect(seen.groupLookups).toEqual([
      { userId: "usr_subject", accountId: ACCOUNT.id },
      { userId: "usr_loner", accountId: null },
    ]);
  });

  test("GET /api/users batches, dedupes, drops junk ids, and caps the list", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(
      deps,
      `/api/users?ids=usr_a,usr_a,%20usr_b%20,not/an/id&accountId=${ACCOUNT.id}`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as UserBatch).users.map((user) => user.id)).toEqual([
      "usr_a",
      "usr_b",
    ]);
    // Deduped and filtered before the dependency sees them: every id past the cache is one
    // upstream call, so asking for the same person twice is one call's worth of waste.
    expect(seen.userBatches).toEqual([{ userIds: ["usr_a", "usr_b"], accountId: ACCOUNT.id }]);

    // An id VRChat will not resolve is absent from the answer, not a failure for the other rows.
    const partial = await call(deps, "/api/users?ids=usr_a,usr_missing");
    expect(((await partial.json()) as UserBatch).users.map((user) => user.id)).toEqual(["usr_a"]);

    // A cap is about upstream spend, so it is refused rather than truncated — truncating serves a
    // partial answer that looks complete.
    const tooMany = await call(
      deps,
      `/api/users?ids=${Array.from({ length: MAX_USER_IDS + 1 }, (_, i) => `usr_${String(i)}`).join(",")}`,
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: "too_many_ids" });

    expect((await call(deps, "/api/users")).status).toBe(400);
  });

  test("GET /api/groups/:id serves the group and threads the account", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(deps, `/api/groups/${GROUP_ID}?accountId=${ACCOUNT.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GROUP_DETAIL);

    // Omitted, the account is `null` and the daemon picks one — `membershipStatus` is a statement
    // about whoever asked, so which account that was has to reach the dependency either way.
    await call(deps, `/api/groups/${GROUP_ID}`);
    expect(seen.groupFetches).toEqual([
      { groupId: GROUP_ID, accountId: ACCOUNT.id },
      { groupId: GROUP_ID, accountId: null },
    ]);
  });

  test("GET /api/groups/:id validates the id and surfaces a 404", async () => {
    const { deps, seen } = fakeDeps();
    for (const path of [
      "/api/groups/usr_notagroup",
      "/api/groups/grp_1%2fmembers",
      "/api/groups/",
    ]) {
      expect((await call(deps, path)).status, path).not.toBe(200);
    }
    expect(seen.groupFetches).toEqual([]);

    const missing = await call(deps, `/api/groups/${MISSING_GROUP_ID}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "unknown_group" });
  });

  test("the group sub-resources serve their pages and thread the account", async () => {
    const { deps, seen } = fakeDeps();

    const members = await call(deps, `/api/groups/${GROUP_ID}/members?accountId=${ACCOUNT.id}`);
    expect(members.status).toBe(200);
    expect(await members.json()).toEqual({
      members: rows(GROUP_MEMBER, 25),
      // A full page is the only evidence another exists — VRChat sends no total.
      hasMore: true,
    });

    const posts = await call(deps, `/api/groups/${GROUP_ID}/posts?n=2`);
    expect(await posts.json()).toEqual({ posts: rows(GROUP_POST, 2), hasMore: true });

    const instances = await call(deps, `/api/groups/${GROUP_ID}/instances?accountId=${ACCOUNT.id}`);
    expect(await instances.json()).toEqual({ instances: [GROUP_INSTANCE] });

    const images = await call(
      deps,
      `/api/groups/${GROUP_ID}/galleries/${GALLERY_ID}/images?n=3&accountId=${ACCOUNT.id}`,
    );
    expect(await images.json()).toEqual({ images: rows(GALLERY_IMAGE, 3), hasMore: true });

    // Which account is asking reaches every one of them: a non-member is refused outright, so the
    // eyes are part of the question rather than a detail of how it was answered.
    expect(seen.groupMemberPages[0]?.accountId).toBe(ACCOUNT.id);
    expect(seen.groupPostPages[0]?.accountId).toBe(null);
    expect(seen.groupInstanceFetches).toEqual([{ groupId: GROUP_ID, accountId: ACCOUNT.id }]);
    expect(seen.galleryPages).toEqual([
      {
        groupId: GROUP_ID,
        galleryId: GALLERY_ID,
        accountId: ACCOUNT.id,
        page: { n: 3, offset: 0 },
      },
    ]);
  });

  /*
   * `hasMore` is derived from `returned === n` and nothing else, so the interesting assertion is
   * the *short* page — that is the only one anything upstream lets us be certain about.
   */
  test("the paged group sub-resources report hasMore false on a short page", async () => {
    const { deps } = fakeDeps();

    const members = await call(deps, `/api/groups/${GROUP_ID}/members?n=5&offset=5`);
    expect(await members.json()).toEqual({ members: [], hasMore: false });

    const posts = await call(deps, `/api/groups/${GROUP_ID}/posts?n=5&offset=5`);
    expect(await posts.json()).toEqual({ posts: [], hasMore: false });

    const images = await call(
      deps,
      `/api/groups/${GROUP_ID}/galleries/${GALLERY_ID}/images?n=5&offset=5`,
    );
    expect(await images.json()).toEqual({ images: [], hasMore: false });
  });

  /*
   * The whole reason `group_forbidden` exists. An empty list and "you may not look" are different
   * facts about a group, and the UI draws them differently — "membership required" against "nobody
   * has joined yet". A route that flattened the 403 would make the second sentence appear in front
   * of a group with four hundred members.
   */
  test("a 403 from a group sub-resource is group_forbidden, never an empty list", async () => {
    const { deps } = fakeDeps();
    for (const path of [
      `/api/groups/${CLOSED_GROUP_ID}/members`,
      `/api/groups/${CLOSED_GROUP_ID}/posts`,
      `/api/groups/${CLOSED_GROUP_ID}/instances`,
      `/api/groups/${CLOSED_GROUP_ID}/galleries/${GALLERY_ID}/images`,
    ]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ error: "group_forbidden" });
    }
  });

  test("a 404 from a group sub-resource stays unknown_group", async () => {
    const { deps } = fakeDeps();
    for (const path of [
      `/api/groups/${MISSING_GROUP_ID}/members`,
      `/api/groups/${MISSING_GROUP_ID}/posts`,
      `/api/groups/${MISSING_GROUP_ID}/instances`,
      `/api/groups/${MISSING_GROUP_ID}/galleries/${GALLERY_ID}/images`,
    ]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({ error: "unknown_group" });
    }
  });

  test("the group sub-resources clamp n, reject a bad offset, and validate both ids", async () => {
    const { deps, seen } = fakeDeps();

    await call(deps, `/api/groups/${GROUP_ID}/members?n=99999`);
    await call(deps, `/api/groups/${GROUP_ID}/members?n=nonsense`);
    expect(seen.groupMemberPages.map((p) => p.page)).toEqual([
      // VRChat's own ceiling for `n` on these endpoints. Asking for more could only be answered
      // with 100 anyway, and pretending otherwise would make `hasMore` permanently false.
      { n: 100, offset: 0 },
      { n: 25, offset: 0 },
    ]);

    for (const query of ["?offset=nonsense", "?offset=-1", "?offset=1.5"]) {
      const res = await call(deps, `/api/groups/${GROUP_ID}/posts${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_query" });
    }
    expect(seen.groupPostPages).toEqual([]);

    // A `/` in either id would turn one path segment into several on the way upstream.
    for (const path of [
      "/api/groups/usr_notagroup/members",
      `/api/groups/${GROUP_ID}/galleries/ggal_1%2fmembers/images`,
      `/api/groups/${GROUP_ID}/galleries//images`,
    ]) {
      expect((await call(deps, path)).status, path).not.toBe(200);
    }
    expect(seen.galleryPages).toEqual([]);
    expect(seen.groupInstanceFetches).toEqual([]);
  });

  test("GET /api/users/:id/mutual-friends pages, defaults, and clamps", async () => {
    const { deps, seen } = fakeDeps();
    const first = await call(deps, "/api/users/usr_subject/mutual-friends");
    expect(await first.json()).toEqual({ users: [MUTUAL], hasMore: true });

    const second = await call(deps, "/api/users/usr_subject/mutual-friends?n=10&offset=25");
    expect(await second.json()).toEqual({ users: [], hasMore: false });

    // `n` beyond VRChat's own ceiling is clamped rather than refused; nonsense falls back.
    await call(deps, "/api/users/usr_subject/mutual-friends?n=99999");
    await call(deps, "/api/users/usr_subject/mutual-friends?n=nonsense");

    expect(seen.mutualLookups.map((lookup) => lookup.page)).toEqual([
      { n: 25, offset: 0 },
      { n: 10, offset: 25 },
      { n: 100, offset: 0 },
      { n: 25, offset: 0 },
    ]);
  });

  /*
   * `offset` is rejected where `n` is clamped, and the asymmetry is the point: a silently-zeroed
   * offset hands the infinite scroll page one again under the name of page five, which reads as
   * duplicated data rather than as a bad request.
   */
  test("GET /api/users/:id/mutual-friends 400s on an unparseable offset", async () => {
    const { deps, seen } = fakeDeps();
    for (const query of ["?offset=nonsense", "?offset=-1", "?offset=1.5"]) {
      const res = await call(deps, `/api/users/usr_subject/mutual-friends${query}`);
      expect(res.status, query).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_query" });
    }
    expect(seen.mutualLookups).toEqual([]);
  });

  test("both sub-routes validate the user id and surface a 404", async () => {
    const { deps, seen } = fakeDeps();
    for (const path of [
      "/api/users/usr_1%2ffriends/groups",
      "/api/users/..%2fauth%2fuser/mutual-friends",
    ]) {
      expect((await call(deps, path)).status, path).toBe(400);
    }
    expect(seen.groupLookups).toEqual([]);
    expect(seen.mutualLookups).toEqual([]);

    for (const path of ["/api/users/usr_missing/groups", "/api/users/usr_missing/mutual-friends"]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toMatchObject({ error: "unknown_user" });
    }
  });

  test("PUT /api/users/:id/note writes, clears, and rejects", async () => {
    const { deps, seen } = fakeDeps();
    const written = await call(deps, "/api/users/usr_subject/note", {
      method: "PUT",
      body: JSON.stringify({ note: "met at a movie world" }),
    });
    expect(await written.json()).toEqual({
      accountId: ACCOUNT.id,
      userId: "usr_subject",
      note: "met at a movie world",
      updatedAt: 1_700_000_000_000,
    });

    // An empty string is a deletion, not a malformed body.
    const cleared = await call(deps, "/api/users/usr_subject/note", {
      method: "PUT",
      body: JSON.stringify({ note: "" }),
    });
    expect(await cleared.json()).toMatchObject({ note: null, updatedAt: null });

    const wrongType = await call(deps, "/api/users/usr_subject/note", {
      method: "PUT",
      body: JSON.stringify({ note: 7 }),
    });
    const tooLong = await call(deps, "/api/users/usr_subject/note", {
      method: "PUT",
      body: JSON.stringify({ note: "x".repeat(257) }),
    });

    expect([wrongType.status, tooLong.status]).toEqual([400, 400]);
    expect(await tooLong.json()).toMatchObject({ error: "note_too_long" });
    expect(seen.noteWrites).toEqual([
      { userId: "usr_subject", accountId: null, note: "met at a movie world" },
      { userId: "usr_subject", accountId: null, note: "" },
    ]);
  });

  test("GET /api/friends passes null for every account", async () => {
    const { deps, seen } = fakeDeps();
    await call(deps, "/api/friends");
    await call(deps, "/api/friends?accountId=usr_1");
    expect(seen.friendQueries).toEqual([null, "usr_1"]);
  });

  test("GET and PUT /api/settings round-trip a patch", async () => {
    const { deps } = fakeDeps();
    expect(await (await call(deps, "/api/settings")).json()).toEqual({ theme: "dark" });
    const updated = await call(deps, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ theme: "light" }),
    });
    expect(await updated.json()).toEqual({ theme: "light" });
  });

  test("an unexpected dependency failure is a 500, not a crash", async () => {
    const { deps } = fakeDeps({
      status: async () => {
        throw new Error("store is on fire");
      },
    });
    const res = await call(deps, "/api/status");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
  });

  test("the control port serves no proxy route", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/1/auth/user");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/accounts/:id/invite-self", () => {
  const LOCATION = "wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345~hidden(usr_1)~region(eu)";

  function invite(deps: ControlDeps, id: string, body: unknown): Promise<Response> {
    return call(deps, `/api/accounts/${id}/invite-self`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  test("splits the location and hands the account the instance to invite itself to", async () => {
    const { deps, seen } = fakeDeps();
    const res = await invite(deps, ACCOUNT.id, { location: LOCATION });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(seen.selfInvites).toEqual([
      {
        accountId: ACCOUNT.id,
        target: {
          worldId: "wrld_ba913a96-fac4-4048-a062-9aa5db092812",
          // The tags travel with the instance id. Without them VRChat cannot tell which closed
          // instance is meant, and the invite is refused.
          instanceId: "12345~hidden(usr_1)~region(eu)",
        },
      },
    ]);
  });

  test("400s on a location that is missing, unjoinable, or malformed — without calling the daemon", async () => {
    const { deps, seen } = fakeDeps();
    for (const body of [
      {},
      { location: "" },
      { location: "offline" },
      { location: "private" },
      { location: "traveling" },
      { location: "traveling:traveling" },
      { location: "wrld_ba913a96-fac4-4048-a062-9aa5db092812" },
      { location: "notaworld:12345" },
      // A second path segment smuggled through the instance id is the reason the tail is an
      // allowlist rather than a "no colons" check.
      { location: "wrld_ba913a96-fac4-4048-a062-9aa5db092812:../../auth/user" },
      { location: "wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345?x=1" },
      { location: "wrld_ba913a96-fac4-4048-a062-9aa5db092812:" },
      { location: 12_345 },
    ]) {
      const res = await invite(deps, ACCOUNT.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_location" });
    }
    expect(seen.selfInvites).toEqual([]);
  });

  test("a dependency's own error status survives the route", async () => {
    const { deps } = fakeDeps();
    const unknown = await invite(deps, "usr_nope", { location: LOCATION });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "unknown_account" });

    const { deps: offline } = fakeDeps({
      inviteSelfTo: async () => {
        throw new ControlError(409, "account_offline");
      },
    });
    const res = await invite(offline, ACCOUNT.id, { location: LOCATION });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "account_offline" });
  });
});

describe("GET /api/instance-users", () => {
  const WORLD = "wrld_ba913a96-fac4-4048-a062-9aa5db092812";
  const LOCATION = `${WORLD}:12345~hidden(usr_1)~region(eu)`;

  function roster(location: string, query = ""): string {
    return `/api/instance-users?location=${encodeURIComponent(location)}${query}`;
  }

  test("serves the roster, and passes the split location and chosen account through", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(deps, roster(LOCATION));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      location: LOCATION,
      fetchedAt: 1_700_000_000_000,
      source: "instance",
      users: [INSTANCE_USER],
    });

    await call(deps, roster(LOCATION, `&accountId=${ACCOUNT.id}`));
    expect(seen.instanceLookups).toEqual([
      // The tags travel with the instance id — a hidden instance quoted without them is a
      // different instance as far as VRChat is concerned.
      { target: { worldId: WORLD, instanceId: "12345~hidden(usr_1)~region(eu)" }, accountId: null },
      {
        target: { worldId: WORLD, instanceId: "12345~hidden(usr_1)~region(eu)" },
        accountId: ACCOUNT.id,
      },
    ]);
  });

  /*
   * The case this route is most likely to hit in the wild, and the reason it is a 200. VRChat
   * populates `users` only for an account that is *in* the instance; every other instance answers
   * without it. Erroring there would put a red banner on a screen that is working correctly.
   */
  test("an absent roster is a 200 with source unavailable, not an error", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, roster(`${WORLD}:99999~region(us)`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      location: `${WORLD}:99999~region(us)`,
      fetchedAt: 1_700_000_000_000,
      source: "unavailable",
      users: [],
    });
  });

  test("400s on a missing or unjoinable location — without calling the daemon", async () => {
    const { deps, seen } = fakeDeps();
    for (const path of [
      "/api/instance-users",
      "/api/instance-users?location=",
      roster("offline"),
      roster("private"),
      roster("traveling"),
      roster("traveling:wrld_x:12345"),
      // A world with no instance is not a place anyone can be standing.
      roster(WORLD),
      roster("notaworld:12345"),
      // The same second-path-segment smuggling the self-invite route refuses.
      roster(`${WORLD}:../../auth/user`),
      roster(`${WORLD}:12345?x=1`),
    ]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_location" });
    }
    expect(seen.instanceLookups).toEqual([]);
  });

  test("503s when nobody is signed in", async () => {
    const { deps } = fakeDeps({
      listInstanceUsers: async () => {
        throw new ControlError(503, "no_account");
      },
    });
    const res = await call(deps, roster(LOCATION));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "no_account" });
  });
});

describe("GET /api/worlds", () => {
  test("resolves a batch in one request, and skips what it cannot resolve", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(deps, `/api/worlds?ids=${WORLD_ID},${WORLD_MISSING}`);

    expect(res.status).toBe(200);
    // The dead world is absent from the map rather than null — one dead world must not cost the
    // other forty-nine their names.
    expect(await res.json()).toEqual({ worlds: { [WORLD_ID]: WORLD_SUMMARY } });
    expect(seen.worldBatches).toEqual([[WORLD_ID, WORLD_MISSING]]);
  });

  test("de-duplicates ids and drops ones that are not world ids", async () => {
    const { deps, seen } = fakeDeps();
    // A feed page is full of rows in the same world, and a location string is not a world id.
    await call(deps, `/api/worlds?ids=${WORLD_ID},${WORLD_ID},usr_1,,${WORLD_ID}:12345`);
    expect(seen.worldBatches).toEqual([[WORLD_ID]]);
  });

  test("400s above the id cap, and when ids is missing entirely", async () => {
    const { deps, seen } = fakeDeps();
    const tooMany = await call(
      deps,
      `/api/worlds?ids=${Array.from({ length: MAX_WORLD_IDS + 1 }, (_, i) => `wrld_${String(i)}`).join(",")}`,
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: "too_many_ids" });

    const missing = await call(deps, "/api/worlds");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "invalid_query" });

    // Truncating instead of refusing would serve a partial answer that looks complete.
    expect(seen.worldBatches).toEqual([]);
  });

  test("an all-unresolvable batch is still a 200 with an empty map", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, `/api/worlds?ids=${WORLD_MISSING}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ worlds: {} });
  });
});

describe("GET /api/worlds/:id", () => {
  test("serves the full world and passes the id through", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(deps, `/api/worlds/${WORLD_ID}`);
    expect(await res.json()).toEqual(WORLD_DETAIL);
    expect(seen.worldLookups).toEqual([WORLD_ID]);
  });

  test("400s on anything that is not a world id, and surfaces a 404", async () => {
    const { deps, seen } = fakeDeps();
    for (const id of [
      "usr_1",
      "wrld_1%2finstances",
      "..%2fauth%2fuser",
      `wrld_${"9".repeat(70)}`,
    ]) {
      const res = await call(deps, `/api/worlds/${id}`);
      expect(res.status, id).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_world_id" });
    }
    expect(seen.worldLookups).toEqual([]);

    const missing = await call(deps, `/api/worlds/${WORLD_MISSING}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "unknown_world" });
  });
});

describe("GET /api/instances", () => {
  const LOCATION = `${WORLD_ID}:12345~hidden(usr_1)~region(eu)`;

  test("serves the instance with its world summary", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(deps, `/api/instances?location=${encodeURIComponent(LOCATION)}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      location: LOCATION,
      source: "instance",
      instance: {
        worldId: WORLD_ID,
        instanceId: "12345~hidden(usr_1)~region(eu)",
        type: "hidden",
        region: "eu",
        userCount: 12,
        // Free: VRChat embeds the whole world record in the instance response.
        world: WORLD_SUMMARY,
      },
    });
    expect(seen.instanceLookups).toHaveLength(1);
  });

  test("a closed or unrecognised instance is a 200 with source unavailable", async () => {
    const { deps } = fakeDeps();
    const location = `${WORLD_ID}:99999~region(us)`;
    const res = await call(deps, `/api/instances?location=${encodeURIComponent(location)}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      location,
      fetchedAt: 1_700_000_000_000,
      source: "unavailable",
      instance: null,
    });
  });

  test("400s on a missing or unjoinable location, using the same validator", async () => {
    const { deps } = fakeDeps();
    for (const path of [
      "/api/instances",
      "/api/instances?location=",
      `/api/instances?location=${encodeURIComponent("private")}`,
      `/api/instances?location=${encodeURIComponent(WORLD_ID)}`,
      `/api/instances?location=${encodeURIComponent(`${WORLD_ID}:../../auth/user`)}`,
    ]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_location" });
    }
  });
});

describe("parseWorldId and parseWorldIds", () => {
  test("a world id is the same allowlist parseInviteLocation applies", () => {
    expect(parseWorldId(WORLD_ID)).toBe(WORLD_ID);
    for (const raw of [undefined, "", "usr_1", "wrld_1/instances", "wrld_1?x=1", "wrld_"]) {
      let thrown: unknown;
      try {
        parseWorldId(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(raw)).toBeInstanceOf(ControlError);
      expect((thrown as ControlError).code).toBe("invalid_world_id");
    }
  });

  test("the batch splits, trims, filters and de-duplicates", () => {
    expect(parseWorldIds(` ${WORLD_ID} , ${WORLD_ID},nonsense, `)).toEqual([WORLD_ID]);
    expect(parseWorldIds("")).toEqual([]);
  });
});

describe("parseInviteLocation", () => {
  test("accepts every instance shape VRChat actually issues", () => {
    const world = "wrld_ba913a96-fac4-4048-a062-9aa5db092812";
    for (const instance of [
      "12345",
      "12345~region(us)",
      "12345~friends(usr_1)~region(use)~nonce(6d4a1e1f-0b2c-4c1e-9a1e-8f0b2c4c1e9a)",
      "12345~private(usr_1)~canRequestInvite~region(jp)",
      "12345~group(grp_1)~groupAccessType(public)~region(eu)",
    ]) {
      expect(parseInviteLocation(`${world}:${instance}`)).toEqual({
        worldId: world,
        instanceId: instance,
      });
    }
  });

  test("rejects rather than forwarding, and always with the same code", () => {
    for (const raw of [
      undefined,
      "",
      "offline",
      "private",
      "traveling",
      "traveling:wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345",
      "wrld_ba913a96-fac4-4048-a062-9aa5db092812",
      "usr_1:12345",
      "wrld_ba913a96-fac4-4048-a062-9aa5db092812:~region(us)",
      "wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345/response",
      "wrld_ba913a96-fac4-4048-a062-9aa5db092812:12345%2f",
      `wrld_ba913a96-fac4-4048-a062-9aa5db092812:${"9".repeat(300)}`,
    ]) {
      let thrown: unknown;
      try {
        parseInviteLocation(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(raw)).toBeInstanceOf(ControlError);
      expect((thrown as ControlError).status).toBe(400);
      expect((thrown as ControlError).code).toBe("invalid_location");
    }
  });
});

describe("parseUserId", () => {
  test("accepts both the usr_ scheme and VRChat's legacy short ids", () => {
    for (const raw of ["usr_ba913a96-fac4-4048-a062-9aa5db092812", "8JoV9XEdKs", "abc_123"]) {
      expect(parseUserId(raw)).toBe(raw);
    }
  });

  test("rejects anything that could become a second path segment", () => {
    for (const raw of [
      undefined,
      "",
      "usr_1/friends",
      "usr_1%2ffriends",
      "usr_1?x=1",
      "usr_1#frag",
      "../auth/user",
      "u".repeat(65),
    ]) {
      let thrown: unknown;
      try {
        parseUserId(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(raw)).toBeInstanceOf(ControlError);
      expect((thrown as ControlError).code).toBe("invalid_user_id");
    }
  });
});

describe("GET /api/stream", () => {
  test("guards apply before the upgrade", async () => {
    const { deps, seen } = fakeDeps();
    const res = await app(deps).fetch(
      new Request(`http://127.0.0.1:${PORT}/api/stream`, {
        headers: { host: `127.0.0.1:${PORT}` },
      }),
    );
    expect(res.status).toBe(401);
    expect(seen.listeners).toEqual([]);
  });

  test("subscribes on open and unsubscribes on close", async () => {
    const { deps, seen } = fakeDeps();
    const port = 7791;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, srv) =>
        createControlApp({ port, deps, token: () => TOKEN }).fetch(request, srv),
      websocket: (await import("./control.ts")).controlWebSocketHandler,
    });
    // The app's Host allowlist is built from `port`, so ask under that name and let Bun route by
    // the real socket. `Host` is what the guard reads; the connection is still to `server.port`.
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/stream?token=${TOKEN}`, {
      headers: { host: `127.0.0.1:${port}` },
    });

    const first = await new Promise<string>((resolvePromise, rejectPromise) => {
      socket.addEventListener("message", (event) => resolvePromise(String(event.data)));
      socket.addEventListener("error", () => rejectPromise(new Error("socket error")));
    });
    expect(JSON.parse(first)).toMatchObject({ type: "ready" });
    expect(seen.listeners).toHaveLength(1);

    const pushed = new Promise<string>((resolvePromise) => {
      socket.addEventListener("message", (event) => resolvePromise(String(event.data)));
    });
    // A real kind and a real envelope. This test is about the socket plumbing rather than the
    // frame's contents, but a fixture that could not exist on the wire is one nobody can trust when
    // it fails.
    seen.listeners[0]?.({
      type: "friend.online",
      ts: 1_700_000_000_000,
      payload: {
        accountId: "usr_a",
        sessionId: null,
        subjectId: "usr_friend",
        location: null,
        data: { userId: "usr_friend" },
      },
    });
    expect(JSON.parse(await pushed)).toMatchObject({ type: "friend.online" });

    socket.close();
    await Bun.sleep(50);
    expect(seen.unsubscribed).toBe(1);
    server.stop(true);
  });
});

describe("GET /api/image", () => {
  function imagePath(url: string): string {
    return `/api/image?url=${encodeURIComponent(url)}`;
  }

  test("serves the bytes with a sniffable content type, an ETag, and a long private max-age", async () => {
    const { deps, seen } = fakeDeps();
    const res = await call(deps, imagePath(ICON_URL));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=604800, immutable");
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(seen.imageUrls).toEqual([ICON_URL]);
  });

  test("If-None-Match is answered 304 without ever reaching the daemon", async () => {
    const { deps, seen } = fakeDeps();
    const first = await call(deps, imagePath(ICON_URL));
    const etag = first.headers.get("ETag") ?? "";

    const second = await call(deps, imagePath(ICON_URL), {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    // The whole point of hashing the URL rather than the bytes: no upstream fetch on a revalidate.
    expect(seen.imageUrls).toEqual([ICON_URL]);

    // A weak validator and a list both still match.
    const weak = await call(deps, imagePath(ICON_URL), {
      headers: { "if-none-match": `W/${etag}, "something-else"` },
    });
    expect(weak.status).toBe(304);
  });

  test("400s on a missing, unparseable, or non-https url", async () => {
    const { deps } = fakeDeps();
    for (const path of [
      "/api/image",
      "/api/image?url=",
      `/api/image?url=${encodeURIComponent("not a url")}`,
      `/api/image?url=${encodeURIComponent("http://api.vrchat.cloud/api/1/file/x")}`,
      `/api/image?url=${encodeURIComponent("file:///C:/Windows/win.ini")}`,
    ]) {
      const res = await call(deps, path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_url" });
    }
  });

  test("the host allowlist is an exact match, so a suffix attack fails", async () => {
    const { deps, seen } = fakeDeps();
    for (const host of [
      "evil-api.vrchat.cloud.attacker.tld",
      "api.vrchat.cloud.attacker.tld",
      "attacker.tld",
      "127.0.0.1",
      "169.254.169.254",
      "vrchat.cloud",
    ]) {
      const res = await call(deps, imagePath(`https://${host}/api/1/file/x`));
      expect(res.status, host).toBe(400);
    }
    // Not one of them was handed to the daemon to fetch.
    expect(seen.imageUrls).toEqual([]);

    for (const host of ["api.vrchat.cloud", "assets.vrchat.com", "files.vrchat.cloud"]) {
      expect((await call(deps, imagePath(`https://${host}/x.png`))).status).toBe(200);
    }
  });

  test("404s when upstream has no such image", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, imagePath("https://api.vrchat.cloud/api/1/file/missing"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "image_not_found" });
  });

  test("503s when no account is online", async () => {
    const { deps } = fakeDeps({
      fetchImage: async () => {
        throw new ControlError(503, "no_account");
      },
    });
    const res = await call(deps, imagePath(ICON_URL));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "no_account" });
  });
});
