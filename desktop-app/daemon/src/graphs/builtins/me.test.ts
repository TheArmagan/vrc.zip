/**
 * The Me nodes, at the level the family is actually at risk.
 *
 * Deliberately **thin**: every definition validates and lands in the palette, every write rehearses
 * without touching the seam, and the two nodes that fail on purpose fail with a sentence. The HTTP
 * shape of each call is `wiring/self-actions.ts`'s to get right and it is one `vrcFetch` per method
 * with no branching in it; what is easy to break here is a definition that will not register, a
 * dry-run branch somebody forgot, and a node that silently acts as the wrong account.
 */

import { describe, expect, test } from "bun:test";
import { validateNodeDefinition } from "@vrcz/plugin-api/nodes";
import { EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import { type GraphSelf, ME_CATEGORY, meNodes, trustFromTags } from "./me.ts";

const ACCOUNT = "acc_1";
const GRAPH = "gph_1";

function context(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    graphId: GRAPH,
    runId: "run_1",
    nodeId: "n1",
    dryRun: false,
    accountId: ACCOUNT,
    ...overrides,
  };
}

/**
 * A seam whose every *write* throws, and whose reads answer.
 *
 * That split is what makes the dry-run assertions mean something: a node that forgot its rehearsal
 * branch does not quietly pass, it fails loudly on the first call. The reads answer because they
 * are supposed to run in a rehearsal, and because `Go invisible` legitimately reads the status it
 * is about to replace before deciding it is only rehearsing.
 */
function refusingSelf(): GraphSelf {
  const refuse = (): never => {
    throw new Error("the seam was called");
  };
  return new Proxy({} as GraphSelf, {
    get: (_target, property) => {
      if (property === "gameState") return () => ({ running: false, platform: "", location: "" });
      if (property === "accounts") return () => [];
      if (property === "me") return async () => await Promise.resolve({ status: "active" });
      return refuse;
    },
  });
}

function memory() {
  const rows = new Map<string, { value: string; updatedAt: number }>();
  return {
    rows,
    get: (graphId: string, nodeId: string, key: string) =>
      rows.get(`${graphId}:${nodeId}:${key}`) ?? null,
    put: (graphId: string, nodeId: string, key: string, value: string, now: number) => {
      rows.set(`${graphId}:${nodeId}:${key}`, { value, updatedAt: now });
    },
  };
}

function build(self?: GraphSelf) {
  const bus = new EventBus();
  const notes: string[] = [];
  bus.subscribe((event) => {
    if (event.kind === "graph.note") {
      const payload = event.payload as { note?: unknown };
      if (typeof payload.note === "string") notes.push(payload.note);
    }
  });
  const nodes = meNodes({
    bus,
    ...(self === undefined ? {} : { self }),
    memory: memory(),
    launch: async () => await Promise.resolve(true),
    now: () => 1_000,
  });
  return { bus, notes, nodes };
}

