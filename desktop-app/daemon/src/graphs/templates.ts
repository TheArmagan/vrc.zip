/**
 * The graphs vrc.zip ships, so a first canvas is an edit rather than a blank page.
 *
 * Four of them, and the count is the point: a template is code that has to keep working, and every
 * one added is another thing that breaks silently when a node's ports change. Each uses **only
 * built-in node types**, because a template referencing a plugin the user does not have is a
 * template that lands broken.
 *
 * Three cover the shapes people actually ask for — tell me somewhere else, notice something in the
 * room, do it on a timer — and stay deliberately plain: no branch, no error port, nothing that needs
 * explaining before it can be read.
 *
 * The fourth is `foreach`, and it is the exception to that rule for one reason. This entry used to
 * say "nothing here uses `foreach`", on the grounds that a starting point should not need
 * explaining. That was right about templates and wrong about the loop: doing something once per item
 * and then something else with what you gathered is four nodes wired in a shape nobody guesses, and
 * a palette entry called "Collect" explains nothing on its own. So the loop gets the one template
 * that is there to be read rather than to be run.
 *
 * Positions are laid out left to right with room between them, since the canvas opens at 1:1 and a
 * template that arrives overlapping itself reads as broken before the user has done anything. A
 * template with a body and an afterwards gets a second row for the afterwards.
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

/** How far down the second row sits. One card's height plus room for the wires between them. */
const ROW_HEIGHT = 280;

function document(
  nodes: readonly {
    id: string;
    type: string;
    config?: Record<string, string | number | boolean>;
    at: number;
    /** Which row. Only the loop template has two. */
    row?: number;
  }[],
  edges: readonly { from: [string, string]; to: [string, string] }[],
): GraphDocument {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: place(node.at, node.row ?? 0),
      config: node.config ?? {},
    })),
    edges: edges.map((edge, index) => ({
      id: `e${String(index + 1)}`,
      from: { node: edge.from[0], port: edge.from[1] },
      to: { node: edge.to[0], port: edge.to[1] },
    })),
  };
}

function place(at: number, row: number): { x: number; y: number } {
  const column = COLUMN[at] ?? { x: at * 320, y: 40 };
  return { x: column.x, y: column.y + row * ROW_HEIGHT };
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
  {
    id: "friends-online-roundup",
    name: "One line per friend who is online",
    description:
      "Loops over your online friends, writes a line for each, then one summary line. The template to open if you want to see how a For each is wired.",
    definition: document(
      [
        { id: "trigger", type: t("on-schedule"), at: 0, config: { everyMs: 3_600_000 } },
        // A source: no inputs at all, so the only thing that makes it part of this run is the
        // sequencing edge below. The engine would resolve it as a source anyway; wiring it says so
        // on the canvas, which is the difference between a graph you can read and one you cannot.
        { id: "friends", type: t("friends"), at: 1 },
        { id: "loop", type: t("foreach"), at: 2 },
        { id: "line", type: t("template"), at: 3, config: { template: "{a} is online" } },
        { id: "collect", type: t("collect"), at: 4 },
        // The second row is everything that happens *after* the loop, which is also how the canvas
        // draws it: the tinted region covers the first row only.
        { id: "summary", type: t("join"), at: 3, row: 1, config: { separator: ", " } },
        { id: "note", type: t("note"), at: 4, row: 1 },
      ],
      [
        { from: ["trigger", "at"], to: ["friends", "after"] },
        { from: ["friends", "names"], to: ["loop", "list"] },
        { from: ["loop", "item"], to: ["line", "a"] },
        // What each iteration keeps. Without this the loop would still run, and the line it wrote
        // would be all that survived it.
        { from: ["line", "text"], to: ["collect", "value"] },
        // And what it kept, once. `results` is an after-the-loop port, so everything downstream of
        // here runs a single time rather than once per friend.
        { from: ["loop", "results"], to: ["summary", "list"] },
        { from: ["summary", "text"], to: ["note", "text"] },
      ],
    ),
  },
];
