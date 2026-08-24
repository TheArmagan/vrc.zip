import { describe, expect, test } from "bun:test";
import { API_OPERATIONS } from "@vrcz/api/operations";
import { assignable, validateNodeDefinition } from "@vrcz/plugin-api/nodes";
import { EventBus } from "../../bus/event-bus.ts";
import {
  buildBody,
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

  test("a path parameter is a plain string port, and takes a typed id anyway", () => {
    // It used to be a `user`, and that refused every id a graph had actually computed — a raw
    // endpoint is where you end up holding a string. `user` still flows in, because rule 4 of the
    // lattice says an id is a string, so nothing that worked before stopped working.
    expect(getUser).toBeDefined();
    if (getUser === undefined) return;
    const definition = definitionFor(getUser);
    const inputs = "inputs" in definition ? definition.inputs : [];
    expect(inputs.map((port) => [port.id, port.type])).toEqual([["userId", "string"]]);
    expect(assignable("user", "string")).toBe(true);
    expect(assignable("string", "string")).toBe(true);
  });

  test("a path parameter is also a box, and neither half is marked required", () => {
    // Required moved from the port to the run: `pathIsComplete` accepts a value from either half,
    // and a port marked required beside a box that satisfies it would be a lie on the canvas.
    if (getUser === undefined) return;
    const definition = definitionFor(getUser);
    const inputs = "inputs" in definition ? definition.inputs : [];
    expect(inputs[0]?.required).toBeUndefined();
    const field = (definition.config ?? []).find((entry) => entry.id === "userId");
    expect(field?.kind).toBe("text");
  });

  test("every operation can be filled in without wiring anything", () => {
    // The property the whole change is for, asserted across all 286 rather than on one endpoint:
    // every path parameter and every body has somewhere to type a value.
    const problems: string[] = [];
    for (const operation of API_OPERATIONS) {
      const definition = definitionFor(operation);
      const ids = new Set((definition.config ?? []).map((field) => field.id));
      for (const param of operation.params) {
        if (param.in === "path" && !ids.has(param.name)) {
          problems.push(`${operation.operationId}: no box for ${param.name}`);
        }
      }
      if (operation.hasBody && !ids.has("body")) {
        problems.push(`${operation.operationId}: no box for the body`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("no node has two config fields writing to the same key", () => {
    // Path, body and query all land in one config object now, so a name shared across two of them
    // would be two boxes fighting over one value. None collide today; a spec bump is the risk.
    const problems: string[] = [];
    for (const operation of API_OPERATIONS) {
      const ids = (definitionFor(operation).config ?? []).map((field) => field.id);
      if (new Set(ids).size !== ids.length) problems.push(operation.operationId);
    }
    expect(problems).toEqual([]);
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

  test("port types follow the spec's own type and nothing cleverer", () => {
    // The id-name mapping is gone. What it bought was a check these nodes never needed, and what it
    // cost was every string id being refused at the port that most often receives one.
    const param = { required: true, description: "", enumValues: [], defaultValue: null } as const;
    expect(portTypeFor({ ...param, name: "userId", in: "path", type: "string" })).toBe("string");
    expect(portTypeFor({ ...param, name: "worldId", in: "path", type: "string" })).toBe("string");
    expect(portTypeFor({ ...param, name: "printId", in: "path", type: "string" })).toBe("string");
    expect(portTypeFor({ ...param, name: "n", in: "query", type: "number" })).toBe("number");
  });

  test("the box still hints at what kind of id it wants", () => {
    // The one thing the name mapping was good for, kept where it is actually read: an empty box
    // beside "Must be a valid user ID" says nothing about what a user id looks like.
    const withWorld = API_OPERATIONS.find((operation) =>
      operation.params.some((param) => param.in === "path" && param.name === "worldId"),
    );
    if (withWorld === undefined) return;
    const field = (definitionFor(withWorld).config ?? []).find((entry) => entry.id === "worldId");
    expect(field?.kind === "text" ? field.placeholder : "").toBe("wrld_…");
  });
});

describe("building a request", () => {
  const getUser = API_OPERATIONS.find((operation) => operation.operationId === "getUser");

  test("path parameters are substituted and encoded", () => {
    if (getUser === undefined) return;
    expect(buildPath(getUser, { userId: "usr_a b" }, {})).toBe("/users/usr_a%20b");
  });

  test("the wire wins over the box, and a blank wire is not a wire", () => {
    // The same rule the id literals follow: a `Read field` that found nothing must not blank a
    // value the author typed in and can see on the canvas.
    if (getUser === undefined) return;
    expect(buildPath(getUser, { userId: "usr_wired" }, { userId: "usr_typed" })).toBe(
      "/users/usr_wired",
    );
    expect(buildPath(getUser, {}, { userId: "usr_typed" })).toBe("/users/usr_typed");
    expect(buildPath(getUser, { userId: "  " }, { userId: "usr_typed" })).toBe("/users/usr_typed");
  });

  test("an unfilled path parameter is caught before the call", () => {
    // `/users//friendStatus` would either 404 or, worse, reach a different endpoint than the one
    // the author drew on the canvas.
    if (getUser === undefined) return;
    expect(pathIsComplete(getUser, { userId: "usr_a" }, {})).toBe(true);
    // Either half satisfies it, which is the whole point of the box existing.
    expect(pathIsComplete(getUser, {}, { userId: "usr_a" })).toBe(true);
    expect(pathIsComplete(getUser, {}, {})).toBe(false);
    expect(pathIsComplete(getUser, { userId: "" }, {})).toBe(false);
  });

  test("a body comes off the port, then out of the box, and bad JSON is a sentence", () => {
    const withBody = API_OPERATIONS.find((operation) => operation.operationId === "addFavorite");
    expect(withBody).toBeDefined();
    if (withBody === undefined) return;
    expect(buildBody(withBody, { body: { a: 1 } }, { body: '{"b":2}' })).toEqual({ a: 1 });
    expect(buildBody(withBody, {}, { body: '{"b":2}' })).toEqual({ b: 2 });
    expect(buildBody(withBody, {}, {})).toBeUndefined();
    // Thrown rather than gated, unlike `JSON value`: the body is the thing this node exists to
    // send, so calling VRChat without it would be a worse answer than a sentence on the error port.
    expect(() => buildBody(withBody, {}, { body: "{ oops" })).toThrow(/not valid JSON/);
    // An operation with no body ignores both halves rather than inventing one.
    if (getUser !== undefined) expect(buildBody(getUser, { body: { a: 1 } }, {})).toBeUndefined();
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

  test("a path typed into the box calls VRChat with nothing wired at all", async () => {
    const h = harness();
    const result = await h.nodes.execute(
      "vrcz/api-get-user",
      {},
      { userId: "usr_typed" },
      { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: false, accountId: "usr_me" },
    );
    expect(result).toEqual({ result: { ok: true }, status: 200 });
    expect(h.calls[0]?.request.path).toBe("/users/usr_typed");
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
