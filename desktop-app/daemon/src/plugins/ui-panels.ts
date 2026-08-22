/**
 * Plugin panels: the host's copy of every tree a plugin is currently drawing, and the `ui.*` methods
 * that change it.
 *
 * ## Why the host holds the tree at all
 *
 * A browser that opens the plugins screen ten minutes after a plugin drew its panel has to get
 * something. Asking the plugin to redraw on demand would make every page load a round trip into a
 * process that might be wedged, and would make a panel's contents depend on whether anyone happened
 * to be looking when it was pushed. So the host keeps the current tree per (plugin, panel), answers
 * reads from it, and forwards changes to whoever is connected.
 *
 * That also makes the patch semantics meaningful. `ui.patchPanel` names the `key` of a subtree and
 * replaces exactly that node — cheap on the wire, and everything the patch did not touch is never
 * re-created, which is what keeps focus, scroll position and an open dialog alive across an update.
 *
 * ## What is validated, and what happens when it fails
 *
 * Every tree passes `validateUINode` **here**, before it is stored or forwarded, so a malformed
 * tree never reaches a browser. A rejection is answered to the plugin with the validator's own
 * issues — the author is the only person who can fix it — and the previously drawn panel is left
 * exactly as it was. Replacing a working panel with an error state because its *next* update was
 * malformed would lose the user something that was working.
 *
 * ## Caps
 *
 * A plugin may hold {@link MAX_PANELS_PER_PLUGIN} panels. The manifest caps declared panels at 32,
 * but the manifest is not on the call path — `contributes` is deliberately excluded from the grant,
 * because a panel is surface rather than authority. So the cap is enforced here on the count, which
 * is the property that matters: an unbounded map of trees held by the host is a memory leak a
 * plugin controls.
 */

import {
  defineMethod,
  type ErasedMethod,
  MAX_UI_NODES,
  type MethodDefinition,
  type UINode,
  validateUINode,
} from "@vrcz/plugin-api";
import { isJsonObject, type JsonValue } from "@vrcz/shared";
import { DispatchError } from "./dispatcher.ts";
import type { defineGatedMethod, GatedMethodTable } from "./scope-gate.ts";

/** How many panels one plugin may hold open. The manifest's own limit, enforced where it counts. */
export const MAX_PANELS_PER_PLUGIN = 32;

/** Panel ids are identifiers, not documents — the same shape the manifest's `contributionId` uses. */
const PANEL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/** One panel as the host holds it. */
export interface PanelState {
  readonly pluginId: string;
  readonly panelId: string;
  readonly tree: UINode;
  /** Unix ms of the last change, so a reader can tell a fresh panel from a stale one. */
  readonly updatedAt: number;
}

export type PanelChange =
  | {
      readonly op: "set";
      readonly pluginId: string;
      readonly panelId: string;
      readonly tree: UINode;
    }
  | {
      readonly op: "patch";
      readonly pluginId: string;
      readonly panelId: string;
      readonly key: string;
      readonly tree: UINode;
    }
  | { readonly op: "close"; readonly pluginId: string; readonly panelId: string };

export interface PanelRegistryOptions {
  /** Raised after every accepted change, for the control stream to forward. */
  readonly onChange?: (change: PanelChange) => void;
  readonly now?: () => number;
}

/**
 * Every plugin's panels.
 *
 * Not a store table: a panel is what a *running* plugin is currently drawing, and a tree that
 * outlived the process that drew it would be a screen nobody can interact with — every intent on it
 * would reach a plugin that is not there. Panels go when the plugin stops, deliberately.
 */
export class PanelRegistry {
  readonly #panels = new Map<string, Map<string, PanelState>>();
  readonly #onChange: ((change: PanelChange) => void) | undefined;
  readonly #now: () => number;

