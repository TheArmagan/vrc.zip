/**
 * A stand-in VRChat, for taking pictures against.
 *
 * ## Why this is not `daemon/src/testing/vrchat-fixture.ts`
 *
 * That one models the *awkward* parts of VRChat's HTTP — folded `Set-Cookie`, a `oneOf` on
 * `/auth/user`, an empty 401 body — because the bugs it exists to catch are HTTP-level. It answers
 * five routes and its friend list is two rows, which is right for an assertion and useless for a
 * screenshot.
 *
 * This one is the other half of the trade: the same auth handshake (copied deliberately, because the
 * daemon depends on the pre-2FA `auth` cookie and would not sign in without it), and then breadth —
 * friends, users, worlds, instances, notifications, and a live socket pushing a few frames so the
 * feed has something in it that the daemon derived rather than something written into its database.
 *
 * **Nothing here is a fidelity claim.** If a shape is wrong, the picture is wrong and no test fails.
 * That is an acceptable trade for a docs tool and would not be for a test double, which is exactly
 * why the two are separate files.
 *
 * ## The pipeline socket
 *
 * `startDaemon({ pipelineUrl })` already exists for the integration tests, so the socket is the
 * cheapest way to make the *feed* real: the daemon normalises each frame onto its bus, the feed
 * writer persists it, and the screenshot shows the app's own rendering of an event it processed
 * rather than a row somebody forged in SQLite.
 */

import type { ServerWebSocket } from "bun";
import {
  ACCOUNTS,
  type DemoAccount,
  type Evening,
  FRIENDS,
  NOTIFICATIONS,
  TWO_FACTOR_CODE,
  trustTag,
  WORLDS,
} from "./demo.ts";

export interface VrchatStub {
  /** What to pass as `baseUrl`. Includes the `/api/1` prefix VRChat serves everything under. */
  readonly baseUrl: string;
  /** What to pass as `pipelineUrl`. */
  readonly pipelineUrl: string;
  /** Pushes the evening's live events down the socket, once a client is attached. */
  pushEvents(at: Evening): Promise<void>;
  stop(): void;
}

