import { describe, expect, test } from "bun:test";
import {
  MAX_TABLE_ROWS,
  MAX_UI_DEPTH,
  MAX_UI_NODES,
  UI_NODE_TYPES,
  type UINode,
  validateUINode,
} from "./ui.ts";

/** A settings-and-list panel — decision 110's stated target, written the way an author would. */
const panel: UINode = {
  type: "stack",
  direction: "col",
  gap: 4,
  children: [
    { type: "text", value: "Instance watcher", variant: "h2" },
    {
      type: "card",
      title: "Settings",
      description: "Applies to the accounts you granted at install.",
      children: [
        {
          type: "form",
          submitLabel: "Save",
          onSubmit: { name: "settings.save" },
          children: [
            {
              type: "field",
              label: "Webhook name",
              required: true,
              control: {
                type: "input",
                name: "webhook",
                variant: "text",
                value: "",
                placeholder: "my-discord",
                debounceMs: 200,
                onChange: { name: "settings.touch", payload: { field: "webhook" } },
              },
            },
            {
              type: "field",
              label: "Notify on",
              control: {
                type: "select",
                name: "trigger",
                value: "join",
                options: [
                  { value: "join", label: "Player joins" },
                  { value: "leave", label: "Player leaves" },
                ],
              },
            },
            {
              type: "field",
              label: "Enabled",
              control: { type: "switch", name: "enabled", checked: true },
            },
            { type: "button", label: "Save", submit: true, variant: "default" },
          ],
        },
      ],
    },
    {
      type: "table",
      rowKey: "id",
      filterable: true,
      empty: "Nobody seen yet.",
      columns: [
        { id: "id", header: "User", cell: "userRef", sortable: true },
        { id: "seen", header: "Last seen", cell: "timestamp", align: "right" },
        { id: "count", header: "Visits", cell: "number", align: "right" },
      ],
      rows: [
        { id: "usr_1", seen: 1_700_000_000_000, count: 3 },
        { id: "usr_2", seen: 1_700_000_100_000, count: 1 },
      ],
      onSelect: { name: "row.open" },
      onContextMenu: {
        type: "menu",
        items: [
          { label: "Open profile", intent: { name: "row.open" } },
          { label: "Forget", danger: true, separatorBefore: true, intent: { name: "row.forget" } },
        ],
      },
    },
    {
      type: "dialog",
      open: false,
      title: "Forget this user?",
      description: "Their history is deleted from this plugin's storage.",
      actions: [{ type: "button", label: "Forget", variant: "destructive" }],
      onClose: { name: "dialog.close" },
    },
  ],
};

