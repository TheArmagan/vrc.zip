import { describe, expect, test } from "bun:test";
import { Account } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import type { FriendPresenceRecord, PresenceService } from "../accounts/presence.ts";
import { EventBus } from "../bus/event-bus.ts";
import { AvatarIdResolver } from "../net/avatar-ids.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import type { SecretsStore } from "../security/secrets.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings.ts";
import { MEMORY, Store } from "../store/index.ts";
import { createControlDeps } from "./control-deps.ts";
import type { PluginHost } from "./plugin-host.ts";

/**
 * The user routes and the feed selectors, against a real `Store` and real `Account`s with a
 * stubbed VRChat.
 *
 * The account layer is real rather than faked because the per-account cache is the whole point:
 * a double handing back one shared request context could not tell two viewers apart, which is
 * exactly the confusion migration 002 exists to prevent.
 */

const VIEWER = "usr_viewer";
const OTHER = "usr_other";
const SUBJECT = "usr_subject";
/** Module-level: the stub answers for it from `harness`, above the `describe` that asserts on it. */
const GROUP_ID = "grp_ba913a96-fac4-4048-a062-9aa5db092812";
const AVATAR_ID = "avtr_eb5a1798-6f23-4ec6-b879-2d01f44a69c4";
const AVATAR_MISSING = "avtr_00000000-0000-0000-0000-000000000000";
const AVATAR_FILE_ID = "file_d9ec5b06-6ea5-4ae0-ab67-78dfa3eea6df";
const T0 = 1_700_000_000_000;

/** The two bodies VRChat hands out for one user, depending on who asks. See PLAN.md §1.3. */
function userBody(asFriend: boolean): Record<string, unknown> {
  return {
    id: SUBJECT,
    displayName: "Subject",
    bio: asFriend ? "only friends see this" : "",
    // The trailing `""` is VRChat's padding, not a link.
    bioLinks: asFriend ? ["https://example.invalid", ""] : [],
    pronouns: "",
    status: "active",
    statusDescription: asFriend ? "in a world" : "",
    state: asFriend ? "online" : "offline",
    tags: ["system_trust_known", "language_eng"],
    // `hidden` is *verified but not published*. The modal and the instance roster must read this
    // one field rather than each inferring age verification from the `system_age_verified` tag.
    ageVerificationStatus: asFriend ? "18+" : "hidden",
    ageVerified: true,
    platform: asFriend ? "standalonewindows" : "",
    last_platform: "standalonewindows",
    location: asFriend ? "wrld_x:12345" : "",
    worldId: asFriend ? "wrld_x" : "",
    isFriend: asFriend,
    date_joined: "2018-03-04",
    last_login: asFriend ? "2026-08-20T10:00:00.000Z" : "",
    // Plain fields on `User`; they cost no extra call and were simply never passed through.
    bannerUrl: asFriend ? "https://api.vrchat.cloud/api/1/file/file_banner/1/1024" : "",
    bannerType: asFriend ? "gallery" : "",
    // Empty, so `pickUserImageUrl` has to fall through rather than stop at `""`.
    userIcon: "",
    profilePicOverride: "",
    profilePicOverrideThumbnail: "",
    currentAvatarThumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/file_a/1/256",
    currentAvatarImageUrl: "https://api.vrchat.cloud/api/1/image/file_a/1/1024",
  };
}

/**
 * `GET /profile/{id}` — the profile page's own half of a user.
 *
 * Deliberately holds **no presence at all**: no `location`, no `state`, no `last_login`. That is
 * the endpoint's real shape, and it is why this call supplements `/users/{id}` rather than
 * replacing it. A test that let presence leak in here would stop proving anything.
 */
function profileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUBJECT,
    displayName: "Subject",
    languages: ["eng", "jpn", ""],
    hasVrcPlus: true,
    bannerColor: "#112233",
    badges: [
      {
        badgeId: "bdg_second",
        badgeName: "Second",
        badgeDescription: "not showcased",
        badgeImageUrl: "https://assets.vrchat.com/badges/second.png",
        showcased: false,
      },
      {
        badgeId: "bdg_first",
        badgeName: "First",
        badgeDescription: "showcased",
        badgeImageUrl: "https://assets.vrchat.com/badges/first.png",
        showcased: true,
      },
      // No id: unkeyable, so it is dropped rather than rendered with a made-up one.
      { badgeName: "Nameless", badgeDescription: "", badgeImageUrl: "", showcased: false },
    ],
    representedGroup: null,
    ...overrides,
  };
}

/**
 * One `LimitedUserInstance` as `GET /instances/…` sends it.
 *
 * `isFriend: false` throughout, on purpose: the roster's `isFriend` has to be able to come from
 * vrc.zip's own presence map, and it cannot be proven to if the upstream body already says yes.
 */
function instanceUserBody(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: id.toUpperCase(),
    ageVerificationStatus: "18+",
    ageVerified: true,
    developerType: "none",
    isFriend: false,
    last_platform: "standalonewindows",
    platform: "standalonewindows",
    status: "active",
    statusDescription: "",
    tags: ["system_trust_veteran", "language_eng"],
    userIcon: "",
    profilePicOverride: "",
    profilePicOverrideThumbnail: "",
    currentAvatarThumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/${id}/1/256`,
    currentAvatarImageUrl: `https://api.vrchat.cloud/api/1/image/${id}/1/1024`,
    ...overrides,
  };
}

/** A world as `GET /worlds/{id}` sends it — VRChat's own field names and date strings. */
function worldBody(worldId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: worldId,
    name: "The Great Pug",
    description: "a pub",
    authorId: "usr_author",
    authorName: "Author",
    imageUrl: `https://api.vrchat.cloud/api/1/image/${worldId}/1/1024`,
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/${worldId}/1/256`,
    capacity: 40,
    recommendedCapacity: 20,
    tags: ["author_tag_pub", ""],
    releaseStatus: "public",
    visits: 1000,
    favorites: 10,
    heat: 5,
    popularity: 6,
    occupants: 12,
    publicationDate: "2020-01-02T03:04:05.000Z",
    // VRChat's literal string for a world that never went through Labs. Not a date.
    labsPublicationDate: "none",
    created_at: "2019-01-02T03:04:05.000Z",
    updated_at: "2021-01-02T03:04:05.000Z",
    version: 3,
    ...overrides,
  };
}

/** An avatar as `GET /avatars/{id}` sends it — VRChat's own field names and date strings. */
function avatarBody(avatarId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: avatarId,
    name: "A Robot",
    description: "beep",
    authorId: "usr_author",
    authorName: "Author",
    imageUrl: `https://api.vrchat.cloud/api/1/image/${AVATAR_FILE_ID}/1/1024`,
    thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/${AVATAR_FILE_ID}/1/256`,
    releaseStatus: "public",
    tags: ["author_tag_robot", ""],
    version: 3,
    created_at: "2019-01-02T03:04:05.000Z",
    updated_at: "2021-01-02T03:04:05.000Z",
    // The half deliberately not projected: asset locations and store inventory.
    unityPackages: [{ assetUrl: "https://api.vrchat.cloud/api/1/file/file_pkg/1/file" }],
    assetUrl: "https://api.vrchat.cloud/api/1/file/file_pkg/1/file",
    ...overrides,
  };
}

interface Harness {
  readonly deps: ReturnType<typeof createControlDeps>;
  readonly store: Store;
  readonly accounts: Map<string, Account>;
  /** Every path the stub was asked for, so a cache hit is provably a *missing* request. */
  readonly requests: string[];
  readonly stop: () => void;
}

function harness(
  options: {
    userStatus?: number;
    /** What `GET /instances/…` answers with. A function, so a test can vary it per call. */
    instance?: (call: number) => Response;
    /** User ids the presence service reports as this account's friends. */
    friends?: string[];
    /** A stand-in plugin host, for the graph save path's type check. */
    plugins?: PluginHost;
    /**
     * Full presence records, for the tests that care about *where* a friend is rather than only
     * that they are one. Answers both `list` and `listAll`, since the derivation reads whichever
     * the caller's `accountId` selects.
     */
    located?: readonly Partial<FriendPresenceRecord>[];
    /** What `GET /users/{id}/groups/represented` answers with. Defaults to `{}` — nobody. */
    represented?: () => Response;
    /**
     * What `GET /profile/{id}` answers with. The default mirrors `represented`: a profile whose
     * `representedGroup` is set exactly when the test gave the group endpoint something to say,
     * because the daemon uses the former as the predicate for calling the latter.
     */
    publicProfile?: () => Response;
    /** What `GET /users/{id}/groups` answers with. Defaults to an empty list. */
    groups?: () => Response;
    /** What `GET /groups/{id}` answers with — the group modal's own route. */
    group?: () => Response;
    /**
     * What the four group sub-resources answer with, given the paging they were asked for.
     *
     * One option rather than four, because what these tests are about is the contract all four
     * share — the paging arithmetic and the 403/404 mapping — and a test that wants to vary one
     * branches on the path it is handed.
     */
    groupSub?: (path: string, n: number, offset: number) => Response;
    /** What `GET /users/{id}/mutuals/friends` answers with, given the paging it was asked for. */
    mutuals?: (n: number, offset: number) => Response;
    /** What `GET /worlds/{id}` answers with. */
    world?: (worldId: string, call: number) => Response;
    /** What `GET /avatars/{id}` answers with. */
    avatar?: (avatarId: string, call: number) => Response | Promise<Response>;
    /** The avtr.zip lookup, stubbed. Absent means the lazy default, which makes no requests here. */
    avatarIds?: AvatarIdResolver;
    /** Settings the deps read live — `resolveAvatarIds` is the one these tests flip. */
    settings?: Settings;
  } = {},
): Harness {
  const bus = new EventBus();
  const limiter = new RateLimiter();
  const store = Store.open(MEMORY);
  const requests: string[] = [];
  const accounts = new Map<string, Account>();

  let instanceCalls = 0;
  let worldCalls = 0;
  let avatarCalls = 0;

  const fetchStub = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname;
    requests.push(path);

    if (path.includes("/worlds/")) {
      worldCalls += 1;
      const worldId = path.slice(path.lastIndexOf("/") + 1);
      return options.world?.(worldId, worldCalls) ?? Response.json(worldBody(worldId));
    }

    if (path.includes("/avatars/")) {
      avatarCalls += 1;
      const avatarId = path.slice(path.lastIndexOf("/") + 1);
      return options.avatar?.(avatarId, avatarCalls) ?? Response.json(avatarBody(avatarId));
    }

    if (path.includes("/instances/")) {
      instanceCalls += 1;
      // A tick of real latency, so two concurrent callers genuinely overlap rather than being
      // serialised by an instantly-resolved promise — which is what the de-duplication is for.
      await Bun.sleep(5);
      return options.instance?.(instanceCalls) ?? Response.json({ users: [] });
    }

    // Which account is asking is decided by its own cookie jar — the same thing that decides it
    // against the real API. Each Account below carries a cookie naming itself.
    const cookie = new Headers(init?.headers).get("Cookie") ?? "";
    const asker = cookie.includes(OTHER) ? OTHER : VIEWER;

    if (path.endsWith("/auth")) return Response.json({ ok: true });
    if (path.endsWith("/auth/user")) {
      // `#adoptUser` takes the id from this body, so it must be the asker's own.
      return Response.json({ id: asker, displayName: asker, currentAvatarImageUrl: "" });
    }
    // `GET /groups/{id}` is not under `/users/` at all, and it is matched on the id rather than
    // on the segment so that it cannot be confused with `/users/{id}/groups` below.
    if (path.includes("/groups/grp_")) {
      // Ordered first: every sub-resource path also contains `/groups/grp_`, so the group body
      // would otherwise be served for the member list, the board, and the galleries alike.
      const sub = /\/groups\/grp_[^/]+\/(members|posts|instances|galleries)/.exec(path);
      if (sub !== null) {
        const query = new URL(input).searchParams;
        return (
          options.groupSub?.(path, Number(query.get("n")), Number(query.get("offset"))) ??
          Response.json([])
        );
      }
      return options.group?.() ?? Response.json({});
    }
    // Ordered before the profile branch below: these are all `/users/…` paths too, and a
    // `includes("/users/")` test would otherwise answer a user body for every one of them.
    // Its own top-level path, not a `/users/` sub-resource — which is the whole reason it can be
    // matched before the branches below without disturbing them.
    if (path.includes("/profile/")) {
      return (
        options.publicProfile?.() ??
        Response.json(
          profileBody(
            options.represented === undefined ? {} : { representedGroup: { id: GROUP_ID } },
          ),
        )
      );
    }
    if (path.endsWith("/groups/represented")) {
      // `{}` — VRChat's answer for someone representing nothing — unless a test says otherwise.
      return options.represented?.() ?? Response.json({});
    }
    if (path.endsWith("/groups")) {
      return options.groups?.() ?? Response.json([]);
    }
    if (path.endsWith("/mutuals/friends")) {
      const query = new URL(input).searchParams;
      return (
        options.mutuals?.(Number(query.get("n")), Number(query.get("offset"))) ?? Response.json([])
      );
    }

    if (path.includes("/users/")) {
      if (options.userStatus !== undefined && options.userStatus !== 200) {
        return new Response(`{"error":{"message":"nope"}}`, { status: options.userStatus });
      }
      // The viewer is friends with the subject; the other account is a stranger to them.
      return Response.json(userBody(asker === VIEWER));
    }
    return new Response("unexpected", { status: 500 });
  };

  for (const id of [VIEWER, OTHER]) {
    accounts.set(
      id,
      new Account(
        id,
        { username: id, cookies: [{ name: "auth", value: `cookie-${id}`, expiresAt: null }] },
        { limiter, userAgent: "vrc.zip/test contact", bus, fetch: fetchStub },
      ),
    );
    store.upsertAccount({ id, display_name: id, added_at: T0, enabled: 1, last_seen_at: null });
  }

  const manager = {
    list: () => [...accounts.values()].map((a) => a.snapshot()),
    get: (id: string) => accounts.get(id),
  } as unknown as AccountManager;

  const deps = createControlDeps({
    accounts: manager,
    store,
    bus,
    limiter,
    secrets: { degraded: false, backend: "test" } as unknown as SecretsStore,
    presence: {
      // The friend list this account is already holding in memory. `isFriend` is a set membership
      // test against it and `trustLevel` is a lookup in it, which is why neither costs a request.
      list: () =>
        options.located ??
        (options.friends ?? []).map((id) => ({
          id,
          displayName: id.toUpperCase(),
          trustLevel: "trusted",
          status: "join me",
        })),
      listAll: () => options.located ?? [],
      // A live profile read writes back into presence; here there is nothing to write into, so it
      // reports no news and no event is emitted. The behaviour itself is tested in presence.test.ts,
      // against a real map — this double exists to answer `list`, not to reimplement the service.
      observe: () => false,
    } as unknown as PresenceService,
    settings: options.settings ?? DEFAULT_SETTINGS,
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    ...(options.avatarIds === undefined ? {} : { avatarIds: options.avatarIds }),
    connectPipeline: () => {},
    onSettingsSaved: async () => {},
  });

  return {
    deps,
    store,
    accounts,
    requests,
    stop: () => {
      store.close();
    },
  };
}

