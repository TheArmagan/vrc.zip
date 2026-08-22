import { describe, expect, test } from "bun:test";
import type { PluginManifest } from "@vrcz/plugin-api";
import { narrowToRequest, PluginConsentBroker } from "./consent.ts";

const NOW = 1_760_000_000_000;

function brokerOf(options: { timeoutMs?: number } = {}) {
  const seen: string[] = [];
  const broker = new PluginConsentBroker({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onPending: (pending) => seen.push(pending.id),
    now: () => NOW,
  });
  return { broker, seen };
}

const MANIFEST = {
  id: "acme.notes",
  name: "Notes",
  version: "1.0.0",
  publisher: "acme",
  main: "src/index.ts",
  engines: { pluginApi: 1 },
  permissions: {
    scopes: ["friends:read", "users:read", "invite:send"],
    accounts: { mode: "many", optional: false },
    capabilities: ["storage", "notify"],
    events: ["friend.*", "gamelog.player_join"],
    fetch: { domains: ["example.com"] },
  },
} as unknown as PluginManifest;

function ask(broker: PluginConsentBroker) {
  return broker.ask({ manifest: MANIFEST, isUpdate: false, newScopes: [], source: "/tmp/notes" });
}

describe("the broker", () => {
  test("a request appears in pending and is announced", async () => {
    const { broker, seen } = brokerOf();
    const pending = ask(broker);

    const listed = broker.pending();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest.id).toBe("acme.notes");
    expect(listed[0]?.requestedAt).toBe(NOW);
    expect(seen).toEqual([listed[0]?.id ?? ""]);

    broker.deny(listed[0]?.id ?? "");
    await pending;
  });

  test("approve resolves with the choices and clears the request", async () => {
    const { broker } = brokerOf();
    const pending = ask(broker);
    const id = broker.pending()[0]?.id ?? "";

    expect(broker.approve(id, { accountIds: ["usr_a"] })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, approval: { accountIds: ["usr_a"] } });
    expect(broker.pending()).toEqual([]);
  });

  test("deny resolves as denied", async () => {
    const { broker } = brokerOf();
    const pending = ask(broker);
    broker.deny(broker.pending()[0]?.id ?? "");
    await expect(pending).resolves.toEqual({ ok: false, reason: "denied" });
  });

  test("answering twice is refused rather than settling a second time", async () => {
    const { broker } = brokerOf();
    const pending = ask(broker);
    const id = broker.pending()[0]?.id ?? "";

    expect(broker.approve(id, { accountIds: [] })).toBe(true);
    expect(broker.approve(id, { accountIds: ["usr_b"] })).toBe(false);
    expect(broker.deny(id)).toBe(false);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  test("an unanswered request times out, and a timeout is not an approval", async () => {
    const { broker } = brokerOf({ timeoutMs: 5 });
    const pending = ask(broker);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(broker.pending()).toEqual([]);
  });

  /** The property worth stating in a test: shutdown denies. An unanswered question is not a yes. */
  test("shutdown fails every waiting request", async () => {
    const { broker } = brokerOf();
    const first = ask(broker);
    const second = ask(broker);

    broker.shutdown();
    await expect(first).resolves.toEqual({ ok: false, reason: "shutdown" });
    await expect(second).resolves.toEqual({ ok: false, reason: "shutdown" });
    expect(broker.pending()).toEqual([]);
  });

  test("an onPending that throws does not take the request with it", async () => {
    const broker = new PluginConsentBroker({
      onPending: () => {
        throw new Error("no UI attached");
      },
      now: () => NOW,
    });
    const pending = ask(broker);
    expect(broker.pending()).toHaveLength(1);
    broker.deny(broker.pending()[0]?.id ?? "");
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
});

describe("narrowing", () => {
  test("an omitted list means everything the manifest asked for", () => {
    const approved = narrowToRequest(MANIFEST, { accountIds: ["usr_a"] });
    expect(approved.scopes).toEqual(["friends:read", "users:read", "invite:send"]);
    expect(approved.capabilities).toEqual(["storage", "notify"]);
    expect(approved.events).toEqual(["friend.*", "gamelog.player_join"]);
  });

  test("unticking narrows", () => {
    const approved = narrowToRequest(MANIFEST, {
      accountIds: ["usr_a"],
      scopes: ["friends:read"],
      capabilities: [],
      events: ["friend.*"],
    });
    expect(approved.scopes).toEqual(["friends:read"]);
    expect(approved.capabilities).toEqual([]);
    expect(approved.events).toEqual(["friend.*"]);
  });

  /**
   * The direction that matters. A UI bug sending a scope the plugin never asked for would otherwise
   * mint authority nobody requested — and it would look exactly like consent in the grant row.
   */
  test("an approval cannot grant anything the manifest did not ask for", () => {
    const approved = narrowToRequest(MANIFEST, {
      accountIds: ["usr_a"],
      scopes: ["friends:read", "moderation:write"],
      capabilities: ["storage", "storage:sql"],
      events: ["friend.*", "*"],
    });
    expect(approved.scopes).toEqual(["friends:read"]);
    expect(approved.capabilities).toEqual(["storage"]);
    expect(approved.events).toEqual(["friend.*"]);
  });

  test("accounts are taken as given and de-duplicated", () => {
    const approved = narrowToRequest(MANIFEST, { accountIds: ["usr_a", "usr_a", "usr_b"] });
    expect(approved.accountIds).toEqual(["usr_a", "usr_b"]);
  });

  test("no accounts is legal: a plugin that cannot act as anyone", () => {
    expect(narrowToRequest(MANIFEST, { accountIds: [] }).accountIds).toEqual([]);
  });
});
