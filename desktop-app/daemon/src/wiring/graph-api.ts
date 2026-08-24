/**
 * The one place a generated API node's request actually reaches VRChat.
 *
 * Everything that makes a request safe lives in `vrcFetch` and the account's own context: the
 * mandatory User-Agent, the three rate-limit buckets, the shared 429 breaker, the cookie jar, the
 * per-account meter. This adapter's whole job is to not go around any of it — which is the same
 * reason `graph-reads.ts` delegates to the control deps rather than fetching for itself.
 *
 * **Nothing touches VRChat except through an `Account`** (PLAN.md §Invariants), and a graph is no
 * exception. `requireOnlineAccount` is the same gate the social actions use: an account sitting on a
 * 2FA challenge has no auth cookie, and discovering that inside the request would trigger a re-auth
 * into a challenge nobody is watching.
 */

import type { AccountManager } from "../accounts/manager.ts";
import type { GraphApiCall } from "../graphs/builtins/api.ts";
import { vrcFetch } from "../net/request.ts";
import { requireOnlineAccount } from "./social-actions.ts";

/** How much of a response body is read back. A node output is not a place to store a file. */
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * The answer, parsed when it is JSON and kept as text when it is not.
 *
 * VRChat answers a few endpoints with a bare string or an empty body, and a node that threw on
 * those would make a whole class of operations unusable for a reason the author cannot act on.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await readCapped(response);
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * At most `MAX_RESPONSE_BYTES` of the body, and **only** that much off the wire.
 *
 * This used to be `(await response.text()).slice(...)`, which caps the node's output and nothing
 * else: `text()` buffers the whole body first, so the cap was a statement about what the graph saw
 * rather than about what the daemon held. A redirected host, or an endpoint answering with an error
 * page, could materialise hundreds of megabytes in a 50-80MB-idle process before a single byte was
 * thrown away. Reading through the stream and cancelling at the ceiling is the same cap, applied
 * where it is worth applying.
 *
 * A partial read is still a useful answer: a truncated body will not parse as JSON and comes back
 * as the text it is, which is what the caller does with anything unparseable anyway.
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      const room = MAX_RESPONSE_BYTES - bytes;
      if (value.byteLength >= room) {
        text += decoder.decode(value.subarray(0, room));
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // A body that stops mid-stream is not worth failing the node over on its own: the status is
    // what the caller acts on, and whatever arrived before the break is still the best answer there
    // is. `vrcFetch` has already dealt with anything that went wrong at the request level.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

export function createGraphApi(deps: { readonly accounts: AccountManager }): GraphApiCall {
  return async (accountId, request) => {
    const account = requireOnlineAccount(deps.accounts, accountId, "call the VRChat API");

    const query = new URLSearchParams(request.query).toString();
    const path = query === "" ? request.path : `${request.path}?${query}`;
    const hasBody = request.body !== undefined && request.method !== "GET";

    const response = await vrcFetch(account.context(), path, {
      method: request.method,
      ...(hasBody
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request.body),
          }
        : {}),
    });

    const data = await readBody(response);
    if (!response.ok) {
      /*
       * A throw rather than a status the graph has to check.
       *
       * The node has an `error` port and the run aborts by default, which together are the right
       * shape: an author who wants to handle a 404 wires the error onward, and one who does not
       * gets a `graph.run.failed` naming the node instead of a graph that carried on with `null`
       * where a user object should have been. The status is in the message because "it failed" and
       * "they have invites off" are different things to a person reading the feed.
       */
      const excerpt = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(
        `VRChat answered ${String(response.status)}${
          excerpt === undefined || excerpt === "null" ? "" : `: ${excerpt.slice(0, 200)}`
        }`,
      );
    }

    return { status: response.status, data };
  };
}