describe("the Me node set", () => {
  test("every definition validates and sits in the Me category", () => {
    const { nodes } = build(refusingSelf());
    expect(nodes.length).toBeGreaterThan(25);

    for (const node of nodes) {
      const result = validateNodeDefinition(node.definition);
      expect(result.ok, `${node.definition.id}: ${JSON.stringify(result)}`).toBe(true);
      // `My accounts` is the one node with no account picker, because it is a question *about* the
      // accounts rather than one asked as any of them.
      if (node.definition.id !== "my-accounts" && node.definition.id !== "show-in-vrchat") {
        expect(node.definition.config?.some((field) => field.id === "accountId")).toBe(true);
      }
      expect(node.definition.category).toBe(ME_CATEGORY);
    }
  });

  test("node ids are unique", () => {
    const { nodes } = build(refusingSelf());
    const ids = nodes.map((node) => node.definition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the account picker is the picker kind, not a text box", () => {
    const { nodes } = build(refusingSelf());
    const fields = nodes.flatMap((node) =>
      (node.definition.config ?? []).filter((field) => field.id === "accountId"),
    );
    expect(fields.length).toBeGreaterThan(20);
    for (const field of fields) expect(field.kind).toBe("account");
  });
});

describe("dry run", () => {
  /**
   * The whole family rehearsed in one pass.
   *
   * Every node is executed against a seam that throws on contact, so a missing dry-run branch shows
   * up as a thrown "the seam was called" rather than as a quietly missing assertion. The reads are
   * excluded by name because they are *supposed* to run in a rehearsal — see the file header.
   */
  const READS = new Set([
    "me",
    "my-account",
    "my-accounts",
    "my-game",
    "my-notifications",
    "my-groups",
    // Not a read, but it settles before it gets as far as rehearsing: with nothing remembered there
    // is no write to describe. Its own test below covers that.
    "restore-status",
  ]);

  test("no write touches the seam, and each leaves a note", async () => {
    const { nodes, notes } = build(refusingSelf());

    for (const node of nodes) {
      if (READS.has(node.definition.id) || node.execute === undefined) continue;
      const before = notes.length;
      await node.execute(
        {
          user: "usr_1",
          target: "wrld_1",
          group: "grp_1",
          instance: "wrld_1:12345",
          notification: "not_1",
          text: "hello",
          pronouns: "they/them",
          bio: "hi",
          message: "brb",
        },
        {},
        context({ dryRun: true, nodeId: node.definition.id }),
      );
      expect(notes.length, `${node.definition.id} left no note`).toBeGreaterThan(before);
    }
  });

  test("a rehearsed write reports that it did not happen", async () => {
    const { nodes } = build(refusingSelf());
    const block = nodes.find((node) => node.definition.id === "block");
    const outputs = await block?.execute?.({ user: "usr_1" }, {}, context({ dryRun: true }));
    expect(outputs).toEqual({ done: false });
  });
});

describe("choosing the account", () => {
  test("the picker wins over the graph's account", async () => {
    const seen: string[] = [];
    const { nodes } = build({
      ...refusingSelf(),
      unfriend: async (accountId) => {
        seen.push(accountId);
        await Promise.resolve();
      },
    });
    const unfriend = nodes.find((node) => node.definition.id === "unfriend");
    await unfriend?.execute?.({ user: "usr_1" }, { accountId: "acc_2" }, context());
    await unfriend?.execute?.({ user: "usr_1" }, {}, context());
    expect(seen).toEqual(["acc_2", ACCOUNT]);
  });

  test("no account anywhere is a sentence, not a guess", async () => {
    const { nodes } = build(refusingSelf());
    const unfriend = nodes.find((node) => node.definition.id === "unfriend");
    expect(
      unfriend?.execute?.({ user: "usr_1" }, {}, context({ accountId: null })),
    ).rejects.toThrow(/No account is set/);
  });
});

describe("nodes with nothing behind them", () => {
  test("a daemon with no seam says so rather than failing on a null", () => {
    const { nodes } = build();
    const me = nodes.find((node) => node.definition.id === "me");
    expect(me?.execute?.({}, {}, context())).rejects.toThrow(/cannot act on your VRChat account/);
  });

  test("Set my status with neither half set changes nothing and calls nothing", async () => {
    const { nodes } = build(refusingSelf());
    const status = nodes.find((node) => node.definition.id === "set-status");
    expect(await status?.execute?.({}, {}, context())).toEqual({ set: false });
  });

  test("Put my status back with nothing remembered is an answer, not an error", async () => {
    const { nodes } = build(refusingSelf());
    const restore = nodes.find((node) => node.definition.id === "restore-status");
    expect(await restore?.execute?.({}, {}, context())).toEqual({ status: "", set: false });
  });
});

describe("trustFromTags", () => {
  test("takes the highest rank, and defaults to visitor", () => {
    // Ordered tags: a trusted user holds every rank below theirs, so the first match must win.
    expect(
      trustFromTags(["system_trust_basic", "system_trust_known", "system_trust_veteran"]),
    ).toBe("trusted");
    expect(trustFromTags(["system_trust_basic"])).toBe("new");
    expect(trustFromTags([])).toBe("visitor");
  });
});
