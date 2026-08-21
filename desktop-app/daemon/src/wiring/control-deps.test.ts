import { describe, expect, test } from "bun:test";
import { Account } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import type { PresenceService } from "../accounts/presence.ts";
import { EventBus } from "../bus/event-bus.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import type { SecretsStore } from "../security/secrets.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { MEMORY, Store } from "../store/index.ts";
import { createControlDeps } from "./control-deps.ts";

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
    /** What `GET /users/{id}/groups/represented` answers with. Defaults to `{}` — nobody. */
    represented?: () => Response;
    /** What `GET /users/{id}/groups` answers with. Defaults to an empty list. */
    groups?: () => Response;
    /** What `GET /groups/{id}` answers with — the group modal's own route. */
    group?: () => Response;
    /** What `GET /users/{id}/mutuals/friends` answers with, given the paging it was asked for. */
    mutuals?: (n: number, offset: number) => Response;
    /** What `GET /worlds/{id}` answers with. */
    world?: (worldId: string, call: number) => Response;
  } = {},
): Harness {
  const bus = new EventBus();
  const limiter = new RateLimiter();
  const store = Store.open(MEMORY);
  const requests: string[] = [];
  const accounts = new Map<string, Account>();

  let instanceCalls = 0;
  let worldCalls = 0;

  const fetchStub = async (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname;
    requests.push(path);

    if (path.includes("/worlds/")) {
      worldCalls += 1;
      const worldId = path.slice(path.lastIndexOf("/") + 1);
      return options.world?.(worldId, worldCalls) ?? Response.json(worldBody(worldId));
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
      return options.group?.() ?? Response.json({});
    }
    // Ordered before the profile branch below: these are all `/users/…` paths too, and a
    // `includes("/users/")` test would otherwise answer a user body for every one of them.
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
        (options.friends ?? []).map((id) => ({ id, trustLevel: "trusted", status: "join me" })),
      listAll: () => [],
      // A live profile read writes back into presence; here there is nothing to write into, so it
      // reports no news and no event is emitted. The behaviour itself is tested in presence.test.ts,
      // against a real map — this double exists to answer `list`, not to reimplement the service.
      observe: () => false,
    } as unknown as PresenceService,
    settings: DEFAULT_SETTINGS,
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
  const GROUP_ID = "grp_ba913a96-fac4-4048-a062-9aa5db092812";

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

  test("the user batch is cache-first, sequential, and leaves the unreadable out", async () => {
    const h = harness();
    await resumeAll(h);

    // Warms `user_cache` for SUBJECT through the modal's own path.
    await h.deps.getUser(SUBJECT, VIEWER);
    const afterWarm = h.requests.filter((path) => path.includes("/users/")).length;

    const batch = await h.deps.listUsers([SUBJECT, "usr_other_one"], VIEWER);

    expect(batch.users.map((user) => user.id)).toEqual([SUBJECT, "usr_other_one"]);
    // The cached one cost nothing; only the second was fetched. One call, not two.
    expect(h.requests.filter((path) => path.endsWith(`/users/${SUBJECT}`)).length).toBe(1);
    expect(h.requests.filter((path) => path.includes("/users/")).length).toBe(afterWarm + 1);
    // And no represented-group fetch per head: that would double the most expensive path in the
    // app for a badge no roster row draws.
    expect(h.requests.filter((path) => path.endsWith("/groups/represented")).length).toBe(1);

    // The second call is served entirely from what the first wrote.
    const before = h.requests.length;
    const again = await h.deps.listUsers([SUBJECT, "usr_other_one"], VIEWER);
    expect(again.users).toHaveLength(2);
    expect(h.requests.length).toBe(before);
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