describe("validateUINode", () => {
  test("accepts a realistic settings panel", () => {
    const result = validateUINode(panel);
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    expect(result.node).toBe(panel);
  });

  test("accepts every node type in the union", () => {
    // Drift guard between the TypeScript union and the runtime spec table: a type added to
    // UI_NODE_TYPES with no fields entry is a compile error, but one whose spec is wrong is not.
    for (const type of UI_NODE_TYPES) {
      const result = validateUINode(minimal(type));
      if (!result.ok) throw new Error(`${type}: ${JSON.stringify(result.issues)}`);
    }
  });

  test("rejects an unknown node type", () => {
    const result = validateUINode({ type: "iframe", src: "https://example.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("$.type");
    expect(result.issues[0]?.message).toContain("unknown node type");
  });

  test("rejects a handler that is not an intent id", () => {
    // The boundary rule: handlers cross a process, so a function cannot be one. Whatever a plugin
    // sends here has already been through JSON, so the realistic failure is a missing `name`.
    const withFunction = { type: "button", label: "Go", onClick: () => {} };
    const bad = validateUINode(withFunction);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.message).toContain("intent id");

    const nameless = validateUINode({
      type: "button",
      label: "Go",
      onClick: { payload: { a: 1 } },
    });
    expect(nameless.ok).toBe(false);
    if (!nameless.ok) expect(nameless.issues[0]?.path).toBe("$.onClick.name");

    const nested = validateUINode({
      type: "button",
      label: "Go",
      onClick: { name: "go", payload: { nested: { no: true } } },
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.issues[0]?.path).toBe("$.onClick.payload.nested");
  });

  test("rejects an over-deep tree", () => {
    let node: UINode = { type: "text", value: "bottom" };
    for (let i = 0; i <= MAX_UI_DEPTH; i++) node = { type: "stack", children: [node] };
    const result = validateUINode(node);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.at(-1)?.message).toContain(`depth ${MAX_UI_DEPTH}`);
  });

  test("accepts a tree that sits exactly at the depth cap", () => {
    let node: UINode = { type: "text", value: "bottom" };
    // Root is depth 0, so MAX_UI_DEPTH wrappers puts the leaf at exactly the cap.
    for (let i = 0; i < MAX_UI_DEPTH; i++) node = { type: "stack", children: [node] };
    expect(validateUINode(node).ok).toBe(true);
  });

  test("rejects an over-large tree", () => {
    const children: UINode[] = [];
    for (let i = 0; i <= MAX_UI_NODES; i++) children.push({ type: "text", value: String(i) });
    const result = validateUINode({ type: "stack", children });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.at(-1)?.message).toContain(`${MAX_UI_NODES} nodes`);
  });

  test("menu items count against the node budget", () => {
    // A menu item costs the host what a node costs; a tree that dodged the cap by hiding a hundred
    // thousand items in one menu would defeat the only defence there is.
    const items = Array.from({ length: MAX_UI_NODES + 1 }, (_, i) => ({ label: String(i) }));
    expect(validateUINode({ type: "menu", items }).ok).toBe(false);
  });

  test("table rows are data, so a long table is cheap but still bounded", () => {
    const row = (i: number) => ({ id: `usr_${i}`, seen: i });
    const columns = [{ id: "id", header: "User", cell: "userRef" }];
    const big = {
      type: "table",
      rowKey: "id",
      columns,
      rows: Array.from({ length: 5000 }, (_, i) => row(i)),
    };
    expect(validateUINode(big).ok).toBe(true);

    const tooBig = {
      type: "table",
      rowKey: "id",
      columns,
      rows: Array.from({ length: MAX_TABLE_ROWS + 1 }, (_, i) => row(i)),
    };
    const result = validateUINode(tooBig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.at(-1)?.message).toContain(`${MAX_TABLE_ROWS} rows`);
  });

  test("rejects a missing required field and a wrong-typed one", () => {
    const missing = validateUINode({ type: "text" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0]).toEqual({ path: "$.value", message: "required" });

    const wrong = validateUINode({ type: "text", value: 42 });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues[0]?.message).toBe("expected a string");

    const badEnum = validateUINode({ type: "text", value: "hi", variant: "h9" });
    expect(badEnum.ok).toBe(false);
  });

  test("rejects a context menu that is any node but a menu", () => {
    const result = validateUINode({
      type: "text",
      value: "hi",
      onContextMenu: { type: "card", children: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain("type `menu`");
  });

  test("reports a path deep enough to find the offending node", () => {
    const result = validateUINode({
      type: "stack",
      children: [
        { type: "text", value: "ok" },
        { type: "select", name: "x", options: [{}] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("$.children[1].options[0].value");
  });

  test("ignores unknown properties", () => {
    // A plugin built against a newer protocol minor should still render on an older host.
    expect(validateUINode({ type: "text", value: "hi", sparkles: true }).ok).toBe(true);
  });

  test("never throws on hostile input", () => {
    const cases: unknown[] = [null, undefined, 0, "", [], { type: null }, { type: 7 }];
    for (const value of cases) expect(validateUINode(value).ok).toBe(false);
  });
});

/** Smallest legal node of each type, used by the drift guard above. */
function minimal(type: (typeof UI_NODE_TYPES)[number]): unknown {
  switch (type) {
    case "stack":
    case "grid":
    case "card":
    case "scroll":
    case "form":
      return { type, children: [] };
    case "tabs":
      return { type, items: [{ id: "a", label: "A", content: { type: "separator" } }] };
    case "separator":
    case "skeleton":
      return { type };
    case "text":
      return { type, value: "x" };
    case "badge":
    case "button":
      return { type, label: "x" };
    case "icon":
      return { type, name: "user" };
    case "alert":
      return { type, title: "x" };
    case "empty":
      return { type, title: "x" };
    case "userRef":
    case "worldRef":
    case "groupRef":
    case "avatarRef":
    case "instanceRef":
      return { type, id: "usr_1" };
    case "field":
      return { type, label: "x", control: { type: "text", value: "y" } };
    case "input":
    case "textarea":
    case "switch":
      return { type };
    case "select":
      return { type, options: [] };
    case "table":
      return { type, rowKey: "id", columns: [], rows: [] };
    case "list":
      return { type, items: [] };
    case "dialog":
      return { type, open: true, title: "x" };
    case "menu":
      return { type, items: [] };
  }
}