  constructor(options: PanelRegistryOptions = {}) {
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Every panel one plugin is drawing. */
  list(pluginId: string): PanelState[] {
    return [...(this.#panels.get(pluginId)?.values() ?? [])];
  }

  get(pluginId: string, panelId: string): PanelState | null {
    return this.#panels.get(pluginId)?.get(panelId) ?? null;
  }

  set(pluginId: string, panelId: string, tree: UINode): void {
    let owned = this.#panels.get(pluginId);
    if (owned === undefined) {
      owned = new Map();
      this.#panels.set(pluginId, owned);
    }
    if (!owned.has(panelId) && owned.size >= MAX_PANELS_PER_PLUGIN) {
      throw new DispatchError(
        "E_TOO_LARGE",
        `A plugin may hold ${MAX_PANELS_PER_PLUGIN} panels at once. Close one before opening another.`,
      );
    }
    owned.set(panelId, { pluginId, panelId, tree, updatedAt: this.#now() });
    this.#emit({ op: "set", pluginId, panelId, tree });
  }

  /**
   * Replaces the subtree carrying `key`.
   *
   * Refused when the panel does not exist or the key is not in it, rather than being treated as a
   * `set`: a patch whose target has gone is a plugin working from a stale idea of what is drawn, and
   * silently turning that into a whole-tree replacement would hide the bug and lose whatever the
   * user had in the rest of the panel.
   */
  patch(pluginId: string, panelId: string, key: string, tree: UINode): void {
    const existing = this.#panels.get(pluginId)?.get(panelId);
    if (existing === undefined) {
      throw new DispatchError("E_BAD_REQUEST", `No panel "${panelId}" is open to patch.`);
    }
    const replaced = replaceByKey(existing.tree, key, tree);
    if (replaced === null) {
      throw new DispatchError(
        "E_BAD_REQUEST",
        `No node with key "${key}" is in panel "${panelId}". Send the whole tree with ui.setPanel instead.`,
      );
    }
    this.#panels.get(pluginId)?.set(panelId, {
      pluginId,
      panelId,
      tree: replaced,
      updatedAt: this.#now(),
    });
    this.#emit({ op: "patch", pluginId, panelId, key, tree });
  }

  close(pluginId: string, panelId: string): boolean {
    const owned = this.#panels.get(pluginId);
    if (owned?.delete(panelId) !== true) return false;
    if (owned.size === 0) this.#panels.delete(pluginId);
    this.#emit({ op: "close", pluginId, panelId });
    return true;
  }

  /** Drops every panel a plugin holds. Called when it stops, however it stopped. */
  closeAll(pluginId: string): void {
    for (const panelId of [...(this.#panels.get(pluginId)?.keys() ?? [])]) {
      this.close(pluginId, panelId);
    }
  }

  #emit(change: PanelChange): void {
    try {
      this.#onChange?.(change);
    } catch {
      // A subscriber that throws must not fail the plugin's call. The panel is already updated;
      // the browser will pick it up on its next read.
    }
  }
}

/**
 * Replaces the node carrying `key` anywhere in the tree, returning a new tree.
 *
 * Returns null when the key is not present, which the caller turns into a refusal. Depth is bounded
 * by the validator's own `MAX_UI_DEPTH` before this ever runs, so the recursion cannot be driven
 * past it by a plugin.
 */
function replaceByKey(node: UINode, key: string, replacement: UINode): UINode | null {
  if (node.key === key) return replacement;
  const children = (node as { children?: readonly UINode[] }).children;
  if (children === undefined) return null;
  let changed = false;
  const next = children.map((child) => {
    if (changed) return child;
    const replacedChild = replaceByKey(child, key, replacement);
    if (replacedChild === null) return child;
    changed = true;
    return replacedChild;
  });
  return changed ? ({ ...node, children: next } as UINode) : null;
}

function parsePanelId(raw: JsonValue | undefined): string {
  if (!isJsonObject(raw)) throw new DispatchError("E_BAD_REQUEST", "Expected an object.");
  const panelId = raw.panelId;
  if (typeof panelId !== "string" || !PANEL_ID_PATTERN.test(panelId)) {
    throw new DispatchError(
      "E_BAD_REQUEST",
      'panelId must be an id like "notes" or "notes.detail": lowercase, starting with a letter.',
    );
  }
  return panelId;
}

/** Validates a tree and turns a rejection into the validator's own sentences. */
function parseTree(raw: JsonValue | undefined, field = "tree"): UINode {
  if (!isJsonObject(raw)) throw new DispatchError("E_BAD_REQUEST", "Expected an object.");
  const result = validateUINode(raw[field]);
  if (!result.ok) {
    // The author is the only person who can fix this, so they get the whole list rather than a
    // count. Capped by the validator itself at MAX_UI_ISSUES.
    throw new DispatchError(
      "E_BAD_REQUEST",
      `${field} is not a valid UI tree (limit ${MAX_UI_NODES} nodes): ${result.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.node;
}

/** A `ui.*` method: no scope, no capability, no rate cost. See the note in {@link createUiMethods}. */
function uiMethod<Params, Result extends JsonValue | undefined>(
  definition: Omit<MethodDefinition<Params, Result>, "scope" | "capability" | "cost">,
): ErasedMethod {
  return defineMethod({ scope: null, capability: null, cost: 0, ...definition });
}

export interface UiMethodDeps {
  readonly panels: PanelRegistry;
}

/**
 * The `ui.*` table.
 *
 * **No scope and no capability**, and that is not an oversight: a panel is the plugin's own surface,
 * drawn from data it already had. Nothing here reads the user's account, reaches VRChat, or touches
 * anything outside the plugin's own rectangle. Requiring a scope would mean a consent sheet asking
 * permission for a plugin to draw its own settings page, which teaches people that the scope list is
 * noise.
 *
 * What bounds it instead is the validator, the node cap, the panel cap, and the transport's frame
 * budget — all four of which are about *size*, which is the actual risk here.
 */
export function createUiMethods(deps: UiMethodDeps): GatedMethodTable {
  return {
    "ui.setPanel": {
      account: "none",
      method: uiMethod<{ panelId: string; tree: UINode }, null>({
        parse: (raw) => ({
          ok: true,
          value: { panelId: parsePanelId(raw), tree: parseTree(raw) },
        }),
        handle: async ({ panelId, tree }, ctx) => {
          deps.panels.set(ctx.grant.pluginId, panelId, tree);
          return null;
        },
      }),
    },

    "ui.patchPanel": {
      account: "none",
      method: uiMethod<{ panelId: string; key: string; tree: UINode }, null>({
        parse: (raw) => {
          const panelId = parsePanelId(raw);
          if (!isJsonObject(raw) || typeof raw.key !== "string" || raw.key === "") {
            throw new DispatchError(
              "E_BAD_REQUEST",
              "key must name the node you are replacing. Give that node a `key` in the tree first.",
            );
          }
          return { ok: true, value: { panelId, key: raw.key, tree: parseTree(raw) } };
        },
        handle: async ({ panelId, key, tree }, ctx) => {
          deps.panels.patch(ctx.grant.pluginId, panelId, key, tree);
          return null;
        },
      }),
    },

    "ui.closePanel": {
      account: "none",
      method: uiMethod<{ panelId: string }, { closed: boolean }>({
        parse: (raw) => ({ ok: true, value: { panelId: parsePanelId(raw) } }),
        handle: async ({ panelId }, ctx) => ({
          closed: deps.panels.close(ctx.grant.pluginId, panelId),
        }),
      }),
    },
  } satisfies Record<string, ReturnType<typeof defineGatedMethod>>;
}