interface Session {
  readonly account: DemoAccount;
  twoFactorSatisfied: boolean;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function cookiesFrom(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (header === null) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

export function startVrchatStub(): VrchatStub {
  const sessions = new Map<string, Session>();
  const trusted = new Set<string>();
  const sockets = new Set<ServerWebSocket<unknown>>();
  let counter = 0;

  const sessionFor = (request: Request): Session | undefined => {
    const token = cookiesFrom(request.headers.get("cookie")).get("auth");
    return token === undefined ? undefined : sessions.get(token);
  };

  const currentUser = (account: DemoAccount): Record<string, unknown> => ({
    id: account.id,
    displayName: account.displayName,
    username: account.username,
    bio: "",
    currentAvatarImageUrl: "",
    profilePicOverride: "",
    userIcon: "",
    state: "online",
    status: "active",
    statusDescription: "",
    // Enough of a VRC+ entitlement to draw the favourite and invite-slot counts honestly. The app
    // enforces limits against what the account really has (PLAN.md §Guardrails), so a demo account
    // with no tags would render every one of those as the free tier.
    tags: ["system_trust_veteran", "system_supporter"],
    friends: FRIENDS.map((friend) => friend.id),
  });

  const friendBody = (id: string): Record<string, unknown> | null => {
    const friend = FRIENDS.find((entry) => entry.id === id);
    if (friend === undefined) return null;
    return {
      id: friend.id,
      displayName: friend.displayName,
      status: friend.status,
      statusDescription: friend.statusDescription,
      location: friend.location,
      // A friend's location is repeated here because VRChat does the same, and the app reads
      // whichever it finds — a stub that filled only one of them would exercise a path the real
      // API never takes.
      worldId: friend.location.split(":")[0] ?? "",
      tags: [trustTag(friend.trust)],
      platform: friend.platform,
      userIcon: "",
      profilePicOverride: "",
      currentAvatarImageUrl: "",
      currentAvatarThumbnailImageUrl: "",
      isFriend: true,
      bio: friend.statusDescription,
      last_login: "",
      last_platform: friend.platform,
    };
  };

  const server = Bun.serve({
    port: 0,
    fetch(request, upgraded) {
      const url = new URL(request.url);
      if (url.pathname === "/pipeline") {
        return upgraded.upgrade(request) ? undefined : new Response("no", { status: 400 });
      }
      const path = url.pathname.replace(/^\/api\/1/, "");

      // Modelled because the daemon must never lose it: a missing User-Agent is a 403 on every
      // route, on the socket handshake too.
      const ua = request.headers.get("user-agent");
      if (ua === null || ua.trim() === "") {
        return json(
          { error: { message: "Forbidden", status_code: 403, waf_code: 13799 } },
          {
            status: 403,
          },
        );
      }

      /* -- auth ------------------------------------------------------------------------------- */

      if (path === "/auth/user" && request.method === "GET") {
        const authorization = request.headers.get("authorization");
        if (authorization?.startsWith("Basic ") === true) {
          const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
          const split = decoded.indexOf(":");
          const username = decodeURIComponent(decoded.slice(0, split));
          const password = decodeURIComponent(decoded.slice(split + 1));
          const account = ACCOUNTS.find(
            (entry) => entry.username === username && entry.password === password,
          );
          if (account === undefined) {
            return json(
              { error: { message: "Invalid Username or Password", status_code: 401 } },
              {
                status: 401,
              },
            );
          }
          const deviceTrusted = trusted.has(
            cookiesFrom(request.headers.get("cookie")).get("twoFactorAuth") ?? "",
          );
          const needs = account.twoFactor && !deviceTrusted;
          counter += 1;
          const token = `authcookie_${account.id}_${String(counter)}`;
          sessions.set(token, { account, twoFactorSatisfied: !needs });
          const headers = { "set-cookie": `auth=${token}; Path=/; HttpOnly` };
          return needs
            ? json({ requiresTwoFactorAuth: ["totp"] }, { headers })
            : json(currentUser(account), { headers });
        }
        const session = sessionFor(request);
        if (session === undefined) {
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            {
              status: 401,
            },
          );
        }
        if (!session.twoFactorSatisfied) return json({ requiresTwoFactorAuth: ["totp"] });
        return json(currentUser(session.account));
      }

      if (path === "/auth" && request.method === "GET") {
        const session = sessionFor(request);
        if (session?.twoFactorSatisfied !== true) {
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            {
              status: 401,
            },
          );
        }
        return json({ ok: true, token: "authcookie_stub" });
      }

      if (/^\/auth\/twofactorauth\/(totp|emailotp|otp)\/verify$/.test(path)) {
        const session = sessionFor(request);
        if (session === undefined) {
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            {
              status: 401,
            },
          );
        }
        return request
          .json()
          .then((body) => {
            if ((body as { code?: string }).code !== TWO_FACTOR_CODE) {
              return json({ verified: false });
            }
            session.twoFactorSatisfied = true;
            const device = `tfa_${session.account.id}`;
            trusted.add(device);
            return json(
              { verified: true },
              { headers: { "set-cookie": `twoFactorAuth=${device}; Max-Age=2592000; Path=/` } },
            );
          })
          .catch(() => json({ verified: false }));
      }

      /* -- the read surface the screens need ---------------------------------------------------- */

      const session = sessionFor(request);
      if (session?.twoFactorSatisfied !== true) {
        return json(
          { error: { message: "Missing Credentials", status_code: 401 } },
          {
            status: 401,
          },
        );
      }

      if (path === "/auth/user/friends") {
        // `offline` is a filter and not a field: one pass returns half the list. Modelled because
        // the app fetches both halves, and a stub that ignored it would show every friend twice.
        const wantOffline = url.searchParams.get("offline") === "true";
        const rows = FRIENDS.filter((friend) => (friend.location === "offline") === wantOffline);
        return json(rows.map((friend) => friendBody(friend.id)));
      }

      if (path === "/auth/user/notifications") {
        return json(
          NOTIFICATIONS.map((notification) => ({
            id: notification.id,
            type: notification.type,
            senderUserId: notification.senderId,
            senderUsername: notification.senderName,
            message: notification.message,
            details: "{}",
            seen: notification.seen,
            // The API's own format. The daemon parses it back to unix ms, so an ISO string here is
            // the honest shape rather than a convenience.
            created_at: new Date(Date.now() - notification.minutesAgo * 60_000).toISOString(),
          })),
        );
      }

      const userMatch = /^\/users\/(usr_[\w-]+)$/.exec(path);
      if (userMatch !== null) {
        const id = userMatch[1] ?? "";
        const body = friendBody(id);
        if (body !== null) return json(body);
        const account = ACCOUNTS.find((entry) => entry.id === id);
        if (account !== undefined) return json(currentUser(account));
        return json({ error: { message: "Not Found", status_code: 404 } }, { status: 404 });
      }

      const worldMatch = /^\/worlds\/(wrld_[\w-]+)$/.exec(path);
      if (worldMatch !== null) {
        const world = WORLDS.find((entry) => entry.id === worldMatch[1]);
        if (world === undefined) {
          return json({ error: { message: "Not Found", status_code: 404 } }, { status: 404 });
        }
        return json({
          id: world.id,
          name: world.name,
          authorName: world.authorName,
          authorId: `usr_author_${world.id.slice(5, 13)}`,
          capacity: world.capacity,
          recommendedCapacity: Math.floor(world.capacity / 2),
          description: "",
          imageUrl: "",
          thumbnailImageUrl: "",
          favorites: 0,
          visits: 0,
          tags: [],
        });
      }

      const instanceMatch = /^\/instances\/(wrld_[\w-]+):(.+)$/.exec(path);
      if (instanceMatch !== null) {
        const world = WORLDS.find((entry) => entry.id === instanceMatch[1]);
        const here = FRIENDS.filter((friend) => friend.location.startsWith(`${instanceMatch[1]}:`));
        return json({
          id: `${instanceMatch[1] ?? ""}:${instanceMatch[2] ?? ""}`,
          worldId: instanceMatch[1],
          instanceId: instanceMatch[2],
          type: "friends",
          region: /region\((\w+)\)/.exec(instanceMatch[2] ?? "")?.[1] ?? "eu",
          n_users: here.length,
          capacity: world?.capacity ?? 16,
          full: false,
          active: true,
          world: world === undefined ? undefined : { id: world.id, name: world.name },
        });
      }

      // Everything else 404s rather than being invented on the fly. A screen that quietly renders a
      // made-up shape is a screenshot that documents something the app does not do.
      return json({ error: { message: "Not Found", status_code: 404 } }, { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message() {
        // The pipeline is push-only. A client that sends something is not something to model.
      },
    },
  });

  /**
   * Pushes one frame down **one** socket.
   *
   * Real VRChat would push a shared friend's presence to every account that is friends with them,
   * and the daemon would correctly record one event per account — which is right, and which makes a
   * screenshot of the feed read as if every event happened twice. A picture is a bad place to
   * demonstrate a subtlety that needs a paragraph, so the demo gives each frame one owner.
   */
  const push = (type: string, content: unknown): void => {
    const frame = JSON.stringify({ type, content: JSON.stringify(content) });
    const first = [...sockets][0];
    first?.send(frame);
  };

  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}/api/1`,
    pipelineUrl: `ws://127.0.0.1:${String(server.port)}/pipeline`,
    async pushEvents(at: Evening): Promise<void> {
      // Spaced out rather than fired at once: the feed groups by minute, and forty rows sharing one
      // timestamp renders as one block instead of an evening.
      const script: { type: string; content: unknown }[] = [
        {
          type: "friend-online",
          content: { userId: FRIENDS[0]?.id, user: friendBody(FRIENDS[0]?.id ?? "") },
        },
        {
          type: "friend-location",
          content: {
            userId: FRIENDS[2]?.id,
            location: FRIENDS[2]?.location,
            worldId: FRIENDS[2]?.location.split(":")[0],
            user: friendBody(FRIENDS[2]?.id ?? ""),
          },
        },
        {
          type: "friend-online",
          content: { userId: FRIENDS[5]?.id, user: friendBody(FRIENDS[5]?.id ?? "") },
        },
        {
          type: "friend-location",
          content: {
            userId: FRIENDS[6]?.id,
            location: FRIENDS[6]?.location,
            worldId: FRIENDS[6]?.location.split(":")[0],
            user: friendBody(FRIENDS[6]?.id ?? ""),
          },
        },
        { type: "friend-offline", content: { userId: FRIENDS[9]?.id } },
        {
          type: "friend-online",
          content: { userId: FRIENDS[1]?.id, user: friendBody(FRIENDS[1]?.id ?? "") },
        },
      ];
      void at;
      for (const frame of script) {
        push(frame.type, frame.content);
        await Bun.sleep(120);
      }
    },
    stop(): void {
      server.stop(true);
    },
  };
}
