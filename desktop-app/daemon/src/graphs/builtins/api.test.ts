import { describe, expect, test } from "bun:test";
import { API_OPERATIONS } from "@vrcz/api/operations";
import { validateNodeDefinition } from "@vrcz/plugin-api/nodes";
import { EventBus } from "../../bus/event-bus.ts";
import {
  buildPath,
  buildQuery,
  definitionFor,
  type GraphApiRequest,
  nodeIdFor,
  nodeTitleFor,
  pathIsComplete,
  portTypeFor,
  titleFor,
} from "./api.ts";
import { createBuiltinNodes } from "./index.ts";

/**
 * The generated half of the palette.
 *
 * Nothing here asserts a *particular* endpoint beyond a couple of well-known ones — the catalogue
 * is regenerated from the spec, and a test naming forty operation ids would break on the next bump
 * for no reason. What it does assert is that **every** generated definition is valid, which is the
 * property that matters when 286 of them are produced by a loop nobody reads the output of.
 */

const T0 = 1_700_000_000_000;

function harness() {
  const calls: { accountId: string; request: GraphApiRequest }[] = [];
  const nodes = createBuiltinNodes({
    bus: new EventBus(),
    now: () => T0,
    api: async (accountId, request) => {
      calls.push({ accountId, request });
      return await Promise.resolve({ status: 200, data: { ok: true } });
    },
  });
  return { calls, nodes };
}

