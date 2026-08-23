/**
 * The graphs vrc.zip ships, so a first canvas is an edit rather than a blank page.
 *
 * Three of them, and the count is the point: a template is code that has to keep working, and every
 * one added is another thing that breaks silently when a node's ports change. These three cover the
 * shapes people actually ask for — tell me somewhere else, notice something in the room, do it on a
 * timer — and each uses **only built-in node types**, because a template referencing a plugin the
 * user does not have is a template that lands broken.
 *
 * They are deliberately not "examples of everything". Nothing here uses `foreach`, a branch or an
 * error port: a starting point that needs explaining is not a starting point.
 *
 * Positions are laid out left to right with room between them, since the canvas opens at 1:1 and a
 * template that arrives overlapping itself reads as broken before the user has done anything.
 */

import type { GraphDocument, GraphTemplate } from "@vrcz/shared";
import { BUILTIN_NAMESPACE } from "./intrinsics.ts";

const t = (id: string): string => `${BUILTIN_NAMESPACE}/${id}`;

/** Three columns, which is as wide as any of these get. */
const COLUMN = [
  { x: 0, y: 0 },
  { x: 320, y: 40 },
  { x: 640, y: 40 },
] as const;

function document(
  nodes: readonly {
    id: string;
    type: string;
    config?: Record<string, string | number | boolean>;
    at: number;
  }[],
  edges: readonly { from: [string, string]; to: [string, string] }[],
): GraphDocument {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: COLUMN[node.at] ?? { x: node.at * 320, y: 40 },
      config: node.config ?? {},
    })),
    edges: edges.map((edge, index) => ({
      id: `e${String(index + 1)}`,
      from: { node: edge.from[0], port: edge.from[1] },
      to: { node: edge.to[0], port: edge.to[1] },
    })),
  };
}

export const GRAPH_TEMPLATES: readonly GraphTemplate[] = [
  {
    id: "friend-online-discord",
    name: "Tell Discord when a friend comes online",
    description: "Posts a line to a Discord webhook whenever one of your friends appears.",
    definition: document(
      [
        { id: "trigger", type: t("on-friend-online"), at: 0 },
        {
          id: "text",
          type: t("template"),
          at: 1,
          config: { template: "{a} came online" },
        },
        { id: "send", type: t("discord"), at: 2 },
      ],
      [
        { from: ["trigger", "friend"], to: ["text", "a"] },
        { from: ["text", "text"], to: ["send", "text"] },
      ],
    ),
  },
  {
    id: "player-join-note",
    name: "Note who joins your instance",
    description: "Writes a line in vrc.zip's own feed each time somebody walks in.",
    definition: document(
      [
        { id: "trigger", type: t("on-player-join"), at: 0 },
        { id: "text", type: t("template"), at: 1, config: { template: "{a} joined" } },
        { id: "note", type: t("note"), at: 2 },
      ],
      [
        { from: ["trigger", "name"], to: ["text", "a"] },
        { from: ["text", "text"], to: ["note", "text"] },
      ],
    ),
  },
  {
    id: "hourly-ntfy",
    name: "Nudge your phone on a timer",
    description: "Sends an ntfy notification every hour while vrc.zip is running.",
    definition: document(
      [
        { id: "trigger", type: t("on-schedule"), at: 0, config: { everyMs: 3_600_000 } },
        { id: "text", type: t("template"), at: 1, config: { template: "vrc.zip is still here" } },
        { id: "send", type: t("ntfy"), at: 2, config: { server: "https://ntfy.sh" } },
      ],
      [
        // The trigger has to reach the text node even though the message uses none of its
        // outputs: a run walks only what its own trigger reaches, so an unwired chain is an
        // unreachable one. `number` into a `json` slot is the erasure rule doing its job.
        { from: ["trigger", "at"], to: ["text", "a"] },
        { from: ["text", "text"], to: ["send", "text"] },
      ],
    ),
  },
];
