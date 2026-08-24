/**
 * What a node's config holds the moment it arrives on the canvas.
 *
 * One function, in its own module, because two places need the same answer and they used to have one
 * each. The editor builds it when a node is added; the palette's detail card needs it to draw the
 * ports a node *will* have — and an extractor's ports come from a config row, so a preview built
 * from an empty config drew a card with no ports at all for the one family of nodes where the ports
 * are the whole point.
 */

import type { NodeConfigValues, NodeDefinition } from "@vrcz/plugin-api/nodes";

/**
 * Every declared default, keyed by field id.
 *
 * A `secret` is skipped and never carries one: its value lives in the credential store, and a
 * default in the document would be a secret in the document.
 */
export function defaultConfig(definition: NodeDefinition): NodeConfigValues {
  const config: Record<string, string | number | boolean> = {};
  for (const field of definition.config ?? []) {
    if (field.kind === "secret") continue;
    if ("default" in field && field.default !== undefined) config[field.id] = field.default;
  }
  return config;
}