/** Signs both accounts in through the real resume path, which is what makes them `online`. */
async function resumeAll(h: Harness): Promise<void> {
  for (const account of h.accounts.values()) {
    expect(await account.resume()).toBe(true);
  }
  // Every request so far is setup noise; the assertions below count profile fetches.
  h.requests.length = 0;
}

/**
 * How many times the *profile* itself was fetched.
 *
 * Matched on the exact path, not `includes("/users/")`: the profile's sub-resources — the
 * represented group, the group list, the mutuals — live under the same prefix, and counting them
 * as profile fetches would make a cache hit look like a miss.
 */
function profileFetches(h: Harness): number {
  return h.requests.filter((path) => path.endsWith(`/users/${SUBJECT}`)).length;
}

describe("control deps: users", () => {
  test("merges VRChat's record with the local friend log and note", async () => {
    const h = harness();
    await resumeAll(h);
    h.store.upsertFriend({
      account_id: VIEWER,
      user_id: SUBJECT,
      display_name: "Subject",
      trust_level: "known",
      friended_at: T0 - 1000,
      unfriended_at: null,
    });
    h.store.putNote(VIEWER, SUBJECT, "met at a movie world", T0);

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    expect(detail).toMatchObject({
      id: SUBJECT,
      displayName: "Subject",
      accountId: VIEWER,
      cached: false,
      bio: "only friends see this",
      bioLinks: ["https://example.invalid"],
      pronouns: null,
      statusDescription: "in a world",
      trustLevel: "known",
      ageVerificationStatus: "18+",
      ageVerified: true,
      location: "wrld_x:12345",
      worldId: "wrld_x",
      isFriend: true,
      friendedAt: T0 - 1000,
      note: "met at a movie world",
      noteUpdatedAt: T0,
    });
    // Integer unix ms on the wire, never VRChat's date strings.
    expect(detail.dateJoined).toBe(Date.parse("2018-03-04"));
    expect(detail.lastLogin).toBe(Date.parse("2026-08-20T10:00:00.000Z"));
    // `userIcon` is `""`, so the fall-through has to reach the avatar thumbnail.
    expect(detail.iconUrl).toBe("https://api.vrchat.cloud/api/1/image/file_a/1/256");
    // …and the full-size field skips that thumbnail entirely rather than repeating it, which is
    // the whole reason "open image in a new tab" cannot just use `iconUrl`.
    expect(detail.iconUrlFull).toBe("https://api.vrchat.cloud/api/1/image/file_a/1/1024");
    h.stop();
  });

  test("VRChat's empty strings become null, not empty fields", async () => {
    const h = harness();
    await resumeAll(h);

    const detail = await h.deps.getUser(SUBJECT, OTHER);

    expect(detail.bio).toBeNull();
    expect(detail.statusDescription).toBeNull();
    expect(detail.location).toBeNull();
    expect(detail.worldId).toBeNull();
    expect(detail.platform).toBeNull();
    // `Date.parse("")` is NaN, but `Date.parse("-5")` is a *year* — the shape guard is why this
    // is null rather than a confident wrong timestamp.
    expect(detail.lastLogin).toBeNull();
    expect(detail.isFriend).toBe(false);
    // Trust still comes from tags, via `trustLevelOf` — never re-derived here.
    expect(detail.trustLevel).toBe("known");
    // `hidden` survives as itself rather than collapsing into "no badge", which would read as a
    // claim that this person is not age verified.
    expect(detail.ageVerificationStatus).toBe("hidden");
    expect(detail.ageVerified).toBe(true);
    h.stop();
  });

  test("the cache is per account, so one account's view never answers for another", async () => {
    const h = harness();
    await resumeAll(h);

    const friendView = await h.deps.getUser(SUBJECT, VIEWER);
    const afterFirst = profileFetches(h);
    const cached = await h.deps.getUser(SUBJECT, VIEWER);

    expect(cached.cached).toBe(true);
    expect(profileFetches(h)).toBe(afterFirst); // served from `user_cache`, not refetched
    expect(cached.bio).toBe(friendView.bio);

    // The other account has never looked, and must not inherit the friend view.
    expect(h.store.getUserCache(OTHER, SUBJECT)).toBeNull();
    const strangerView = await h.deps.getUser(SUBJECT, OTHER);
    expect(profileFetches(h)).toBe(afterFirst + 1);
    expect(strangerView.bio).toBeNull();
    expect(strangerView.isFriend).toBe(false);

    // …and fetching as the stranger did not overwrite the viewer's row.
    expect((await h.deps.getUser(SUBJECT, VIEWER)).bio).toBe("only friends see this");
    h.stop();
  });

  test("a stale cache row is refetched", async () => {
    const h = harness();
    await resumeAll(h);

    await h.deps.getUser(SUBJECT, VIEWER);
    const afterFirst = profileFetches(h);
    // Older than any TTL this could reasonably carry.
    h.store.putUserCache(VIEWER, SUBJECT, Date.now() - 86_400_000, JSON.stringify(userBody(true)));

    const refreshed = await h.deps.getUser(SUBJECT, VIEWER);

    expect(refreshed.cached).toBe(false);
    expect(profileFetches(h)).toBe(afterFirst + 1);
    h.stop();
  });

  test("an unknown account is a 404, and VRChat's 404 passes through as one", async () => {
    const unknown = harness();
    await resumeAll(unknown);
    await expect(unknown.deps.getUser(SUBJECT, "usr_nobody")).rejects.toMatchObject({
      status: 404,
      code: "unknown_account",
    });
    unknown.stop();

    const missing = harness({ userStatus: 404 });
    await resumeAll(missing);
    await expect(missing.deps.getUser(SUBJECT, VIEWER)).rejects.toMatchObject({
      status: 404,
      code: "unknown_user",
    });
    missing.stop();
  });

  test("a live fetch with nobody signed in is a 503", async () => {
    // No `resumeAll`, so both accounts are still `new` and there is no cookie-backed session.
    const h = harness();
    await expect(h.deps.getUser(SUBJECT, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    h.stop();
  });

  test("notes round-trip per account, need no network, and an empty note clears the row", async () => {
    const h = harness();

    const written = await h.deps.setUserNote(SUBJECT, VIEWER, "remember this");
    expect(written).toMatchObject({ accountId: VIEWER, userId: SUBJECT, note: "remember this" });
    expect(h.store.getNote(VIEWER, SUBJECT)?.note).toBe("remember this");
    // A note is one account's opinion, not a global fact about the user.
    expect(h.store.getNote(OTHER, SUBJECT)).toBeNull();
    // Written with both accounts offline: a local note is not VRChat's to authorise.
    expect(profileFetches(h)).toBe(0);

    const cleared = await h.deps.setUserNote(SUBJECT, VIEWER, "");
    expect(cleared).toEqual({ accountId: VIEWER, userId: SUBJECT, note: null, updatedAt: null });
    expect(h.store.getNote(VIEWER, SUBJECT)).toBeNull();
    h.stop();
  });
});

describe("control deps: groups and mutual friends", () => {
  function groupBody(overrides: Record<string, unknown> = {}) {
    return {
      groupId: GROUP_ID,
      name: "A Group",
      shortCode: "ABCD",
      discriminator: "1234",
      iconUrl: "https://api.vrchat.cloud/api/1/image/group_icon/1/256",
      bannerUrl: "",
      memberCount: 42,
      privacy: "default",
      ownerId: "usr_owner",
      description: "",
      isRepresenting: true,
      ...overrides,
    };
  }

  test("the banner and the represented group ride along on the profile", async () => {
    const h = harness({ represented: () => Response.json(groupBody()) });
    await resumeAll(h);

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    expect(detail.bannerUrl).toBe("https://api.vrchat.cloud/api/1/file/file_banner/1/1024");
    expect(detail.bannerType).toBe("gallery");
    expect(detail.representedGroup).toEqual({
      id: GROUP_ID,
      name: "A Group",
      shortCode: "ABCD",
      discriminator: "1234",
      iconUrl: "https://api.vrchat.cloud/api/1/image/group_icon/1/256",
      // `""` is unset, as everywhere else on this API.
      bannerUrl: null,
      memberCount: 42,
      privacy: "default",
      ownerId: "usr_owner",
      description: null,
      // `/groups/represented` does not carry the flag, so it is false rather than unknown.
      mutualGroup: false,
      isRepresenting: true,
    });
    h.stop();
  });

  /*
   * The common case, and the one most likely to be mistaken for a fault: VRChat answers `200 {}`
   * for a user representing nothing.
   */
  test("representing no group is null, not an error", async () => {
    const h = harness();
    await resumeAll(h);
    expect((await h.deps.getUser(SUBJECT, VIEWER)).representedGroup).toBeNull();

    // Nor does a failure of that one call cost the whole profile — a missing badge beats a missing
    // person.
    const broken = harness({ represented: () => new Response("boom", { status: 500 }) });
    await resumeAll(broken);
    const detail = await broken.deps.getUser(SUBJECT, VIEWER);
    expect(detail.representedGroup).toBeNull();
    expect(detail.displayName).toBe("Subject");
    broken.stop();
    h.stop();
  });

  test("the group rides in the same cache row and TTL as the profile", async () => {
    const h = harness({ represented: () => Response.json(groupBody()) });
    await resumeAll(h);

    await h.deps.getUser(SUBJECT, VIEWER);
    const groupCalls = h.requests.filter((p) => p.endsWith("/groups/represented")).length;

    const cached = await h.deps.getUser(SUBJECT, VIEWER);

    expect(cached.cached).toBe(true);
    expect(cached.representedGroup?.id).toBe(GROUP_ID);
    // One row, one TTL: the second open costs neither call.
    expect(profileFetches(h)).toBe(1);
    expect(h.requests.filter((p) => p.endsWith("/groups/represented")).length).toBe(groupCalls);
    h.stop();
  });

  /*
   * A row written before the cache learned to carry the group. It must still be *readable* — a
   * daemon upgrade that made every cached profile unopenable would be a worse bug than a stale one.
   */
  /*
   * `/profile/{id}` is the supplement, not the successor. Everything presence-shaped on the modal
   * still comes from `/users/{id}`, which is the whole reason both calls are made.
   */
  test("the profile card rides along, and never stands in for the user record", async () => {
    const h = harness();
    await resumeAll(h);

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    expect(detail.profileCard).toEqual({
      languages: ["eng", "jpn"], // the `""` is VRChat's padding, not a language
      badges: [
        // Showcased first, whatever order VRChat listed them in, and the id-less entry dropped.
        {
          id: "bdg_first",
          name: "First",
          description: "showcased",
          imageUrl: "https://assets.vrchat.com/badges/first.png",
          showcased: true,
        },
        {
          id: "bdg_second",
          name: "Second",
          description: "not showcased",
          imageUrl: "https://assets.vrchat.com/badges/second.png",
          showcased: false,
        },
      ],
      hasVrcPlus: true,
      bannerColor: "#112233",
    });

    // The profile page carries no presence at all; these came from `/users/{id}` and must keep
    // coming from there. A migration onto `/profile/{id}` would blank every one of them.
    expect(detail.location).toBe("wrld_x:12345");
    expect(detail.state).toBe("online");
    expect(detail.lastLogin).not.toBeNull();
    expect(h.requests.filter((path) => path.endsWith(`/users/${SUBJECT}`)).length).toBe(1);
    h.stop();
  });

  /*
   * The saving that pays for the extra call: `PublicProfile.representedGroup` settles the yes/no,
   * and for most people the answer is no.
   */
  test("no represented group on the profile means the group call is never made", async () => {
    const h = harness();
    await resumeAll(h);

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    expect(detail.representedGroup).toBeNull();
    expect(h.requests.filter((path) => path.endsWith("/groups/represented")).length).toBe(0);

    // And when it says there *is* one, the rich shape is still fetched — the thin `{id, name}` on
    // the profile is a predicate, never the value the modal draws.
    const representing = harness({ represented: () => Response.json(groupBody()) });
    await resumeAll(representing);
    const badge = await representing.deps.getUser(SUBJECT, VIEWER);
    expect(badge.representedGroup?.memberCount).toBe(42);
    expect(badge.representedGroup?.shortCode).toBe("ABCD");
    representing.stop();
    h.stop();
  });

  /*
   * Best-effort means best-effort in both directions: a dead supplement costs its own fields and
   * nothing else, and it must not silently take the represented group down with it.
   */
  test("a failed profile call costs the card, not the person or the group", async () => {
    const h = harness({
      publicProfile: () => new Response("boom", { status: 500 }),
      represented: () => Response.json(groupBody()),
    });
    await resumeAll(h);

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    // Null, not an empty card: "we got no answer" is a different claim from "no badges".
    expect(detail.profileCard).toBeNull();
    expect(detail.displayName).toBe("Subject");
    // The predicate is gone, so the group is asked for directly — exactly as before this existed.
    expect(detail.representedGroup?.id).toBe(GROUP_ID);
    h.stop();

    // A 404 is the same answer. VRChat has profile-less users and it is not a fault.
    const missing = harness({ publicProfile: () => new Response("{}", { status: 404 }) });
    await resumeAll(missing);
    expect((await missing.deps.getUser(SUBJECT, VIEWER)).profileCard).toBeNull();
    missing.stop();
  });

  test("the profile card rides in the same cache row and TTL as the user", async () => {
    const h = harness();
    await resumeAll(h);

    await h.deps.getUser(SUBJECT, VIEWER);
    const cached = await h.deps.getUser(SUBJECT, VIEWER);

    expect(cached.cached).toBe(true);
    expect(cached.profileCard?.hasVrcPlus).toBe(true);
    expect(h.requests.filter((path) => path.includes("/profile/")).length).toBe(1);
    h.stop();
  });

  /*
   * A row written before the cache learned to carry the card. Readable, and honest about what it
   * does not know — `null` says "unknown", which is what the UI needs to hear.
   */
  test("a v2 cache row still reads, just without the profile card", async () => {
    const h = harness();
    await resumeAll(h);
    h.store.putUserCache(
      VIEWER,
      SUBJECT,
      Date.now(),
      JSON.stringify({ v: 2, user: userBody(true), representedGroup: null }),
    );

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    expect(detail.cached).toBe(true);
    expect(detail.displayName).toBe("Subject");
    expect(detail.profileCard).toBeNull();
    expect(profileFetches(h)).toBe(0);
    h.stop();
  });

  test("a pre-envelope cache row still reads, just without the group", async () => {
    const h = harness();
    await resumeAll(h);
    h.store.putUserCache(VIEWER, SUBJECT, Date.now(), JSON.stringify(userBody(true)));

    const detail = await h.deps.getUser(SUBJECT, VIEWER);

    expect(detail.cached).toBe(true);
    expect(detail.displayName).toBe("Subject");
    expect(detail.representedGroup).toBeNull();
    expect(profileFetches(h)).toBe(0);
    h.stop();
  });

  test("the group list is normalised, and an unidentifiable entry is dropped", async () => {
    const h = harness({
      groups: () =>
        Response.json([
          groupBody({ isRepresenting: true }),
          groupBody({ groupId: "grp_other", name: "", shortCode: "WXYZ", isRepresenting: false }),
          // Every field of `LimitedUserGroups` is optional upstream, so this is legal — and
          // unrenderable, because the UI has nothing to key a row on.
          { name: "A group with no id" },
        ]),
    });
    await resumeAll(h);

    const { groups } = await h.deps.listUserGroups(SUBJECT, VIEWER);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.isRepresenting).toBe(true);
    // The name falls back to the short code rather than rendering as an empty label.
    expect(groups[1]).toMatchObject({ id: "grp_other", name: "WXYZ", isRepresenting: false });
    h.stop();
  });

  test("mutualGroup is passed through, and absent means false", async () => {
    const h = harness({
      groups: () =>
        Response.json([
          groupBody({ mutualGroup: true }),
          groupBody({ groupId: "grp_other", mutualGroup: false }),
          // Optional upstream, like every other field on `LimitedUserGroups`.
          groupBody({ groupId: "grp_silent" }),
        ]),
    });
    await resumeAll(h);

    const { groups } = await h.deps.listUserGroups(SUBJECT, VIEWER);

    expect(groups.map((group) => group.mutualGroup)).toEqual([true, false, false]);
    h.stop();
  });

  test("an empty group list is a normal answer", async () => {
    // VRChat filters by what the viewer may see; nothing visible is not the same as no groups.
    const h = harness({ groups: () => Response.json([]) });
    await resumeAll(h);
    expect(await h.deps.listUserGroups(SUBJECT, VIEWER)).toEqual({ groups: [] });
    h.stop();
  });

  test("mutual friends page, and hasMore follows the page being full", async () => {
    const pages: { n: number; offset: number }[] = [];
    const h = harness({
      friends: ["usr_m0", "usr_m1"],
      mutuals: (n, offset) => {
        pages.push({ n, offset });
        // Three mutuals in total, asked for two at a time.
        const all = ["usr_m0", "usr_m1", "usr_m2"];
        return Response.json(
          all.slice(offset, offset + n).map((id) => ({
            id,
            displayName: id.toUpperCase(),
            status: "active",
            statusDescription: "",
            currentAvatarThumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/${id}/1/256`,
            currentAvatarImageUrl: `https://api.vrchat.cloud/api/1/image/${id}/1/1024`,
            imageUrl: "",
          })),
        );
      },
    });
    await resumeAll(h);

    const first = await h.deps.listMutualFriends(SUBJECT, VIEWER, { n: 2, offset: 0 });
    expect(first.users.map((u) => u.id)).toEqual(["usr_m0", "usr_m1"]);
    // A full page is the only evidence another may exist — VRChat sends no total.
    expect(first.hasMore).toBe(true);

    const second = await h.deps.listMutualFriends(SUBJECT, VIEWER, { n: 2, offset: 2 });
    expect(second.users.map((u) => u.id)).toEqual(["usr_m2"]);
    expect(second.hasMore).toBe(false);

    // Paging is asked for, not sliced locally: the whole list is never pulled down.
    expect(pages).toEqual([
      { n: 2, offset: 0 },
      { n: 2, offset: 2 },
    ]);
    h.stop();
  });

  /*
   * `MutualFriend` carries no `tags`, so `trustLevelOf` on the response would rank every row
   * "visitor" — a confident wrong answer. The rank comes from local state instead, and costs
   * nothing: a mutual friend is by definition one of this account's own friends.
   */
  test("mutual friends take their trust rank from local state, not from the payload", async () => {
    const h = harness({
      // `usr_known` is in the live presence map; the other two are not.
      friends: ["usr_known"],
      mutuals: () =>
        Response.json([
          { id: "usr_known", displayName: "Known", status: "active", currentAvatarImageUrl: "" },
          { id: "usr_seen", displayName: "Seen", status: "offline", currentAvatarImageUrl: "" },
          { id: "usr_new", displayName: "New", status: "active", currentAvatarImageUrl: "" },
        ]),
    });
    await resumeAll(h);

    h.store.upsertFriend({
      account_id: VIEWER,
      user_id: "usr_seen",
      display_name: "Seen",
      // `friend_log` is the fallback, and it is what covers the window before the first friends
      // poll of a cold start has landed.
      trust_level: "veteran",
      friended_at: T0,
      unfriended_at: null,
    });

    const { users } = await h.deps.listMutualFriends(SUBJECT, VIEWER, { n: 10, offset: 0 });

    expect(users.map((u) => [u.id, u.trustLevel])).toEqual([
      ["usr_known", "trusted"],
      ["usr_seen", "veteran"],
      ["usr_new", "visitor"],
    ]);
    // Not one profile was fetched to work that out.
    expect(profileFetches(h)).toBe(0);
    h.stop();
  });

  test("a mutual friend with no status in the payload takes presence's, not offline", async () => {
    const h = harness({
      // `usr_known` is in the live presence map; `usr_new` is not.
      friends: ["usr_known"],
      mutuals: () =>
        Response.json([
          // VRChat specifies a `status` on `MutualFriend` and then sends `""` — the same way it
          // specifies `tags` and sends none. Defaulting that to "offline" rendered the whole tab
          // as offline, always, next to a card reading the real status off `GET /users/{id}`.
          { id: "usr_known", displayName: "Known", status: "", currentAvatarImageUrl: "" },
          { id: "usr_new", displayName: "New", status: "", currentAvatarImageUrl: "" },
          { id: "usr_said", displayName: "Said", status: "busy", currentAvatarImageUrl: "" },
        ]),
    });
    await resumeAll(h);

    const { users } = await h.deps.listMutualFriends(SUBJECT, VIEWER, { n: 10, offset: 0 });

    expect(users.map((u) => [u.id, u.status])).toEqual([
      // From presence, which the socket keeps current.
      ["usr_known", "join me"],
      // Nobody knows anything about this one, so "offline" is still the honest floor.
      ["usr_new", "offline"],
      // When VRChat does answer, its answer wins — it is from this instant.
      ["usr_said", "busy"],
    ]);
    expect(profileFetches(h)).toBe(0);
    h.stop();
  });

  test("one group is normalised, and its live fields survive the trip", async () => {
    const h = harness({
      group: () =>
        Response.json({
          // `Group` names the group's own id `id`, where `LimitedUserGroups` calls it `groupId`
          // and uses `id` for the membership row. Getting that backwards is what this asserts.
          id: GROUP_ID,
          name: "A Group",
          shortCode: "ABCD",
          discriminator: "1234",
          memberCount: 42,
          onlineMemberCount: 7,
          memberCountSyncedAt: "2023-11-14T22:13:20.000Z",
          createdAt: "2021-09-13T00:00:00.000Z",
          rules: "Be kind.",
          links: ["https://example.invalid", ""],
          languages: ["eng"],
          tags: ["system_verified"],
          isVerified: true,
          joinState: "open",
          membershipStatus: "member",
          privacy: "default",
          ownerId: "usr_owner",
          // Never taken at face value: fetching a group is not evidence anybody represents it.
          isRepresenting: true,
        }),
    });
    await resumeAll(h);

    const group = await h.deps.getGroup(GROUP_ID, VIEWER);

    expect(group).toMatchObject({
      id: GROUP_ID,
      name: "A Group",
      memberCount: 42,
      onlineMemberCount: 7,
      isVerified: true,
      joinState: "open",
      membershipStatus: "member",
      isRepresenting: false,
    });
    // Integer unix ms, never the ISO string VRChat sent.
    expect(group.createdAt).toBe(Date.parse("2021-09-13T00:00:00.000Z"));
    expect(group.memberCountSyncedAt).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
    // The empty link is dropped rather than rendered as a link to nowhere.
    expect(group.links).toEqual(["https://example.invalid"]);
    h.stop();
  });

  test("a group with no id is a 502, not a card with nothing to key on", async () => {
    // Every field of VRChat's `Group` is optional, so this is a legal response and an unrenderable
    // one — there is no link, no copy button, and nothing to identify it by.
    const h = harness({ group: () => Response.json({ name: "A group with no id" }) });
    await resumeAll(h);
    await expect(h.deps.getGroup(GROUP_ID, VIEWER)).rejects.toMatchObject({
      status: 502,
      code: "group_fetch_failed",
    });
    h.stop();
  });

  test("a 404 on a group is unknown_group, not unknown_user", async () => {
    // The distinction is load-bearing: the modal branches on the code, and "VRChat does not know
    // that user" in front of a group is the wrong sentence for a group that is merely private.
    const h = harness({ group: () => new Response("{}", { status: 404 }) });
    await resumeAll(h);
    await expect(h.deps.getGroup(GROUP_ID, VIEWER)).rejects.toMatchObject({
      status: 404,
      code: "unknown_group",
    });
    h.stop();

    const offline = harness();
    await expect(offline.deps.getGroup(GROUP_ID, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    offline.stop();
  });

  test("the galleries ride in on the group body rather than costing a request", async () => {
    const h = harness({
      group: () =>
        Response.json({
          id: GROUP_ID,
          name: "A Group",
          galleries: [
            { id: "ggal_1", name: "Events", description: "Meetups.", membersOnly: true },
            // The name falls back to the id rather than rendering as an empty tab.
            { id: "ggal_2", name: "" },
            // Every field of `GroupGallery` is optional upstream, so this is legal — and there is
            // nothing to fetch its images with, so it is dropped rather than shown as a dead tab.
            { name: "A gallery with no id" },
          ],
        }),
    });
    await resumeAll(h);

    const group = await h.deps.getGroup(GROUP_ID, VIEWER);

    expect(group.galleries).toEqual([
      { id: "ggal_1", name: "Events", description: "Meetups.", membersOnly: true },
      { id: "ggal_2", name: "ggal_2", description: null, membersOnly: false },
    ]);
    // Not one request beyond the group itself: `Group.galleries` is part of the body.
    expect(h.requests.filter((path) => path.includes("/galleries"))).toEqual([]);
    h.stop();
  });

  test("a group with no galleries at all is an empty array, not a missing field", async () => {
    const h = harness({ group: () => Response.json({ id: GROUP_ID, name: "A Group" }) });
    await resumeAll(h);
    expect((await h.deps.getGroup(GROUP_ID, VIEWER)).galleries).toEqual([]);
    h.stop();
  });

  test("the member list is normalised, paged, and keeps both ids", async () => {
    const pages: { n: number; offset: number }[] = [];
    const h = harness({
      groupSub: (_path, n, offset) => {
        pages.push({ n, offset });
        // Three members in total, asked for two at a time.
        const all = ["usr_m0", "usr_m1", "usr_m2"];
        return Response.json(
          all.slice(offset, offset + n).map((userId, index) => ({
            // The membership row's id, which is *not* the user's — mixing the two up is the easy
            // mistake here, because VRChat gives the membership row the shorter name.
            id: `gmem_${userId}`,
            groupId: GROUP_ID,
            userId,
            joinedAt: "2022-03-04T05:06:07.000Z",
            roleIds: ["grol_member", ""],
            isRepresenting: index === 0,
            user: {
              id: userId,
              displayName: userId.toUpperCase(),
              iconUrl: `https://api.vrchat.cloud/api/1/image/${userId}/1/256`,
              currentAvatarThumbnailImageUrl: "",
            },
          })),
        );
      },
    });
    await resumeAll(h);

    const first = await h.deps.listGroupMembers(GROUP_ID, VIEWER, { n: 2, offset: 0 });

    expect(first.members[0]).toEqual({
      id: "gmem_usr_m0",
      userId: "usr_m0",
      displayName: "USR_M0",
      iconUrl: "https://api.vrchat.cloud/api/1/image/usr_m0/1/256",
      // Integer unix ms, never the ISO string VRChat sent.
      joinedAt: Date.parse("2022-03-04T05:06:07.000Z"),
      // The empty role id is dropped rather than carried as a role nobody holds.
      roleIds: ["grol_member"],
      isRepresenting: true,
    });
    // A full page is the only evidence another exists — VRChat sends no total on this endpoint.
    expect(first.hasMore).toBe(true);

    const second = await h.deps.listGroupMembers(GROUP_ID, VIEWER, { n: 2, offset: 2 });
    expect(second.members.map((m) => m.userId)).toEqual(["usr_m2"]);
    expect(second.hasMore).toBe(false);

    // Paging is asked for, not sliced locally: the whole list is never pulled down.
    expect(pages).toEqual([
      { n: 2, offset: 0 },
      { n: 2, offset: 2 },
    ]);
    h.stop();
  });

  /*
   * `GroupMember` is `| null` in the spec — for "a user who is not part of the group" — so a null
   * inside the array is legal, and a mapper that assumed an object would lose the whole page to one
   * row. `hasMore` still reads off the raw array: a dropped entry shortens the mapped list without
   * meaning the page was short, and reading it off the mapped one would end the scroll early.
   */
  test("a null member entry costs that row, not the page or the hasMore", async () => {
    const h = harness({
      groupSub: () =>
        Response.json([
          null,
          { id: "gmem_1", groupId: GROUP_ID, userId: "usr_m1", roleIds: [], isRepresenting: false },
          // No userId: there is nobody to open a modal on, so it is unrenderable.
          { id: "gmem_2", groupId: GROUP_ID, roleIds: [] },
        ]),
    });
    await resumeAll(h);

    const { members, hasMore } = await h.deps.listGroupMembers(GROUP_ID, VIEWER, {
      n: 3,
      offset: 0,
    });

    expect(members.map((m) => m.userId)).toEqual(["usr_m1"]);
    // The name falls back to the user id: a row with an empty label is worse than the id.
    expect(members[0]?.displayName).toBe("usr_m1");
    expect(members[0]?.iconUrl).toBe(null);
    expect(hasMore).toBe(true);
    h.stop();
  });

  /*
   * The one sub-resource that answers with an object rather than an array. The other three return
   * a bare array, so getting this one wrong would quietly serve an empty board forever.
   */
  test("the board comes back wrapped in an object, and hasMore follows the page", async () => {
    const h = harness({
      groupSub: (_path, n, offset) =>
        Response.json({
          posts: ["not_p0", "not_p1", "not_p2"].slice(offset, offset + n).map((id) => ({
            id,
            title: "Meetup",
            text: "Doors at eight.",
            authorId: "usr_known",
            createdAt: "2023-05-06T07:08:09.000Z",
            imageUrl: "",
          })),
        }),
      // `usr_known` is in this account's presence map; the post author usually is not.
      friends: ["usr_known"],
    });
    await resumeAll(h);

    const first = await h.deps.listGroupPosts(GROUP_ID, VIEWER, { n: 2, offset: 0 });

    expect(first.posts[0]).toEqual({
      id: "not_p0",
      title: "Meetup",
      text: "Doors at eight.",
      authorId: "usr_known",
      // `GroupPost` carries no name, so this came from local state and cost no request.
      authorDisplayName: "USR_KNOWN",
      createdAt: Date.parse("2023-05-06T07:08:09.000Z"),
      // `""` is how VRChat spells "no image"; `??` would have let it through as a blank `src`.
      imageUrl: null,
    });
    expect(first.hasMore).toBe(true);
    expect(h.requests.filter((path) => path.endsWith("/users/usr_known"))).toEqual([]);

    const second = await h.deps.listGroupPosts(GROUP_ID, VIEWER, { n: 2, offset: 2 });
    expect(second.posts.map((p) => p.id)).toEqual(["not_p2"]);
    expect(second.hasMore).toBe(false);
    h.stop();
  });

  test("a post author falls back to friend_log, then to no name at all", async () => {
    const h = harness({
      groupSub: () =>
        Response.json({
          posts: [
            { id: "not_p0", authorId: "usr_stranger" },
            { id: "not_p1", authorId: "usr_seen" },
          ],
        }),
    });
    await resumeAll(h);

    h.store.upsertFriend({
      account_id: VIEWER,
      user_id: "usr_seen",
      display_name: "Seen Before",
      trust_level: "veteran",
      friended_at: T0,
      unfriended_at: null,
    });

    const { posts } = await h.deps.listGroupPosts(GROUP_ID, VIEWER, { n: 10, offset: 0 });

    // Null rather than a fetched name: resolving it would be one `GET /users/{id}` per distinct
    // author on every page of the board, for decoration the UI can render an id fallback for.
    expect(posts[0]).toMatchObject({ authorId: "usr_stranger", authorDisplayName: null });
    // `friend_log` covers the window before the first friends poll of a cold start lands.
    expect(posts[1]).toMatchObject({ authorId: "usr_seen", authorDisplayName: "Seen Before" });
    expect(h.requests.filter((path) => path.includes("usr_stranger"))).toEqual([]);
    h.stop();
  });

  /*
   * Not paged, because VRChat's own endpoint takes no `n` and no `offset`. An `n` invented here
   * would be a local slice wearing the clothes of a request.
   */
  test("group instances are not paged, and the world rides along free", async () => {
    const h = harness({
      groupSub: (path) => {
        expect(path).not.toContain("n=");
        return Response.json([
          {
            instanceId: `12345~group(${GROUP_ID})`,
            location: `wrld_1:12345~group(${GROUP_ID})`,
            memberCount: 9,
            world: {
              id: "wrld_1",
              name: "The Great Pug",
              thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/wrld_1/1/256",
              authorName: "Author",
              capacity: 40,
            },
          },
          // No location: nothing here could be joined or looked up, so it is dropped.
          { instanceId: "67890", memberCount: 2 },
        ]);
      },
    });
    await resumeAll(h);

    const { instances } = await h.deps.listGroupInstances(GROUP_ID, VIEWER);

    expect(instances).toEqual([
      {
        instanceId: `12345~group(${GROUP_ID})`,
        location: `wrld_1:12345~group(${GROUP_ID})`,
        memberCount: 9,
        worldId: "wrld_1",
        worldName: "The Great Pug",
        worldThumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/wrld_1/1/256",
        worldCapacity: 40,
      },
    ]);
    // The world was embedded in this response; fetching it would be paying twice for the bytes.
    expect(h.requests.filter((path) => path.includes("/worlds/"))).toEqual([]);
    h.stop();
  });

  test("gallery images page off the gallery itself, with no /images segment upstream", async () => {
    const paths: string[] = [];
    const h = harness({
      groupSub: (path, n, offset) => {
        paths.push(path);
        return Response.json(
          ["ggim_0", "ggim_1"].slice(offset, offset + n).map((id) => ({
            id,
            imageUrl: `https://api.vrchat.cloud/api/1/file/${id}/1/256`,
            submittedByUserId: "usr_m0",
            createdAt: "2024-01-02T03:04:05.000Z",
          })),
        );
      },
    });
    await resumeAll(h);

    const first = await h.deps.listGroupGalleryImages(GROUP_ID, "ggal_1", VIEWER, {
      n: 2,
      offset: 0,
    });

    expect(first.images[0]).toEqual({
      id: "ggim_0",
      imageUrl: "https://api.vrchat.cloud/api/1/file/ggim_0/1/256",
      submittedByUserId: "usr_m0",
      createdAt: Date.parse("2024-01-02T03:04:05.000Z"),
    });
    expect(first.hasMore).toBe(true);

    const second = await h.deps.listGroupGalleryImages(GROUP_ID, "ggal_1", VIEWER, {
      n: 2,
      offset: 2,
    });
    expect(second.images).toEqual([]);
    expect(second.hasMore).toBe(false);

    // `/images` is vrc.zip's own trailing segment; upstream the images *are* the gallery.
    expect(paths[0]).toBe(`/api/1/groups/${GROUP_ID}/galleries/ggal_1`);
    h.stop();
  });

  /*
   * The reason `group_forbidden` exists at all. Membership is required to read the member list,
   * the board, or a members-only gallery on most groups, and VRChat refuses a non-member with a
   * 403 rather than an empty body. Swallowing that into `[]` would put "this group has no members"
   * on screen in front of a group with four hundred of them.
   */
  test("a 403 on any group sub-resource is group_forbidden, not a 502 and not an empty list", async () => {
    const h = harness({ groupSub: () => new Response("{}", { status: 403 }) });
    await resumeAll(h);

    const forbidden = { status: 403, code: "group_forbidden" };
    await expect(
      h.deps.listGroupMembers(GROUP_ID, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      h.deps.listGroupPosts(GROUP_ID, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject(forbidden);
    await expect(h.deps.listGroupInstances(GROUP_ID, VIEWER)).rejects.toMatchObject(forbidden);
    await expect(
      h.deps.listGroupGalleryImages(GROUP_ID, "ggal_1", VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject(forbidden);
    h.stop();
  });

  /*
   * A 403 on the *profile* routes is still an upstream surprise — an account that is signed in
   * should not be forbidden its own mutual friends — so it keeps falling through to the 502. The
   * mapping is opt-in per path rather than global for exactly that reason.
   */
  test("a 403 outside the group sub-resources is still a 502", async () => {
    const h = harness({ mutuals: () => new Response("{}", { status: 403 }) });
    await resumeAll(h);
    await expect(
      h.deps.listMutualFriends(SUBJECT, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject({ status: 502, code: "mutuals_fetch_failed" });
    h.stop();
  });

  test("a 404 on a group sub-resource is unknown_group, and offline is no_account", async () => {
    const h = harness({ groupSub: () => new Response("{}", { status: 404 }) });
    await resumeAll(h);

    const missing = { status: 404, code: "unknown_group" };
    await expect(
      h.deps.listGroupMembers(GROUP_ID, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject(missing);
    await expect(
      h.deps.listGroupPosts(GROUP_ID, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject(missing);
    await expect(h.deps.listGroupInstances(GROUP_ID, VIEWER)).rejects.toMatchObject(missing);
    await expect(
      h.deps.listGroupGalleryImages(GROUP_ID, "ggal_1", VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject(missing);
    h.stop();

    // Nothing signed in has no cookie to ask with, so it never reaches the 403/404 question.
    const offline = harness();
    await expect(offline.deps.listGroupInstances(GROUP_ID, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    offline.stop();
  });

  /*
   * Asserts on the *paths*, not on counts of them, and that is deliberate.
   *
   * This test failed exactly once in a full run and has never been reproduced since — not in seven
   * consecutive full runs, nor in eighteen targeted ones. Reading the path rules out what usually
   * causes that: every request `getUser` and `listUsers` make is awaited (no fire-and-forget
   * supplement can land late and inflate a count), the fixture, the store and the limiter are all
   * per-harness, `control-deps.ts` holds no module-level state and starts no timer, and
   * `USER_CACHE_TTL_MS` is ten minutes, so the warm cannot expire between the two calls no matter
   * how loaded the machine is.
   *
   * So the mechanism is still unknown, and a count-based assertion is the wrong thing to be holding
   * when it next fires: "expected 2, received 3" does not say *which* request was extra, which is
   * the only fact that would identify the cause. Comparing whole arrays costs nothing and makes the
   * next failure self-describing. See PROGRESS.md decision 103.
   */
  test("the user batch is cache-first, sequential, and leaves the unreadable out", async () => {
    const h = harness();
    await resumeAll(h);

    // Warms `user_cache` for SUBJECT through the modal's own path.
    await h.deps.getUser(SUBJECT, VIEWER);
    const afterWarm = h.requests.filter((path) => path.includes("/users/"));
    const groupsAfterWarm = h.requests.filter((path) => path.endsWith("/groups/represented"));
    const profilesAfterWarm = h.requests.filter((path) => path.includes("/profile/"));

    const batch = await h.deps.listUsers([SUBJECT, "usr_other_one"], VIEWER);

    expect(batch.users.map((user) => user.id)).toEqual([SUBJECT, "usr_other_one"]);
    // The cached one cost nothing; only the second was fetched. One call, not two.
    expect(h.requests.filter((path) => path.endsWith(`/users/${SUBJECT}`))).toEqual([
      `/api/1/users/${SUBJECT}`,
    ]);
    expect(h.requests.filter((path) => path.includes("/users/"))).toEqual([
      ...afterWarm,
      "/api/1/users/usr_other_one",
    ]);
    // And neither supplement is fetched per head: either would multiply the most expensive path in
    // the app for decoration no roster row draws.
    expect(h.requests.filter((path) => path.endsWith("/groups/represented"))).toEqual(
      groupsAfterWarm,
    );
    expect(h.requests.filter((path) => path.includes("/profile/"))).toEqual(profilesAfterWarm);

    // The second call is served entirely from what the first wrote.
    const before = [...h.requests];
    const again = await h.deps.listUsers([SUBJECT, "usr_other_one"], VIEWER);
    expect(again.users).toHaveLength(2);
    expect(h.requests).toEqual(before);
    h.stop();
  });

  test("the user batch never throws — a dead id and no account are both just absences", async () => {
    // One unreadable stranger must not take a room of eighty people's chips down with them.
    const dead = harness({ userStatus: 404 });
    await resumeAll(dead);
    expect(await dead.deps.listUsers([SUBJECT], VIEWER)).toEqual({ users: [] });
    dead.stop();

    // No `resumeAll`, so nothing is signed in. Unlike every other VRChat-backed route this answers
    // 200 with whatever the cache holds — which here is nothing — rather than a 503.
    const offline = harness();
    expect(await offline.deps.listUsers([SUBJECT], VIEWER)).toEqual({ users: [] });
    expect(offline.requests.filter((path) => path.includes("/users/"))).toEqual([]);
    offline.stop();
  });

  test("batched friendship comes from local presence, exactly as the roster's does", async () => {
    // The body the *other* account gets back says `isFriend: false` — it is a stranger's view of
    // the subject. Presence is what can say otherwise, and it is the same source the roster path
    // reads, so the two can never disagree about who is a friend.
    const h = harness({ friends: [SUBJECT] });
    await resumeAll(h);

    const { users } = await h.deps.listUsers([SUBJECT], OTHER);
    expect(users[0]?.isFriend).toBe(true);
    // Not one profile lookup was spent working that out.
    expect(h.requests.filter((path) => path.endsWith("/friends"))).toEqual([]);
    h.stop();
  });

  test("both routes 404 an unknown user and 503 with nobody signed in", async () => {
    const missing = harness({
      groups: () => new Response("{}", { status: 404 }),
      mutuals: () => new Response("{}", { status: 404 }),
    });
    await resumeAll(missing);
    await expect(missing.deps.listUserGroups(SUBJECT, VIEWER)).rejects.toMatchObject({
      status: 404,
      code: "unknown_user",
    });
    await expect(
      missing.deps.listMutualFriends(SUBJECT, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject({ status: 404, code: "unknown_user" });
    missing.stop();

    // No `resumeAll`, so no account holds a cookie-backed session.
    const offline = harness();
    await expect(offline.deps.listUserGroups(SUBJECT, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    await expect(
      offline.deps.listMutualFriends(SUBJECT, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject({ status: 503, code: "no_account" });
    offline.stop();
  });

  test("an upstream failure on either list is a 502", async () => {
    const h = harness({
      groups: () => new Response("boom", { status: 500 }),
      mutuals: () => new Response("boom", { status: 503 }),
    });
    await resumeAll(h);
    await expect(h.deps.listUserGroups(SUBJECT, VIEWER)).rejects.toMatchObject({
      status: 502,
      code: "groups_fetch_failed",
    });
    await expect(
      h.deps.listMutualFriends(SUBJECT, VIEWER, { n: 10, offset: 0 }),
    ).rejects.toMatchObject({ status: 502, code: "mutuals_fetch_failed" });
    h.stop();
  });
});

describe("control deps: instance users", () => {
  const TARGET = {
    worldId: "wrld_ba913a96-fac4-4048-a062-9aa5db092812",
    instanceId: "12345~hidden(usr_1)~region(eu)",
  } as const;
  const LOCATION = `${TARGET.worldId}:${TARGET.instanceId}`;

  function instanceFetches(h: Harness): number {
    return h.requests.filter((path) => path.includes("/instances/")).length;
  }

  test("VRChat's `offline` for somebody standing in the room is passed through, not judged", async () => {
    const h = harness({
      instance: () =>
        Response.json({
          id: LOCATION,
          n_users: 1,
          // What VRChat answers about a person the game log has in the instance right now. The two
          // come from different places at different times and this one is simply behind.
          users: [instanceUserBody("usr_a", { status: "offline", platform: "offline" })],
        }),
    });
    await resumeAll(h);

    const roster = await h.deps.listInstanceUsers(TARGET, VIEWER);

    // Verbatim. The UI has the log to weigh this against; the daemon does not, so it does not
    // guess — see `chosenStatus` in the UI's `format.ts` for where the judgement is made.
    expect(roster.users[0]?.status).toBe("offline");
    expect(roster.users[0]?.platform).toBe("offline");
    h.stop();
  });

  test("one call yields the whole roster, with trust and age verification per head", async () => {
    const h = harness({
      instance: () =>
        Response.json({
          id: LOCATION,
          n_users: 2,
          users: [
            instanceUserBody("usr_a"),
            instanceUserBody("usr_b", {
              tags: ["system_troll"],
              ageVerificationStatus: "hidden",
              ageVerified: false,
              userIcon: "https://api.vrchat.cloud/api/1/image/icon_b/1/256",
            }),
          ],
        }),
    });
    await resumeAll(h);

    const roster = await h.deps.listInstanceUsers(TARGET, VIEWER);

    expect(roster.location).toBe(LOCATION);
    expect(roster.source).toBe("instance");
    // Forty people would have been forty `GET /users/{id}` calls. This is one.
    expect(instanceFetches(h)).toBe(1);
    expect(roster.users).toEqual([
      {
        id: "usr_a",
        displayName: "USR_A",
        iconUrl: "https://api.vrchat.cloud/api/1/image/usr_a/1/256",
        // The thumbnail is what the 36px row draws; the full-size original is what a
        // right-click "open image" opens. Both ride in the response already fetched.
        iconUrlFull: "https://api.vrchat.cloud/api/1/image/usr_a/1/1024",
        trustLevel: "veteran",
        ageVerificationStatus: "18+",
        ageVerified: true,
        isFriend: false,
        status: "active",
        platform: "standalonewindows",
        developerType: "none",
      },
      {
        id: "usr_b",
        displayName: "USR_B",
        iconUrl: "https://api.vrchat.cloud/api/1/image/icon_b/1/256",
        // `userIcon` is not a thumbnail, so it is the answer to both questions.
        iconUrlFull: "https://api.vrchat.cloud/api/1/image/icon_b/1/256",
        trustLevel: "troll",
        // `hidden` means verified-but-not-published, and it survives as itself: collapsing it into
        // a boolean would make an absent badge read as "not age verified", which is a claim about
        // a real person that vrc.zip has not been told.
        ageVerificationStatus: "hidden",
        ageVerified: false,
        isFriend: false,
        status: "active",
        platform: "standalonewindows",
        developerType: "none",
      },
    ]);
    h.stop();
  });

  /*
   * The whole reason the roster is affordable. `isFriend` is a lookup in the friend list this
   * account is already holding in memory — the upstream body here says `isFriend: false` for
   * everyone, so a true answer can only have come from local presence.
   */
  test("isFriend comes from local presence, not from a per-user fetch", async () => {
    const h = harness({
      friends: ["usr_a"],
      instance: () =>
        Response.json({ users: [instanceUserBody("usr_a"), instanceUserBody("usr_b")] }),
    });
    await resumeAll(h);

    const roster = await h.deps.listInstanceUsers(TARGET, VIEWER);

    expect(roster.users.map((u) => [u.id, u.isFriend])).toEqual([
      ["usr_a", true],
      ["usr_b", false],
    ]);
    // Not one profile was fetched to work that out.
    expect(profileFetches(h)).toBe(0);
    h.stop();
  });

  test("an absent users array is source unavailable, not a failure", async () => {
    // VRChat populates `users` only for an instance the asking account **created** — being in the
    // room is not enough, which is why this is the common answer rather than the edge case. Every
    // other instance answers a perfectly valid body without it.
    const h = harness({ instance: () => Response.json({ id: LOCATION, n_users: 12 }) });
    await resumeAll(h);

    expect(await h.deps.listInstanceUsers(TARGET, VIEWER)).toEqual({
      location: LOCATION,
      fetchedAt: expect.any(Number),
      source: "unavailable",
      users: [],
    });
    h.stop();
  });

  test("VRChat's bare null body and a closed instance are both unavailable", async () => {
    // Documented upstream: an instance id `getInstance` dislikes answers a literal `null` with a
    // 200. Unchecked, that is a `TypeError` rather than an empty roster.
    const nulled = harness({ instance: () => Response.json(null) });
    await resumeAll(nulled);
    expect((await nulled.deps.listInstanceUsers(TARGET, VIEWER)).source).toBe("unavailable");
    nulled.stop();

    // An instance that closed while the screen was open is the ordinary end of every instance.
    const gone = harness({ instance: () => new Response("null", { status: 404 }) });
    await resumeAll(gone);
    expect((await gone.deps.listInstanceUsers(TARGET, VIEWER)).source).toBe("unavailable");
    gone.stop();
  });

  test("concurrent callers share one upstream request, and a repeat is served from cache", async () => {
    const h = harness({
      instance: () => Response.json({ users: [instanceUserBody("usr_a")] }),
    });
    await resumeAll(h);

    // Three viewers with the screen open, asking at the same moment.
    const [first, second, third] = await Promise.all([
      h.deps.listInstanceUsers(TARGET, VIEWER),
      h.deps.listInstanceUsers(TARGET, VIEWER),
      h.deps.listInstanceUsers(TARGET, VIEWER),
    ]);

    expect(instanceFetches(h)).toBe(1);
    // Equal, not identical: the cache holds VRChat's record and each caller maps its own view of
    // it, because `isFriend` is per account and the header route reads different fields entirely.
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // …and a poll a moment later is inside the TTL, so it costs nothing either.
    expect(await h.deps.listInstanceUsers(TARGET, VIEWER)).toEqual(first);
    expect(instanceFetches(h)).toBe(1);
    h.stop();
  });

  test("the cache is per account, because the roster and its friendships are", async () => {
    // VRChat shows `users` to whoever is in the room, and `isFriend` is one account's fact about
    // another person. One account's answer is not the other's — same reasoning as `user_cache`.
    const h = harness({
      instance: (call) => Response.json({ users: [instanceUserBody(`usr_${String(call)}`)] }),
    });
    await resumeAll(h);

    const viewer = await h.deps.listInstanceUsers(TARGET, VIEWER);
    const other = await h.deps.listInstanceUsers(TARGET, OTHER);

    expect(instanceFetches(h)).toBe(2);
    expect(viewer.users[0]?.id).toBe("usr_1");
    expect(other.users[0]?.id).toBe("usr_2");
    h.stop();
  });

  test("an unavailable roster is not cached, so walking into the instance is noticed", async () => {
    const h = harness({
      instance: (call) =>
        call === 1
          ? Response.json({ id: LOCATION })
          : Response.json({ users: [instanceUserBody("usr_a")] }),
    });
    await resumeAll(h);

    expect((await h.deps.listInstanceUsers(TARGET, VIEWER)).source).toBe("unavailable");
    // The account has since joined, and VRChat now shows the roster. A cached "unavailable" would
    // have hidden that for the whole TTL — which is exactly the moment the user is watching.
    expect((await h.deps.listInstanceUsers(TARGET, VIEWER)).source).toBe("instance");
    expect(instanceFetches(h)).toBe(2);
    h.stop();
  });

  test("an unknown account 404s, and nobody signed in is a 503", async () => {
    const named = harness();
    await resumeAll(named);
    await expect(named.deps.listInstanceUsers(TARGET, "usr_nobody")).rejects.toMatchObject({
      status: 404,
      code: "unknown_account",
    });
    named.stop();

    // No `resumeAll`, so neither account has a cookie-backed session.
    const offline = harness();
    await expect(offline.deps.listInstanceUsers(TARGET, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    expect(instanceFetches(offline)).toBe(0);
    offline.stop();
  });

  test("an upstream failure is a 502, not a quietly empty room", async () => {
    const h = harness({ instance: () => new Response("boom", { status: 500 }) });
    await resumeAll(h);
    await expect(h.deps.listInstanceUsers(TARGET, VIEWER)).rejects.toMatchObject({
      status: 502,
      code: "instance_fetch_failed",
    });
    h.stop();
  });
});

describe("control deps: worlds", () => {
  const WORLD = "wrld_ba913a96-fac4-4048-a062-9aa5db092812";

  function worldFetches(h: Harness): number {
    return h.requests.filter((path) => path.includes("/worlds/")).length;
  }

  test("normalises the record, with VRChat's dates as integer unix ms", async () => {
    const h = harness();
    await resumeAll(h);

    const world = await h.deps.getWorld(WORLD, VIEWER);

    expect(world).toMatchObject({
      id: WORLD,
      name: "The Great Pug",
      authorName: "Author",
      capacity: 40,
      recommendedCapacity: 20,
      // The `""` padding is dropped, exactly as it is for a user's bio links.
      tags: ["author_tag_pub"],
      occupants: 12,
      version: 3,
      cached: false,
    });
    expect(world.createdAt).toBe(Date.parse("2019-01-02T03:04:05.000Z"));
    expect(world.publicationDate).toBe(Date.parse("2020-01-02T03:04:05.000Z"));
    // `"none"` is not a date, and `Date.parse` would happily turn junk into a confident number.
    expect(world.labsPublicationDate).toBeNull();
    h.stop();
  });

  test("the cache is shared across accounts, unlike user_cache", async () => {
    const h = harness();
    await resumeAll(h);

    await h.deps.getWorld(WORLD, VIEWER);
    expect(worldFetches(h)).toBe(1);

    // A world is the same object whoever asks — migration 002 left `world_cache` global on
    // purpose — so the second account's lookup is a hit, not a second fetch.
    const other = await h.deps.getWorld(WORLD, OTHER);
    expect(other.cached).toBe(true);
    expect(worldFetches(h)).toBe(1);
    h.stop();
  });

  test("a stale row is refetched, and a fresh one is served with nobody signed in", async () => {
    const h = harness();
    await resumeAll(h);
    await h.deps.getWorld(WORLD, VIEWER);

    // Older than the 24h TTL.
    h.store.putWorldCache(WORLD, Date.now() - 25 * 60 * 60_000, JSON.stringify(worldBody(WORLD)));
    expect((await h.deps.getWorld(WORLD, VIEWER)).cached).toBe(false);
    expect(worldFetches(h)).toBe(2);
    h.stop();

    // A fresh row needs no account at all: the cache is not per viewer, so a laptop that has not
    // signed in yet can still render world names in the feed.
    const offline = harness();
    offline.store.putWorldCache(WORLD, Date.now(), JSON.stringify(worldBody(WORLD)));
    const cached = await offline.deps.getWorld(WORLD, null);
    expect(cached.cached).toBe(true);
    expect(worldFetches(offline)).toBe(0);
    offline.stop();
  });

  test("a live fetch with nobody signed in is a 503, and VRChat's 404 is unknown_world", async () => {
    const offline = harness();
    await expect(offline.deps.getWorld(WORLD, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    offline.stop();

    const missing = harness({ world: () => new Response("{}", { status: 404 }) });
    await resumeAll(missing);
    await expect(missing.deps.getWorld(WORLD, VIEWER)).rejects.toMatchObject({
      status: 404,
      code: "unknown_world",
    });
    missing.stop();
  });

  /*
   * The point of the batch endpoint. A feed page names a dozen worlds across a hundred rows; if
   * each row resolved its own, that is a hundred requests.
   */
  test("the batch serves cache hits without any upstream call", async () => {
    const h = harness();
    await resumeAll(h);
    for (const id of ["wrld_a", "wrld_b"]) {
      h.store.putWorldCache(id, Date.now(), JSON.stringify(worldBody(id)));
    }

    const { worlds } = await h.deps.listWorlds(["wrld_a", "wrld_b"], VIEWER);

    expect(Object.keys(worlds).sort()).toEqual(["wrld_a", "wrld_b"]);
    expect(worlds.wrld_a).toEqual({
      id: "wrld_a",
      name: "The Great Pug",
      thumbnailImageUrl: "https://api.vrchat.cloud/api/1/image/wrld_a/1/256",
      authorName: "Author",
      capacity: 40,
    });
    expect(worldFetches(h)).toBe(0);
    h.stop();
  });

  test("a partly-resolvable batch keeps what it can and omits the rest", async () => {
    const h = harness({
      // `wrld_gone` has been deleted; `wrld_broken` fails outright. Neither may cost the third.
      world: (worldId) =>
        worldId === "wrld_gone"
          ? new Response("{}", { status: 404 })
          : worldId === "wrld_broken"
            ? new Response("boom", { status: 500 })
            : Response.json(worldBody(worldId)),
    });
    await resumeAll(h);

    const { worlds } = await h.deps.listWorlds(["wrld_ok", "wrld_gone", "wrld_broken"], VIEWER);

    // Absent, not null: the UI's `worldName ?? shortId(worldId)` fallback is the right renderer
    // for a missing key.
    expect(Object.keys(worlds)).toEqual(["wrld_ok"]);
    h.stop();
  });

  test("the batch still answers from cache with nobody signed in, and never throws", async () => {
    const h = harness();
    h.store.putWorldCache("wrld_a", Date.now(), JSON.stringify(worldBody("wrld_a")));

    // No `resumeAll`: nothing is online, so the miss cannot be fetched. The hit is still served.
    const { worlds } = await h.deps.listWorlds(["wrld_a", "wrld_b"], VIEWER);

    expect(Object.keys(worlds)).toEqual(["wrld_a"]);
    expect(worldFetches(h)).toBe(0);
    h.stop();
  });

  test("concurrent callers share one fetch per world", async () => {
    const h = harness({
      world: (worldId) => Response.json(worldBody(worldId)),
    });
    await resumeAll(h);

    const [a, b] = await Promise.all([
      h.deps.listWorlds([WORLD], VIEWER),
      h.deps.getWorld(WORLD, OTHER),
    ]);

    // Keyed by world id alone, not by account — so even two *different* accounts share it.
    expect(worldFetches(h)).toBe(1);
    expect(a.worlds[WORLD]?.name).toBe("The Great Pug");
    expect(b.name).toBe("The Great Pug");
    h.stop();
  });
});

describe("control deps: instance detail", () => {
  const TARGET = {
    worldId: "wrld_ba913a96-fac4-4048-a062-9aa5db092812",
    instanceId: "12345~hidden(usr_1)~region(eu)",
  } as const;
  const LOCATION = `${TARGET.worldId}:${TARGET.instanceId}`;

  function instanceBody(overrides: Record<string, unknown> = {}) {
    return {
      id: LOCATION,
      instanceId: TARGET.instanceId,
      worldId: TARGET.worldId,
      type: "hidden",
      ownerId: "usr_1",
      region: "eu",
      capacity: 40,
      userCount: 12,
      n_users: 12,
      full: false,
      canRequestInvite: true,
      closedAt: null,
      queueEnabled: false,
      queueSize: 0,
      tags: ["language_eng"],
      active: true,
      world: worldBody(TARGET.worldId),
      ...overrides,
    };
  }

  test("serves the instance, its counts, and the world that rode along with it", async () => {
    const h = harness({ instance: () => Response.json(instanceBody()) });
    await resumeAll(h);

    const detail = await h.deps.getInstance(TARGET, VIEWER);

    expect(detail.source).toBe("instance");
    expect(detail.location).toBe(LOCATION);
    expect(detail.instance).toMatchObject({
      worldId: TARGET.worldId,
      instanceId: TARGET.instanceId,
      type: "hidden",
      region: "eu",
      capacity: 40,
      userCount: 12,
      nUsers: 12,
      full: false,
      canRequestInvite: true,
      closedAt: null,
      queueEnabled: false,
      tags: ["language_eng"],
      active: true,
      world: { id: TARGET.worldId, name: "The Great Pug", capacity: 40 },
    });
    h.stop();
  });

  /*
   * The whole reason the two instance routes share a cache: they read different halves of one
   * response, and fetching it twice for one screen would be paying twice for the same bytes.
   */
  test("the roster and the header share one upstream call", async () => {
    const h = harness({ instance: () => Response.json(instanceBody({ users: [] })) });
    await resumeAll(h);

    await h.deps.listInstanceUsers(TARGET, VIEWER);
    await h.deps.getInstance(TARGET, VIEWER);

    expect(h.requests.filter((p) => p.includes("/instances/")).length).toBe(1);
    h.stop();
  });

  test("the world rides along free — a feed row naming it never asks /worlds", async () => {
    const h = harness({ instance: () => Response.json(instanceBody()) });
    await resumeAll(h);

    await h.deps.getInstance(TARGET, VIEWER);
    const { worlds } = await h.deps.listWorlds([TARGET.worldId], VIEWER);

    expect(worlds[TARGET.worldId]?.name).toBe("The Great Pug");
    expect(h.requests.filter((p) => p.includes("/worlds/")).length).toBe(0);
    h.stop();
  });

  test("a bare null body and a closed instance are unavailable, not errors", async () => {
    // Documented upstream: an instance id `getInstance` dislikes answers a literal `null` — with
    // a 200. Unchecked, that is a `TypeError`.
    const nulled = harness({ instance: () => Response.json(null) });
    await resumeAll(nulled);
    expect(await nulled.deps.getInstance(TARGET, VIEWER)).toMatchObject({
      source: "unavailable",
      instance: null,
    });
    nulled.stop();

    const gone = harness({ instance: () => new Response("null", { status: 404 }) });
    await resumeAll(gone);
    expect((await gone.deps.getInstance(TARGET, VIEWER)).source).toBe("unavailable");
    // …and it is not re-asked on the next poll: "there is no such instance" is a complete answer.
    await gone.deps.getInstance(TARGET, VIEWER);
    await gone.deps.listInstanceUsers(TARGET, VIEWER);
    expect(gone.requests.filter((p) => p.includes("/instances/")).length).toBe(1);
    gone.stop();
  });

  test("nobody signed in is a 503", async () => {
    const h = harness();
    await expect(h.deps.getInstance(TARGET, VIEWER)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    h.stop();
  });
});

describe("control deps: events", () => {
  /*
   * The regression this change exists for. The old no-`accountId` path fanned out over
   * `accounts.list()`, so a row written by a game client vrc.zip does not manage — `account_id
   * IS NULL`, a normal state per PLAN.md §1.7 — could never appear in the unified feed.
   */
  test("the unified feed includes rows with no account", async () => {
    const h = harness();
    const sessionId = h.store.startSession({
      account_id: null,
      display_name: "Unmanaged",
      log_path: "C:/logs/output_log_unmanaged.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: null,
      current_location: null,
      current_world_id: null,
    });
    h.store.insertEvent({
      account_id: null,
      ts: T0 + 1,
      session_id: sessionId,
      kind: "gamelog.player_join",
      subject_id: SUBJECT,
      location: "wrld_x:1",
      payload: `{"displayName":"Subject"}`,
    });
    h.store.insertEvent({
      account_id: VIEWER,
      ts: T0,
      session_id: null,
      kind: "friend.online",
      subject_id: SUBJECT,
      location: null,
      payload: null,
    });

    const all = await h.deps.listEvents({ limit: 10 });
    expect(all.map((e) => e.accountId)).toEqual([null, VIEWER]);
    expect(all[0]?.payload).toEqual({ displayName: "Subject" });
    expect(all[0]?.sessionId).toBe(sessionId);

    // Each selector narrows to its own axis.
    expect(await h.deps.listEvents({ limit: 10, sessionId })).toHaveLength(1);
    expect(await h.deps.listEvents({ limit: 10, accountId: VIEWER })).toHaveLength(1);
    expect(await h.deps.listEvents({ limit: 10, subjectId: SUBJECT })).toHaveLength(2);
    expect(
      await h.deps.listEvents({ limit: 10, subjectId: SUBJECT, kind: "gamelog.player_join" }),
    ).toHaveLength(1);
    h.stop();
  });
});

describe("control deps: app audit", () => {
  test("reads back the stored rows, newest first, and 404s only for a grant that never existed", async () => {
    const h = harness();
    h.store.insertGrant({
      id: "grant_a",
      account_id: VIEWER,
      app_name: "Test App",
      app_version: "1.0.0",
      app_contact: "test@example.invalid",
      scopes: JSON.stringify(["user.write"]),
      token_hash: "hash_a",
      two_factor_hash: null,
      created_at: T0,
    });
    // A second grant, so "scoped to this app" is provable rather than incidental.
    h.store.insertGrant({
      id: "grant_b",
      account_id: VIEWER,
      app_name: "Other App",
      app_version: "1.0.0",
      app_contact: "other@example.invalid",
      scopes: "[]",
      token_hash: "hash_b",
      two_factor_hash: null,
      created_at: T0,
    });

    for (const [index, grantId] of ["grant_a", "grant_a", "grant_b"].entries()) {
      h.store.appendAudit({
        ts: T0 + index,
        grant_id: grantId,
        account_id: VIEWER,
        app_name: grantId === "grant_a" ? "Test App" : "Other App",
        method: "PUT",
        path: `/api/1/user/${SUBJECT}`,
        operation_id: "updateUser",
        scope: "user.write",
        outcome: index === 1 ? "denied_scope" : "allowed",
        status: index === 1 ? 403 : 200,
      });
    }

    const rows = await h.deps.listAppAudit("grant_a", { limit: 10 });
    expect(rows.map((row) => [row.ts, row.outcome, row.status])).toEqual([
      [T0 + 1, "denied_scope", 403],
      [T0, "allowed", 200],
    ]);
    expect(rows[0]).toMatchObject({
      grantId: "grant_a",
      accountId: VIEWER,
      appName: "Test App",
      method: "PUT",
      operationId: "updateUser",
      scope: "user.write",
    });

    // `before` is a strict "older than", exactly as the feed's cursor is.
    expect(await h.deps.listAppAudit("grant_a", { limit: 10, before: T0 + 1 })).toHaveLength(1);
    expect(await h.deps.listAppAudit("grant_a", { limit: 1 })).toHaveLength(1);

    // A revoked grant still answers: the log outlives the access it records.
    h.store.revokeGrant("grant_b", T0 + 100);
    expect(await h.deps.listAppAudit("grant_b", { limit: 10 })).toHaveLength(1);

    await expect(h.deps.listAppAudit("grant_missing", { limit: 10 })).rejects.toMatchObject({
      status: 404,
      code: "unknown_app",
    });
    h.stop();
  });
});

/**
 * The derived world instance list.
 *
 * This is the one list in the app with no upstream call behind it, so what it gets right is
 * entirely about the derivation: which locations count as instances, who is deduplicated against
 * whom, and whether your own client shows up when nobody else can vouch for the room.
 */
describe("listWorldInstances", () => {
  const WORLD = "wrld_ba913a96-fac4-4048-a062-9aa5db092812";
  const OTHER_WORLD = "wrld_00000000-0000-0000-0000-000000000000";
  const ROOM = `${WORLD}:12345~region(eu)`;
  const QUIET = `${WORLD}:999~friends(usr_viewer)`;

  function located(over: Partial<FriendPresenceRecord>): Partial<FriendPresenceRecord> {
    return {
      id: "usr_a",
      displayName: "Ada",
      status: "active",
      iconUrl: null,
      location: ROOM,
      worldId: WORLD,
      ...over,
    };
  }

  test("groups friends by the instance they are standing in", async () => {
    const h = harness({
      located: [
        located({ id: "usr_a", displayName: "Ada" }),
        located({ id: "usr_b", displayName: "Bob" }),
        located({ id: "usr_c", displayName: "Cass", location: QUIET }),
      ],
    });

    const { instances } = await h.deps.listWorldInstances(WORLD, VIEWER);
    expect(instances).toHaveLength(2);
    // Busiest first, and the friends inside a row sorted by name.
    expect(instances[0]?.location).toBe(ROOM);
    expect(instances[0]?.friends.map((friend) => friend.displayName)).toEqual(["Ada", "Bob"]);
    expect(instances[0]?.sources).toEqual(["friend"]);
    expect(instances[0]?.instanceId).toBe("12345");
    expect(instances[1]?.friends.map((friend) => friend.displayName)).toEqual(["Cass"]);
    h.stop();
  });

  test("ignores friends whose location is not an instance of this world", async () => {
    // `private`, `traveling`, `offline` and the empty string all mean "somewhere, but not
    // anywhere you can be told about". A friend in one of them is not evidence of an instance.
    const h = harness({
      located: [
        located({ id: "usr_p", location: "private", worldId: null }),
        located({ id: "usr_t", location: "traveling", worldId: null }),
        located({ id: "usr_o", location: "offline", worldId: null }),
        located({ id: "usr_e", location: "", worldId: null }),
        located({ id: "usr_n", location: null, worldId: null }),
        located({ id: "usr_x", location: `${OTHER_WORLD}:1`, worldId: OTHER_WORLD }),
      ],
    });

    expect((await h.deps.listWorldInstances(WORLD, VIEWER)).instances).toEqual([]);
    h.stop();
  });

  test("counts the same friend once when two accounts can both see them", async () => {
    // `listAll` genuinely returns one person per account that has them as a friend. Two rows for
    // one human in the same room would overstate how busy it is.
    const h = harness({ located: [located({}), located({})] });

    const { instances } = await h.deps.listWorldInstances(WORLD, null);
    expect(instances[0]?.friends).toHaveLength(1);
    h.stop();
  });

  test("your own client makes an instance visible with no friends in it at all", async () => {
    const h = harness({ located: [] });
    const id = h.store.startSession({
      account_id: null,
      display_name: null,
      log_path: "output_log_x.txt",
      log_inode: 1,
      started_at: T0,
      vr_mode: null,
      current_location: ROOM,
      current_world_id: WORLD,
    });

    const { instances } = await h.deps.listWorldInstances(WORLD, null);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.sources).toEqual(["client"]);
    expect(instances[0]?.clientSessionIds).toEqual([id]);
    expect(instances[0]?.friends).toEqual([]);
    h.stop();
  });

  test("the room you are in sorts above a busier one, and reports both sources", async () => {
    const h = harness({
      located: [
        located({ id: "usr_a", location: ROOM }),
        located({ id: "usr_b", location: ROOM }),
        located({ id: "usr_c", location: QUIET }),
      ],
    });
    h.store.startSession({
      account_id: null,
      display_name: null,
      log_path: "output_log_y.txt",
      log_inode: 2,
      started_at: T0,
      vr_mode: null,
      current_location: QUIET,
      current_world_id: WORLD,
    });

    const { instances } = await h.deps.listWorldInstances(WORLD, null);
    // `QUIET` has one friend against ROOM's two, and still leads: it is the room you are in.
    expect(instances[0]?.location).toBe(QUIET);
    expect(instances[0]?.sources).toEqual(["friend", "client"]);
    expect(instances[1]?.location).toBe(ROOM);
    h.stop();
  });

  test("reads the world once per signed-in account, not once", async () => {
    /*
     * The whole reason this is not a single fetch. `World.instances` is empty for an
     * unauthenticated caller and differs by *which* caller, so asking through one account would
     * present one account's view as the whole picture.
     */
    const h = harness({
      located: [],
      world: (worldId, call) =>
        Response.json(
          worldBody(worldId, { instances: [[`${String(call)}~region(eu)`, call * 3]] }),
        ),
    });
    await resumeAll(h);

    const { instances, accountsConsulted, failedAccountIds } = await h.deps.listWorldInstances(
      WORLD,
      null,
    );

    expect(accountsConsulted).toBe(2);
    expect(failedAccountIds).toEqual([]);
    expect(h.requests.filter((path) => path.includes("/worlds/"))).toHaveLength(2);

    // Two accounts, two different rooms, each vouched for by exactly one of them.
    expect(instances).toHaveLength(2);
    for (const instance of instances) {
      expect(instance.sources).toEqual(["vrchat"]);
      expect(instance.seenByAccountIds).toHaveLength(1);
    }
    expect(new Set(instances.flatMap((i) => i.seenByAccountIds))).toEqual(new Set([VIEWER, OTHER]));
    h.stop();
  });

  test("one account failing does not fail the list, and is named", async () => {
    const h = harness({
      located: [],
      world: (worldId, call) =>
        call === 1
          ? new Response("nope", { status: 500 })
          : Response.json(worldBody(worldId, { instances: [["77~region(us)", 4]] })),
    });
    await resumeAll(h);

    const { instances, failedAccountIds } = await h.deps.listWorldInstances(WORLD, null);

    // The surviving account's answer is the entire point of asking several.
    expect(failedAccountIds).toHaveLength(1);
    expect(instances).toHaveLength(1);
    // `instanceId` is the bare id; the tags stay on the location, which is what a join takes.
    expect(instances[0]?.instanceId).toBe("77");
    expect(instances[0]?.location).toBe(`${WORLD}:77~region(us)`);
    expect(instances[0]?.userCount).toBe(4);
    h.stop();
  });

  test("a 403 is an answer, not a failure", async () => {
    // The account was asked and said "you may not see this". That is a fact about access, and
    // reporting it as a failed account would tell the reader the view is broken when it is not.
    const h = harness({ located: [], world: () => new Response("", { status: 403 }) });
    await resumeAll(h);

    expect(await h.deps.listWorldInstances(WORLD, null)).toMatchObject({
      instances: [],
      failedAccountIds: [],
      accountsConsulted: 2,
    });
    h.stop();
  });

  test("VRChat's count and a friend in the room describe one instance, not two", async () => {
    const h = harness({
      located: [located({ id: "usr_a", displayName: "Ada", location: ROOM })],
      world: (worldId) =>
        Response.json(worldBody(worldId, { instances: [["12345~region(eu)", 9]] })),
    });
    await resumeAll(h);

    const { instances } = await h.deps.listWorldInstances(WORLD, null);
    expect(instances).toHaveLength(1);
    // Both vouched for it, and the count is VRChat's rather than the number of friends seen.
    expect(instances[0]?.sources).toEqual(["vrchat", "friend"]);
    expect(instances[0]?.userCount).toBe(9);
    expect(instances[0]?.friends).toHaveLength(1);
    h.stop();
  });

  test("skips a malformed instances tuple instead of losing the whole list", async () => {
    // The spec types these as `Array<[unknown, unknown]>` and gives no item schema, so every
    // element is validated. One bad tuple must not cost the ones that decoded.
    const h = harness({
      located: [],
      world: (worldId) =>
        Response.json(
          worldBody(worldId, {
            instances: [null, ["", 1], [42, 1], ["55~region(eu)"], ["12345~region(eu)", 7]],
          }),
        ),
    });
    await resumeAll(h);

    const { instances } = await h.deps.listWorldInstances(WORLD, null);
    expect(instances.map((i) => i.instanceId).toSorted()).toEqual(["12345", "55"]);
    // A tuple with no count is an instance with an unknown count, never a zero.
    expect(instances.find((i) => i.instanceId === "55")?.userCount).toBeNull();
    h.stop();
  });

  test("answers with an empty list rather than throwing when nothing is signed in", async () => {
    // It reaches VRChat for nothing, so `no_account` is not a failure mode it has. An empty list
    // is a true statement about what can be seen.
    const h = harness({ located: [] });
    expect(await h.deps.listWorldInstances(WORLD, null)).toEqual({
      instances: [],
      accountsConsulted: 0,
      failedAccountIds: [],
    });
    h.stop();
  });
});

describe("control deps: avatars", () => {
  /** A resolver over the harness's own store, with avtr.zip stubbed. */
  function stubResolver(
    store: Store,
    respond: () => Response,
    enabled: () => boolean = () => true,
  ): { resolver: AvatarIdResolver; requests: string[] } {
    const requests: string[] = [];
    const resolver = new AvatarIdResolver({
      userAgent: "vrc.zip/test (tests@somewhere.dev)",
      baseUrl: "https://avtr.example",
      store,
      enabled,
      fetch: async (input) => {
        requests.push(input);
        return respond();
      },
    });
    return { resolver, requests };
  }

  test("resolves a file id to an avatar id and writes the row", async () => {
    const store = Store.open(MEMORY);
    const { resolver, requests } = stubResolver(store, () =>
      Response.json({ success: true, avatarId: AVATAR_ID }),
    );
    const h = harness({ avatarIds: resolver });

    expect(await h.deps.resolveAvatarByFile(AVATAR_FILE_ID)).toEqual({
      fileId: AVATAR_FILE_ID,
      avatarId: AVATAR_ID,
    });
    expect(requests).toEqual([`https://avtr.example/v3/avatars/by-file/${AVATAR_FILE_ID}`]);
    // The persisted row, not the return value: this is what survives a restart.
    expect(store.getAvatarFileId(AVATAR_FILE_ID)?.avatar_id).toBe(AVATAR_ID);
    store.close();
    h.stop();
  });

  test("with the setting off it answers null and makes no third-party request", async () => {
    const store = Store.open(MEMORY);
    const { resolver, requests } = stubResolver(
      store,
      () => Response.json({ success: true, avatarId: AVATAR_ID }),
      () => false,
    );
    const h = harness({
      avatarIds: resolver,
      settings: { ...DEFAULT_SETTINGS, resolveAvatarIds: false },
    });

    // A normal "not resolved" answer, never an error — see `ControlDeps.resolveAvatarByFile`.
    expect(await h.deps.resolveAvatarByFile(AVATAR_FILE_ID)).toEqual({
      fileId: AVATAR_FILE_ID,
      avatarId: null,
    });
    expect(requests).toEqual([]);
    expect(store.getAvatarFileId(AVATAR_FILE_ID)).toBeNull();
    store.close();
    h.stop();
  });

  test("an avtr.zip failure is a null answer, not a thrown route", async () => {
    const store = Store.open(MEMORY);
    const { resolver } = stubResolver(store, () => new Response("nope", { status: 502 }));
    const h = harness({ avatarIds: resolver });

    expect(await h.deps.resolveAvatarByFile(AVATAR_FILE_ID)).toEqual({
      fileId: AVATAR_FILE_ID,
      avatarId: null,
    });
    store.close();
    h.stop();
  });

  test("the default resolver is built lazily and never runs without a contact", async () => {
    // `DEFAULT_SETTINGS.contact` is `""`, which cannot make a valid User-Agent — so there is
    // nothing to build and the answer is an honest null rather than a throw at construction.
    const h = harness();
    expect(await h.deps.resolveAvatarByFile(AVATAR_FILE_ID)).toEqual({
      fileId: AVATAR_FILE_ID,
      avatarId: null,
    });
    h.stop();
  });

  test("wears the avatar through the named account and forgets its cached profile", async () => {
    const h = harness({ avatar: () => Response.json(avatarBody(AVATAR_ID)) });
    await resumeAll(h);

    // A cached profile for the acting account, holding the avatar it is about to stop wearing.
    h.store.putUserCache(VIEWER, VIEWER, T0, JSON.stringify({ id: VIEWER }));
    expect(h.store.getUserCache(VIEWER, VIEWER)).not.toBeNull();

    await h.deps.selectAvatar(AVATAR_ID, VIEWER);

    expect(h.requests).toContain(`/api/1/avatars/${AVATAR_ID}/select`);
    // The one field this action exists to move lives on that record, so the row goes rather than
    // serving a picture that is now wrong until its TTL runs out.
    expect(h.store.getUserCache(VIEWER, VIEWER)).toBeNull();
    h.stop();
  });

  test("maps VRChat's refusal and its 404 to different answers", async () => {
    // Different disappointments: one avatar is gone, the other is one this account may not wear.
    // VRChat decides entitlement; vrc.zip neither checks nor bypasses it.
    const forbidden = harness({ avatar: () => new Response("", { status: 403 }) });
    await resumeAll(forbidden);
    await expect(forbidden.deps.selectAvatar(AVATAR_ID, VIEWER)).rejects.toMatchObject({
      status: 403,
      code: "avatar_forbidden",
    });
    forbidden.stop();

    const gone = harness({ avatar: () => new Response("", { status: 404 }) });
    await resumeAll(gone);
    await expect(gone.deps.selectAvatar(AVATAR_ID, VIEWER)).rejects.toMatchObject({
      status: 404,
      code: "unknown_avatar",
    });
    gone.stop();
  });

  test("refuses for an account that is not signed in", async () => {
    // Saying so beats letting `vrcFetch` find it as a 401 and re-auth into a 2FA challenge that
    // nobody is watching.
    const h = harness();
    await expect(h.deps.selectAvatar(AVATAR_ID, VIEWER)).rejects.toMatchObject({
      status: 409,
      code: "account_offline",
    });
    expect(h.requests.filter((path) => path.includes("/select"))).toEqual([]);
    h.stop();
  });

  test("asks each signed-in account until one can see the avatar, and says which", async () => {
    /*
     * A 404 on an avatar is a statement about the asker, not the avatar: VRChat serves the record
     * only to accounts allowed to see it, so an avatar private to its author is invisible to every
     * other account including your own others. Asking through one account and reporting "no such
     * avatar" would be wrong most of the time on a multi-account setup.
     */
    const h = harness({
      avatar: (_avatarId, call) =>
        call === 1 ? new Response("", { status: 404 }) : Response.json(avatarBody(AVATAR_ID)),
    });
    await resumeAll(h);

    const detail = await h.deps.getAvatar(AVATAR_ID, null);
    expect(detail.id).toBe(AVATAR_ID);
    // The second account is the one that could see it, and the answer names it.
    expect(detail.seenByAccountId).toBe(OTHER);
    expect(h.requests.filter((path) => path.includes("/avatars/"))).toHaveLength(2);
    h.stop();
  });

  test("stops at the first account that answers rather than asking them all", async () => {
    // Sequential on purpose: the first answer ends the question, and firing one request per account
    // to use one of them is waste the rate limiter would rather not carry.
    const h = harness();
    await resumeAll(h);

    const detail = await h.deps.getAvatar(AVATAR_ID, null);
    expect(detail.seenByAccountId).toBe(VIEWER);
    expect(h.requests.filter((path) => path.includes("/avatars/"))).toHaveLength(1);
    h.stop();
  });

  test("404s only when no account can see it, and says how many were asked", async () => {
    const h = harness({ avatar: () => new Response("", { status: 404 }) });
    await resumeAll(h);

    await expect(h.deps.getAvatar(AVATAR_ID, null)).rejects.toMatchObject({
      status: 404,
      code: "unknown_avatar",
    });
    expect(h.requests.filter((path) => path.includes("/avatars/"))).toHaveLength(2);
    h.stop();
  });

  test("a named account is asked alone, never fallen back from", async () => {
    // Naming an account is the caller saying whose eyes to use. Silently trying somebody else's
    // would answer a different question than the one asked.
    const h = harness({ avatar: () => new Response("", { status: 404 }) });
    await resumeAll(h);

    await expect(h.deps.getAvatar(AVATAR_ID, VIEWER)).rejects.toMatchObject({ status: 404 });
    expect(h.requests.filter((path) => path.includes("/avatars/"))).toHaveLength(1);
    h.stop();
  });

  test("projects the avatar and caches the body in avatar_cache", async () => {
    const h = harness();
    await resumeAll(h);

    const detail = await h.deps.getAvatar(AVATAR_ID, VIEWER);
    expect(detail).toEqual({
      id: AVATAR_ID,
      name: "A Robot",
      description: "beep",
      authorId: "usr_author",
      authorName: "Author",
      imageUrl: `https://api.vrchat.cloud/api/1/image/${AVATAR_FILE_ID}/1/1024`,
      thumbnailImageUrl: `https://api.vrchat.cloud/api/1/image/${AVATAR_FILE_ID}/1/256`,
      releaseStatus: "public",
      // The `""` VRChat pads its tag arrays with is dropped, not rendered as a blank chip.
      tags: ["author_tag_robot"],
      version: 3,
      createdAt: Date.parse("2019-01-02T03:04:05.000Z"),
      updatedAt: Date.parse("2021-01-02T03:04:05.000Z"),
      fetchedAt: detail.fetchedAt,
      cached: false,
      // The account that could actually see it, which is the point of asking each in turn.
      seenByAccountId: VIEWER,
    });
    // Asset locations are not projected — see `toAvatarDetail`.
    expect(Object.keys(detail)).not.toContain("unityPackages");
    expect(Object.keys(detail)).not.toContain("assetUrl");

    // The row, not the return value. It is an envelope rather than a bare body, because the row
    // has to remember which account could see this avatar as well as what it is.
    const row = h.store.getAvatarCache(AVATAR_ID);
    expect(row?.id).toBe(AVATAR_ID);
    expect(JSON.parse(row?.data ?? "{}")).toMatchObject({
      v: 1,
      seenByAccountId: VIEWER,
      avatar: { id: AVATAR_ID, name: "A Robot" },
    });

    // Second read is the cache, with no second request and `cached: true`.
    const again = await h.deps.getAvatar(AVATAR_ID, VIEWER);
    expect(again.cached).toBe(true);
    expect(h.requests.filter((path) => path.includes("/avatars/"))).toHaveLength(1);
    h.stop();
  });

  test("a warm cache answers with nobody signed in; a cold one is a 503", async () => {
    const h = harness();
    await resumeAll(h);
    await h.deps.getAvatar(AVATAR_ID, VIEWER);

    // A fresh deps over the same store, with no account resumed: the record is not per account.
    const cold = harness();
    cold.store.putAvatarCache(AVATAR_ID, Date.now(), JSON.stringify(avatarBody(AVATAR_ID)));
    expect((await cold.deps.getAvatar(AVATAR_ID, null)).cached).toBe(true);

    const empty = harness();
    await expect(empty.deps.getAvatar(AVATAR_ID, null)).rejects.toMatchObject({
      status: 503,
      code: "no_account",
    });
    h.stop();
    cold.stop();
    empty.stop();
  });

  test("a VRChat 404 is unknown_avatar — the ordinary answer for a private avatar", async () => {
    const h = harness({
      avatar: (avatarId) =>
        avatarId === AVATAR_MISSING
          ? new Response(`{"error":{"message":"not found"}}`, { status: 404 })
          : Response.json(avatarBody(avatarId)),
    });
    await resumeAll(h);

    await expect(h.deps.getAvatar(AVATAR_MISSING, VIEWER)).rejects.toMatchObject({
      status: 404,
      code: "unknown_avatar",
    });
    // Nothing cached for an avatar that does not exist.
    expect(h.store.getAvatarCache(AVATAR_MISSING)).toBeNull();
    h.stop();
  });

  test("concurrent readers of one avatar make one request", async () => {
    const h = harness({
      avatar: async (avatarId) => {
        await Bun.sleep(5);
        return Response.json(avatarBody(avatarId));
      },
    });
    await resumeAll(h);

    const results = await Promise.all([
      h.deps.getAvatar(AVATAR_ID, VIEWER),
      h.deps.getAvatar(AVATAR_ID, VIEWER),
      h.deps.getAvatar(AVATAR_ID, OTHER),
    ]);
    expect(results.map((r) => r.id)).toEqual([AVATAR_ID, AVATAR_ID, AVATAR_ID]);
    expect(h.requests.filter((path) => path.includes("/avatars/"))).toHaveLength(1);
    h.stop();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Graphs                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** The three methods the graph save path asks a plugin host for, and nothing else. */
function nodeHost(refusal: string | null, hash: string | null = "hash-1"): PluginHost {
  return {
    nodeType: (qualifiedId: string) =>
      qualifiedId === "vrcz/known" ? ({ qualifiedId } as never) : null,
    checkNodeEdge: () => refusal,
    nodeHash: async (qualifiedId: string) =>
      await Promise.resolve(qualifiedId === "vrcz/known" ? hash : null),
  } as unknown as PluginHost;
}

function document(fromType: string, toType: string) {
  return {
    nodes: [
      { id: "n1", type: fromType, position: { x: 0, y: 0 }, config: {} },
      { id: "n2", type: toType, position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [{ id: "e1", from: { node: "n1", port: "out" }, to: { node: "n2", port: "in" } }],
  };
}

describe("the graph save path", () => {
  test("refuses an edge the type checker rejects, naming the edge", async () => {
    // Type checking happens twice on purpose: the editor checks as you wire, and this runs on save,
    // because the frontend is a client and clients lie.
    const h = harness({ plugins: nodeHost("A user cannot flow into a number.") });
    const graph = await h.deps.createGraph({ name: "g" });

    await expect(
      h.deps.updateGraph(graph.id, { definition: document("vrcz/known", "vrcz/known") }),
    ).rejects.toThrow(/e1: A user cannot flow into a number\./);
    h.stop();
  });

  test("does not refuse an edge whose node types are not registered", async () => {
    // A graph naming a stopped plugin's node is a normal state. A save that failed on it would mean
    // the user could not fix the graph without first restarting the plugin that broke it.
    const h = harness({ plugins: nodeHost("this would be a refusal") });
    const graph = await h.deps.createGraph({ name: "g" });

    const saved = await h.deps.updateGraph(graph.id, {
      definition: document("acme.gone/node", "acme.gone/other"),
    });
    expect(saved.definition.edges).toHaveLength(1);
    h.stop();
  });

  test("accepts a legal edge", async () => {
    const h = harness({ plugins: nodeHost(null) });
    const graph = await h.deps.createGraph({ name: "g" });
    const saved = await h.deps.updateGraph(graph.id, {
      definition: document("vrcz/known", "vrcz/known"),
    });
    expect(saved.definition.nodes).toHaveLength(2);
    h.stop();
  });
});

describe("stale node types", () => {
  test("a node whose type changed since the save is named", async () => {
    // Saved against `hash-1`, and the registry now answers `hash-2`. That is the prompt the user
    // needs: their graph was built against a node that has since moved.
    const h = harness({ plugins: nodeHost(null, "hash-1") });
    const graph = await h.deps.createGraph({ name: "g" });
    const saved = await h.deps.updateGraph(graph.id, {
      definition: document("vrcz/known", "vrcz/known"),
    });
    // Stamped on save, which is what makes the comparison possible at all.
    expect(saved.definition.nodes.every((node) => node.defHash === "hash-1")).toBe(true);
    expect(saved.staleNodes).toEqual([]);

    const moved = harness({ plugins: nodeHost(null, "hash-2") });
    moved.store.insertGraph({
      id: "g-moved",
      name: "g",
      description: "",
      enabled: 0,
      armed: 0,
      concurrency: "parallel",
      account_id: null,
      definition: JSON.stringify(saved.definition),
      created_at: 0,
      updated_at: 0,
    });
    expect((await moved.deps.getGraph("g-moved")).staleNodes).toEqual(["n1", "n2"]);
    moved.stop();
    h.stop();
  });

  test("an unregistered type is not stale — that is a different sentence", async () => {
    // "Its plugin is stopped" and "its ports changed" want different fixes, so they are different
    // states rather than one vague warning.
    const h = harness({ plugins: nodeHost(null, "hash-1") });
    const graph = await h.deps.createGraph({ name: "g" });
    await h.deps.updateGraph(graph.id, { definition: document("acme.gone/a", "acme.gone/b") });
    expect((await h.deps.getGraph(graph.id)).staleNodes).toEqual([]);
    h.stop();
  });
});

describe("export and import", () => {
  test("an export carries the node types it was built against", async () => {
    const h = harness({ plugins: nodeHost(null, "hash-1") });
    const graph = await h.deps.createGraph({ name: "Shareable" });
    await h.deps.updateGraph(graph.id, { definition: document("vrcz/known", "vrcz/known") });

    const exported = await h.deps.exportGraph(graph.id);
    expect(exported.version).toBe(1);
    expect(exported.name).toBe("Shareable");
    expect(exported.nodeTypes).toEqual([{ qualifiedId: "vrcz/known", defHash: "hash-1" }]);
    h.stop();
  });

  test("an import lands off, unarmed, with no account, and says what is missing", async () => {
    // An import that refused a graph naming a node this machine lacks would fail on exactly the
    // case a shared graph is for. It creates it disabled and names what the user needs.
    const h = harness({ plugins: nodeHost(null, "hash-1") });
    const result = await h.deps.importGraph({
      version: 1,
      name: "From a friend",
      description: "",
      concurrency: "queue",
      definition: document("vrcz/known", "acme.gone/node"),
      nodeTypes: [
        { qualifiedId: "vrcz/known", defHash: "hash-1" },
        { qualifiedId: "acme.gone/node", defHash: "whatever" },
      ],
    });

    expect(result.graph.name).toBe("From a friend");
    expect(result.graph.enabled).toBe(false);
    expect(result.graph.armed).toBe(false);
    // Never carried across: an account id from another machine names an account this one may not
    // have, and acting as the wrong person is the worst failure available here.
    expect(result.graph.accountId).toBeNull();
    expect(result.graph.concurrency).toBe("queue");
    expect(result.missing).toEqual(["acme.gone/node"]);
    h.stop();
  });

  test("an import notices a node type that has moved since the export", async () => {
    const h = harness({ plugins: nodeHost(null, "hash-2") });
    const result = await h.deps.importGraph({
      version: 1,
      name: "Older",
      definition: document("vrcz/known", "vrcz/known"),
      nodeTypes: [{ qualifiedId: "vrcz/known", defHash: "hash-1" }],
    });
    expect(result.changed).toEqual(["vrcz/known"]);
    expect(result.missing).toEqual([]);
    h.stop();
  });

  test("a malformed export is refused with a sentence rather than half-imported", async () => {
    const h = harness({ plugins: nodeHost(null) });
    await expect(h.deps.importGraph({ version: 2 })).rejects.toThrow(/does not understand/);
    await expect(h.deps.importGraph("not an object")).rejects.toThrow(/not a graph export/);
    await expect(
      h.deps.importGraph({ version: 1, definition: { nodes: "nope", edges: [] } }),
    ).rejects.toThrow(/nodes/);
    expect(h.store.listGraphs()).toEqual([]);
    h.stop();
  });

  test("the shipped templates use only built-in node types", async () => {
    // A template naming a plugin the user does not have is a template that lands broken.
    const h = harness();
    const templates = await h.deps.listGraphTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      for (const node of template.definition.nodes) {
        expect(node.type.startsWith("vrcz/")).toBe(true);
      }
    }
    h.stop();
  });
});
