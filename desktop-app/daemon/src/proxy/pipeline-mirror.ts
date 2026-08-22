import type { Scope } from "@vrcz/shared";
import type { PipelineEventType } from "../pipeline/index.ts";
import { DEAD_SESSION_ERROR, type DecodedPipelineEvent } from "../pipeline/index.ts";
import { containsRealCredential } from "./egress-filter.ts";

/**
 * The pipeline mirror. PLAN.md §Phase 2 "Pipeline mirror", §2.9.
 *
 * `wss://…:7774/?authToken=<proxy token>` speaking VRChat's own pipeline protocol, fed from the
 * daemon's **single real socket per account**. That last part is the whole point and the reason this
 * exists rather than telling apps to open their own: every extra socket against
 * `pipeline.vrchat.cloud` is another session against an undisclosed cap, and an app that connects
 * directly needs the real `auth` cookie, which it must never have.
 *
 * Three properties, in the order they matter:
 *
 *  - **Frames are re-emitted verbatim.** `DecodedPipelineEvent.frame` is the bytes as they arrived,
 *    so a client sees exactly what VRChat sent — including the three event types whose `content` is
 *    a bare id string or absent entirely, which is precisely where a rebuild would go wrong.
 *  - **Filtered by the grant's scopes**, per event type. An app granted only `friends:read` sees
 *    friend events and is not told that a notification happened.
 *  - **Scanned before forwarding.** VRChat's own error frame echoes the `authToken` it is
 *    complaining about, and that frame is on PLAN.md's leak table. Nothing carrying a real
 *    credential leaves this class, whatever it is.
 */

/**
 * The scope each event type needs.
 *
 * Complete by construction — the type is `Record<PipelineEventType, Scope>`, so a new event type
 * added to the pipeline fails to compile until someone decides what seeing it should cost. A
 * default would have quietly leaked whatever VRChat shipped next.
 *
 * `user-*` is `account:read` rather than `users:read` because those events are about the
 * authenticated user themself, not about some other user the app looked up.
 */
export const PIPELINE_EVENT_SCOPES: Record<PipelineEventType, Scope> = {
  notification: "notifications:read",
  "notification-v2": "notifications:read",
  "notification-v2-update": "notifications:read",
  "notification-v2-delete": "notifications:read",
  "response-notification": "notifications:read",
  "see-notification": "notifications:read",
  "hide-notification": "notifications:read",
  "clear-notification": "notifications:read",
  "friend-add": "friends:read",
  "friend-delete": "friends:read",
  "friend-online": "friends:read",
  "friend-active": "friends:read",
  "friend-offline": "friends:read",
  "friend-update": "friends:read",
  "friend-location": "friends:read",
  "user-update": "account:read",
  "user-location": "account:read",
  "user-badge-assigned": "account:read",
  "user-badge-unassigned": "account:read",
  "content-refresh": "system:read",
  "economy-update": "economy:read",
  "modified-image-update": "files:read",
  "instance-queue-joined": "instances:read",
  "instance-queue-ready": "instances:read",
  "group-joined": "groups:read",
  "group-left": "groups:read",
  "group-member-updated": "groups:read",
  "group-role-updated": "groups:read",
};

/** The socket, as this class needs it. Narrow so its tests need no server. */
export interface PipelineSink {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
}

interface Subscription {
  readonly scopes: ReadonlySet<Scope>;
  readonly sink: PipelineSink;
}

export interface PipelineMirrorOptions {
  /**
   * Called when a frame is withheld because it carried a real credential. Never receives the frame
   * — a reporter that printed it would recreate the leak in the log.
   */
  readonly onViolation?: (context: { accountId: string; type: PipelineEventType }) => void;
}

export class PipelineMirror {
  readonly #byAccount = new Map<string, Set<Subscription>>();
  readonly #options: PipelineMirrorOptions;

  constructor(options: PipelineMirrorOptions = {}) {
    this.#options = options;
  }

  /** Connected clients, across every account. The Connected apps page reads this. */
  get subscriberCount(): number {
    let total = 0;
    for (const set of this.#byAccount.values()) total += set.size;
    return total;
  }

  /** Attaches a client to one account's stream. The returned function detaches it. */
  subscribe(accountId: string, scopes: readonly Scope[], sink: PipelineSink): () => void {
    const subscription: Subscription = { scopes: new Set(scopes), sink };
    const existing = this.#byAccount.get(accountId);
    if (existing === undefined) this.#byAccount.set(accountId, new Set([subscription]));
    else existing.add(subscription);

    return () => {
      const set = this.#byAccount.get(accountId);
      if (set === undefined) return;
      set.delete(subscription);
      // Dropped rather than left empty, so a long-running daemon does not accumulate one entry per
      // account any app ever connected for.
      if (set.size === 0) this.#byAccount.delete(accountId);
    };
  }

  /** Fans one real pipeline event out to whoever is entitled to see it. */
  publish(accountId: string, event: DecodedPipelineEvent): void {
    const subscriptions = this.#byAccount.get(accountId);
    if (subscriptions === undefined || subscriptions.size === 0) return;

    // Scanned once for everyone rather than once per subscriber: the answer does not depend on who
    // is listening, and a frame carrying a real credential is withheld from all of them.
    if (containsRealCredential(event.frame)) {
      this.#options.onViolation?.({ accountId, type: event.type });
      return;
    }

    const required = PIPELINE_EVENT_SCOPES[event.type];
    for (const subscription of subscriptions) {
      if (!subscription.scopes.has(required)) continue;
      try {
        subscription.sink.send(event.frame);
      } catch {
        // A socket that died between the last read and this write is ordinary. It will be cleaned
        // up by its own close handler; one dead client must not stop the fan-out.
      }
    }
  }

  /** Closes every client of one account. The kill switch, and what revoking a grant reaches for. */
  disconnectAccount(accountId: string): void {
    const subscriptions = this.#byAccount.get(accountId);
    if (subscriptions === undefined) return;
    for (const subscription of subscriptions) {
      try {
        subscription.sink.close();
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    }
    this.#byAccount.delete(accountId);
  }
}

/**
 * The frame VRChat sends when a token is no longer backed by a session, minus what it echoes back.
 *
 * The real thing is `{"err":…,"authToken":"…","ip":"…"}`. **Both extra fields are dropped**: the
 * token is the credential itself, and the IP is the user's. A client only ever branches on `err`,
 * which is why the mirror can be honest here and lossless at the same time.
 */
export function deadSessionFrame(): string {
  return JSON.stringify({ err: DEAD_SESSION_ERROR });
}

/**
 * The proxy token out of a pipeline handshake, or null.
 *
 * Three spellings because three are in use. VRChat documents `authToken`; **VRCX sends `auth`**; and
 * a browser-based client cannot set a query string on a `WebSocket` it opens through a cookie jar,
 * so the cookie is accepted too. Accepting all three costs nothing and each of the other two is a
 * client that would otherwise fail at the handshake with no way to tell why.
 */
export function pipelineToken(url: string, cookieHeader: string | null): string | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }

  const fromQuery = params.get("authToken") ?? params.get("auth");
  if (fromQuery !== null && fromQuery !== "") return fromQuery;

  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "auth") {
      const value = part.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}
