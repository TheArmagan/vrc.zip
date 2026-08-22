/**
 * Panels, driven through the gate a plugin calls them through.
 *
 * The interesting behaviour is all in the refusals: what a patch does when its target has moved,
 * what a malformed tree does to the panel that was already drawn, and what the caps do. A test that
 * only asserted "set then get returns the tree" would pass against an implementation with none of
 * those.
 */

import { describe, expect, test } from "bun:test";
import type { PluginGrant, RequestFrame, UINode } from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import { DispatchError } from "./dispatcher.ts";
import { createScopeGate } from "./scope-gate.ts";
import { createUiMethods, MAX_PANELS_PER_PLUGIN, PanelRegistry } from "./ui-panels.ts";

const PLUGIN = "acme.notes";
const NOW = 1_760_000_000_000;

const GRANT: PluginGrant = {
  pluginId: PLUGIN,
  scopes: [],
  accountIds: [],
  capabilities: [],
  events: [],
};

function req(method: string, params?: JsonValue): RequestFrame {
  return { t: "req", id: "1", method, deadline: NOW + 1000, ...(params ? { params } : {}) };
}

function harness() {
  const changes: string[] = [];
  const panels = new PanelRegistry({
    onChange: (change) => changes.push(`${change.op}:${change.panelId}`),
    now: () => NOW,
  });
  const gate = createScopeGate(createUiMethods({ panels }));

  async function call(method: string, params?: JsonValue): Promise<JsonValue> {
    const authorized = gate.check(req(method, params), GRANT, NOW);
    if (!authorized.ok) throw new DispatchError(authorized.code, authorized.message);
    const result = await authorized.value.method.invoke(params, {
      grant: GRANT,
      deadline: NOW + 1000,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new DispatchError(result.code, result.message);
    return result.value ?? null;
  }

  return { panels, changes, call };
}

const TREE: UINode = {
  type: "stack",
  direction: "col",
  children: [
    { type: "text", value: "hello" },
    { type: "card", key: "body", title: "Body", children: [{ type: "text", value: "one" }] },
  ],
} as UINode;

describe("drawing", () => {
  test("a panel round-trips, and the change is announced", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });

    expect(h.panels.get(PLUGIN, "notes")?.tree).toEqual(TREE);
    expect(h.panels.get(PLUGIN, "notes")?.updatedAt).toBe(NOW);
    expect(h.changes).toEqual(["set:notes"]);
  });

  test("ui.* needs no scope and no capability: a grant holding nothing can draw", async () => {
    const h = harness();
    // GRANT has empty scopes and capabilities. A panel is the plugin's own surface, and asking
    // permission to draw one would teach people that the scope list is noise.
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });
    expect(h.panels.list(PLUGIN)).toHaveLength(1);
  });

  test("a panel id that is not an identifier is refused", async () => {
    const h = harness();
    await expect(
      h.call("ui.setPanel", { panelId: "../etc", tree: TREE as unknown as JsonValue }),
    ).rejects.toThrow(/panelId/);
  });

  /**
   * The half worth stating: a malformed *update* must not destroy a working panel. Losing what was
   * drawn because the next tree was bad punishes the user for the author's bug.
   */
  test("an invalid tree is refused and leaves the drawn panel alone", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });

    await expect(
      h.call("ui.setPanel", { panelId: "notes", tree: { type: "not-a-node" } }),
    ).rejects.toThrow(/valid UI tree/);
    expect(h.panels.get(PLUGIN, "notes")?.tree).toEqual(TREE);
    expect(h.changes).toEqual(["set:notes"]);
  });

  test("the panel cap is enforced on the count, not on the manifest", async () => {
    const h = harness();
    for (let i = 0; i < MAX_PANELS_PER_PLUGIN; i++) {
      await h.call("ui.setPanel", { panelId: `p${i}`, tree: TREE as unknown as JsonValue });
    }
    await expect(
      h.call("ui.setPanel", { panelId: "one-too-many", tree: TREE as unknown as JsonValue }),
    ).rejects.toThrow(/32 panels/);

    // Replacing an existing panel is not a new one, so it still works at the cap.
    await h.call("ui.setPanel", { panelId: "p0", tree: TREE as unknown as JsonValue });
  });
});

describe("patching", () => {
  test("a patch replaces exactly the keyed subtree and leaves the rest identical", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });

    const replacement = { type: "card", key: "body", title: "Body", children: [] };
    await h.call("ui.patchPanel", { panelId: "notes", key: "body", tree: replacement });

    const tree = h.panels.get(PLUGIN, "notes")?.tree as unknown as {
      children: { type: string; value?: string; title?: string }[];
    };
    // The untouched sibling is the *same value*, which is what keeps focus and scroll alive.
    expect(tree.children[0]).toEqual({ type: "text", value: "hello" });
    expect(tree.children[1]).toEqual(replacement as unknown as never);
    expect(h.changes).toEqual(["set:notes", "patch:notes"]);
  });

  /**
   * A patch whose target has gone is a plugin working from a stale idea of what is drawn. Treating
   * it as a whole-tree set would hide that bug *and* throw away whatever the user had in the rest
   * of the panel.
   */
  test("a patch naming a key that is not there is refused, not upgraded to a set", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });

    await expect(
      h.call("ui.patchPanel", {
        panelId: "notes",
        key: "gone",
        tree: { type: "text", value: "x" },
      }),
    ).rejects.toThrow(/No node with key/);
    expect(h.panels.get(PLUGIN, "notes")?.tree).toEqual(TREE);
  });

  test("a patch to a panel that was never opened is refused", async () => {
    const h = harness();
    await expect(
      h.call("ui.patchPanel", { panelId: "nope", key: "body", tree: { type: "text", value: "x" } }),
    ).rejects.toThrow(/No panel/);
  });

  test("a patch with no key says which field is missing", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });
    await expect(
      h.call("ui.patchPanel", { panelId: "notes", tree: { type: "text", value: "x" } }),
    ).rejects.toThrow(/key must name/);
  });
});

describe("closing", () => {
  test("close removes it and says whether anything went", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });

    expect(await h.call("ui.closePanel", { panelId: "notes" })).toEqual({ closed: true });
    expect(h.panels.get(PLUGIN, "notes")).toBeNull();
    expect(await h.call("ui.closePanel", { panelId: "notes" })).toEqual({ closed: false });
    expect(h.changes).toEqual(["set:notes", "close:notes"]);
  });

  /**
   * A tree that outlived the process that drew it is a screen whose every button reaches nobody, so
   * the host drops a plugin's panels when it stops.
   */
  test("closeAll drops everything one plugin holds and announces each", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "a", tree: TREE as unknown as JsonValue });
    await h.call("ui.setPanel", { panelId: "b", tree: TREE as unknown as JsonValue });

    h.panels.closeAll(PLUGIN);
    expect(h.panels.list(PLUGIN)).toEqual([]);
    expect(h.changes).toEqual(["set:a", "set:b", "close:a", "close:b"]);
  });

  test("one plugin's panels are not another's", async () => {
    const h = harness();
    await h.call("ui.setPanel", { panelId: "notes", tree: TREE as unknown as JsonValue });
    h.panels.set("other.plugin", "notes", TREE);

    h.panels.closeAll("other.plugin");
    expect(h.panels.get(PLUGIN, "notes")).not.toBeNull();
  });
});