describe("the catalogue", () => {
  test("covers most of the spec, and excludes what a graph must not do", () => {
    expect(API_OPERATIONS.length).toBeGreaterThan(250);
    const ids = new Set(API_OPERATIONS.map((operation) => operation.operationId));

    // The hard-denied three, denied on every port by definition.
    expect(ids.has("deleteUser")).toBe(false);
    expect(ids.has("disable2FA")).toBe(false);
    expect(ids.has("registerUserAccount")).toBe(false);
    // Session frugality is an invariant, not a preference: every sign-in mints a session against an
    // undisclosed cap, so nothing in this app logs out — least of all an automation.
    expect(ids.has("logout")).toBe(false);
    // Credentials are the daemon's business with the user.
    expect(ids.has("verify2FA")).toBe(false);
    expect(ids.has("getRecoveryCodes")).toBe(false);

    // And the ordinary things are all there.
    expect(ids.has("getUser")).toBe(true);
    expect(ids.has("unfriend")).toBe(true);
    expect(ids.has("searchGroups")).toBe(true);
    expect(ids.has("searchAvatars")).toBe(true);
  });

  test("every generated definition is valid", () => {
    // The one assertion that earns its place at this scale: 286 definitions come out of a loop, and
    // a single malformed one would be refused at registration with nobody watching.
    const problems: string[] = [];
    for (const operation of API_OPERATIONS) {
      const result = validateNodeDefinition(definitionFor(operation));
      if (!result.ok) {
        problems.push(`${operation.operationId}: ${result.issues.map((i) => i.path).join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("every generated node id and title is unique", () => {
    const definitions = API_OPERATIONS.map(definitionFor);
    const ids = definitions.map((definition) => definition.id);
    const titles = definitions.map((definition) => definition.title);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("the generated shape", () => {
  const getUser = API_OPERATIONS.find((operation) => operation.operationId === "getUser");

  test("a path parameter is a typed input, not a string", () => {
    // `userId` is a `user`, which is the difference between an edge the lattice checks and one it
    // waves through.
    expect(getUser).toBeDefined();
    if (getUser === undefined) return;
    const definition = definitionFor(getUser);
    const inputs = "inputs" in definition ? definition.inputs : [];
    expect(inputs.map((port) => [port.id, port.type])).toEqual([["userId", "user"]]);
  });

  test("titles are humanised and suffixed", () => {
    expect(titleFor("getUser")).toBe("Get user");
    expect(titleFor("acceptFriendRequest")).toBe("Accept friend request");
    // The suffix is what stops a generated node colliding with a curated one — `boop` and `Boop`
    // did exactly that.
    expect(nodeTitleFor("boop")).toBe("Boop (API)");
    // Ids are lowercase and hyphenated because `validateNodeDefinition` refuses anything else,
    // and prefixed because `get-user` is already a curated node.
    expect(nodeIdFor("getUser")).toBe("api-get-user");
    expect(nodeIdFor("acceptFriendRequest")).toBe("api-accept-friend-request");
  });

  test("a query parameter becomes config, with the spec's own default", () => {
    const paged = API_OPERATIONS.find((operation) =>
      operation.params.some((param) => param.in === "query" && param.name === "n"),
    );
    expect(paged).toBeDefined();
    if (paged === undefined) return;
    const config = definitionFor(paged).config ?? [];
    expect(config.some((field) => field.id === "n")).toBe(true);
  });

  test("port types are mapped by the id's name", () => {
    const param = { required: true, description: "", enumValues: [], defaultValue: null } as const;
    expect(portTypeFor({ ...param, name: "userId", in: "path", type: "string" })).toBe("user");
    expect(portTypeFor({ ...param, name: "worldId", in: "path", type: "string" })).toBe("world");
    expect(portTypeFor({ ...param, name: "printId", in: "path", type: "string" })).toBe("string");
    expect(portTypeFor({ ...param, name: "n", in: "query", type: "number" })).toBe("number");
  });
});

describe("building a request", () => {
  const getUser = API_OPERATIONS.find((operation) => operation.operationId === "getUser");

  test("path parameters are substituted and encoded", () => {
    if (getUser === undefined) return;
    expect(buildPath(getUser, { userId: "usr_a b" })).toBe("/users/usr_a%20b");
  });

  test("an unfilled path parameter is caught before the call", () => {
    // `/users//friendStatus` would either 404 or, worse, reach a different endpoint than the one
    // the author drew on the canvas.
    if (getUser === undefined) return;
    expect(pathIsComplete(getUser, { userId: "usr_a" })).toBe(true);
    expect(pathIsComplete(getUser, {})).toBe(false);
    expect(pathIsComplete(getUser, { userId: "" })).toBe(false);
  });

  test("a blank config field is absent from the query rather than empty", () => {
    const paged = API_OPERATIONS.find((operation) =>
      operation.params.some((param) => param.in === "query" && param.name === "n"),
    );
    if (paged === undefined) return;
    expect(buildQuery(paged, { n: 10 })).toEqual({ n: "10" });
    expect(buildQuery(paged, { n: "" })).toEqual({});
  });
});

describe("executing", () => {
  test("a GET reaches VRChat and hands back the body and the status", async () => {
    const h = harness();
    const result = await h.nodes.execute(
      "vrcz/api-get-user",
      { userId: "usr_a" },
      {},
      { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: false, accountId: "usr_me" },
    );
    expect(result).toEqual({ result: { ok: true }, status: 200 });
    expect(h.calls[0]?.request).toMatchObject({ method: "GET", path: "/users/usr_a" });
    expect(h.calls[0]?.accountId).toBe("usr_me");
  });

  test("a read still runs in a rehearsal; a write does not", async () => {
    // Dry-run exists to stop a graph *reaching other people* before it is armed. A GET reaches
    // nobody, and suppressing it would leave every node downstream with no data — turning the
    // rehearsal into a test of a different graph than the one being armed.
    const h = harness();
    const context = { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: true, accountId: "usr_me" };

    await h.nodes.execute("vrcz/api-get-user", { userId: "usr_a" }, {}, context);
    expect(h.calls).toHaveLength(1);

    const wrote = await h.nodes.execute("vrcz/api-unfriend", { userId: "usr_a" }, {}, context);
    expect(wrote).toEqual({ status: 0 });
    expect(h.calls).toHaveLength(1);
  });

  test("a missing path parameter produces nothing rather than calling a wrong URL", async () => {
    const h = harness();
    const result = await h.nodes.execute(
      "vrcz/api-get-user",
      {},
      {},
      { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: false, accountId: "usr_me" },
    );
    expect(result).toEqual({});
    expect(h.calls).toEqual([]);
  });

  test("a graph with no account says so", async () => {
    const h = harness();
    await expect(
      h.nodes.execute(
        "vrcz/api-get-user",
        { userId: "usr_a" },
        {},
        { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: false, accountId: null },
      ),
    ).rejects.toThrow(/No account is set/);
  });

  test("a daemon built without the seam fails with a sentence rather than hiding the node", async () => {
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    expect(nodes.has("vrcz/api-get-user")).toBe(true);
    await expect(
      nodes.execute(
        "vrcz/api-get-user",
        { userId: "usr_a" },
        {},
        { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: false, accountId: "usr_me" },
      ),
    ).rejects.toThrow(/cannot call VRChat/);
  });
});
