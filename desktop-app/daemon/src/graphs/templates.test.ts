import { describe, expect, test } from "bun:test";
import {
  AFTER_PORT,
  assignable,
  isTriggerDefinition,
  type NodeDefinition,
} from "@vrcz/plugin-api/nodes";
import { graphRoots, reachableFrom, validateGraphDocument } from "@vrcz/shared";
import { EventBus } from "../bus/event-bus.ts";
import { createBuiltinNodes } from "./builtins/index.ts";
import { GRAPH_TEMPLATES } from "./templates.ts";

/**
 * A template is code that has to keep working.
 *
 * Nothing else in the app runs these documents, so without this file a template quietly rots the
 * first time a built-in node's ports move — and the user finds out by dragging a broken graph onto
 * their canvas. Everything here is checked against the **real** built-in definitions.
 */

const nodes = createBuiltinNodes({ bus: new EventBus() });

function definition(type: string): NodeDefinition {
  const found = nodes.definition(type);
  if (found === null) throw new Error(`${type} is not a built-in node type`);
  return found;
}

describe("the shipped templates", () => {
  test("there are some, and their ids are unique", () => {
    expect(GRAPH_TEMPLATES.length).toBeGreaterThan(0);
    const ids = GRAPH_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const template of GRAPH_TEMPLATES) {
    describe(template.id, () => {
      test("is a valid document", () => {
        expect(validateGraphDocument(template.definition)).toEqual({ ok: true, issues: [] });
      });

      test("names only built-in node types that exist", () => {
        for (const node of template.definition.nodes) {
          expect(() => definition(node.type)).not.toThrow();
        }
      });

      test("every edge type-checks", () => {
        const types = new Map(template.definition.nodes.map((node) => [node.id, node.type]));
        for (const edge of template.definition.edges) {
          const source = definition(types.get(edge.from.node) ?? "");
          const target = definition(types.get(edge.to.node) ?? "");
          const output = source.outputs.find((port) => port.id === edge.from.port);
          const input = isTriggerDefinition(target)
            ? undefined
            : // `after` is the input every node has and no definition declares. It carries no value
              // and accepts anything, which is exactly what `json` means in this lattice — so it is
              // resolved here rather than being a hole the check silently fails on. Without this a
              // template could not express a sequencing edge at all.
              (target.inputs.find((port) => port.id === edge.to.port) ??
              (edge.to.port === AFTER_PORT
                ? ({ id: AFTER_PORT, label: "run after", type: "json" } as const)
                : undefined));
          expect(output, `${edge.id}: no output ${edge.from.port}`).toBeDefined();
          expect(input, `${edge.id}: no input ${edge.to.port}`).toBeDefined();
          if (output === undefined || input === undefined) continue;
          expect(
            assignable(output.type, input.type),
            `${edge.id}: ${output.type} cannot flow into ${input.type}`,
          ).toBe(true);
        }
      });

      test("starts at exactly one trigger", () => {
        const roots = graphRoots(template.definition);
        expect(roots).toHaveLength(1);
        const type = template.definition.nodes.find((node) => node.id === roots[0])?.type ?? "";
        expect(isTriggerDefinition(definition(type))).toBe(true);
      });

      test("every node is reachable from that trigger", () => {
        // The failure this catches is silent: a run walks only what its own trigger reaches, so an
        // unwired tail is a template that looks right on the canvas and does nothing.
        const root = graphRoots(template.definition)[0] ?? "";
        const reached = reachableFrom(template.definition, root);
        for (const node of template.definition.nodes) {
          expect(reached.has(node.id), `${node.id} is not reachable from ${root}`).toBe(true);
        }
      });

      test("carries no secret and no account", () => {
        // Neither can be meaningful on another machine, and a template is by definition somebody
        // else's document arriving on yours.
        const json = JSON.stringify(template.definition);
        expect(json).not.toContain("accountId");
        for (const node of template.definition.nodes) {
          const secrets = (definition(node.type).config ?? []).filter(
            (field) => field.kind === "secret",
          );
          for (const field of secrets) expect(node.config[field.id]).toBeUndefined();
        }
      });
    });
  }
});
