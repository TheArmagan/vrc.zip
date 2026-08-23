/**
 * Arithmetic, text handling, time, and picking one thing out of many.
 *
 * The second half of the pure set — `shaping.ts` is the first. Same rule holds throughout: a node
 * that cannot do its job produces **nothing** rather than a plausible wrong answer, because an
 * unproduced port stops the run and a wrong answer travels.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import { readPath } from "./shaping.ts";
import type { BuiltinNode } from "./types.ts";

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function configText(config: NodeConfigValues, key: string, fallback = ""): string {
  const raw = config[key];
  return typeof raw === "string" && raw !== "" ? raw : fallback;
}

/* -------------------------------------------------------------------------------------------- */
/* Arithmetic                                                                                     */
/* -------------------------------------------------------------------------------------------- */

const MATH: NodeDefinition = {
  id: "math",
  kind: "action",
  title: "Maths",
  description: "Adds, subtracts, multiplies or divides two numbers.",
  category: "Data",
  inputs: [
    { id: "a", label: "A", type: "number", required: true },
    { id: "b", label: "B", type: "number" },
  ],
  outputs: [{ id: "result", label: "Result", type: "number" }],
  config: [
    {
      kind: "select",
      id: "op",
      label: "Operation",
      options: [
        { value: "add", label: "add" },
        { value: "sub", label: "subtract" },
        { value: "mul", label: "multiply" },
        { value: "div", label: "divide" },
        { value: "min", label: "smaller of" },
        { value: "max", label: "larger of" },
        { value: "round", label: "round (A only)" },
      ],
      default: "add",
    },
    { kind: "number", id: "value", label: "B, when nothing is wired", default: 0 },
  ],
  body: [
    { kind: "literal", text: "A " },
    { kind: "config", field: "op", fallback: "add" },
    { kind: "literal", text: " B" },
  ],
};

export function evaluateMath(op: string, a: number, b: number): number | null {
  switch (op) {
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      // Nothing rather than Infinity or NaN: a division by zero is a graph that will send a message
      // saying "Infinity" to somebody, and stopping is the kinder failure.
      return b === 0 ? null : a / b;
    case "min":
      return Math.min(a, b);
    case "max":
      return Math.max(a, b);
    case "round":
      return Math.round(a);
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Text                                                                                           */
/* -------------------------------------------------------------------------------------------- */

const TEXT_OP: NodeDefinition = {
  id: "text-op",
  kind: "action",
  title: "Change text",
  description: "Upper case, lower case, trim, or replace.",
  category: "Data",
  inputs: [{ id: "text", label: "Text", type: "string", required: true }],
  outputs: [{ id: "text", label: "Text", type: "string" }],
  config: [
    {
      kind: "select",
      id: "op",
      label: "Do",
      options: [
        { value: "upper", label: "UPPER CASE" },
        { value: "lower", label: "lower case" },
        { value: "trim", label: "trim spaces" },
        { value: "replace", label: "replace" },
      ],
      default: "upper",
    },
    { kind: "text", id: "find", label: "Find", description: "For replace." },
    { kind: "text", id: "replace", label: "Replace with", description: "For replace." },
  ],
  body: [{ kind: "config", field: "op", fallback: "upper" }],
};

const SPLIT: NodeDefinition = {
  id: "split",
  kind: "action",
  title: "Split text",
  description: "Cuts a line of text into a list.",
  category: "Lists",
  inputs: [{ id: "text", label: "Text", type: "string", required: true }],
  outputs: [{ id: "parts", label: "Parts", type: "list<string>" }],
  config: [
    {
      kind: "text",
      id: "separator",
      label: "Separator",
      placeholder: ",",
      description: "Left blank, the text is split on spaces.",
    },
  ],
  body: [
    { kind: "literal", text: "split on " },
    { kind: "config", field: "separator", fallback: "space" },
  ],
};

const JOIN: NodeDefinition = {
  id: "join",
  kind: "action",
  title: "Join list",
  description: "Turns a list into one line of text.",
  category: "Lists",
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [{ id: "text", label: "Text", type: "string" }],
  config: [{ kind: "text", id: "separator", label: "Separator", placeholder: ", " }],
  body: [
    { kind: "literal", text: "join with " },
    { kind: "config", field: "separator", fallback: ", " },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Time                                                                                           */
/* -------------------------------------------------------------------------------------------- */

const FORMAT_TIME: NodeDefinition = {
  id: "format-time",
  kind: "action",
  title: "Format a time",
  description: "Turns a timestamp into something a person can read.",
  category: "Data",
  inputs: [{ id: "at", label: "At", type: "number", required: true }],
  outputs: [{ id: "text", label: "Text", type: "string" }],
  config: [
    {
      kind: "select",
      id: "style",
      label: "As",
      options: [
        { value: "time", label: "21:04" },
        { value: "date", label: "23 Aug 2026" },
        { value: "datetime", label: "23 Aug 2026, 21:04" },
        { value: "iso", label: "2026-08-23T21:04:00.000Z" },
      ],
      default: "time",
    },
  ],
  body: [
    { kind: "literal", text: "as " },
    { kind: "config", field: "style", fallback: "time" },
  ],
};

/**
 * Timestamps are integer unix-ms everywhere in this project, which is unreadable in a message.
 *
 * Formatting uses the machine's own locale and timezone deliberately: the person reading the
 * message is sitting at this machine, and a graph is not the place to configure a timezone nobody
 * asked about.
 */
export function formatTime(at: number, style: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  switch (style) {
    case "date":
      return date.toLocaleDateString();
    case "datetime":
      return date.toLocaleString();
    case "iso":
      return date.toISOString();
    default:
      return date.toLocaleTimeString();
  }
}

const TIME_WINDOW: NodeDefinition = {
  id: "time-window",
  kind: "action",
  title: "Only at these hours",
  description: "Stops the run outside a window of the day. Uses this machine's clock.",
  category: "Logic",
  inputs: [{ id: "payload", label: "Carry", type: "json" }],
  outputs: [{ id: "out", label: "Then", type: "json" }],
  config: [
    { kind: "text", id: "from", label: "From", placeholder: "21:00", required: true },
    { kind: "text", id: "to", label: "Until", placeholder: "02:00", required: true },
  ],
  body: [
    { kind: "config", field: "from", fallback: "00:00" },
    { kind: "literal", text: " to " },
    { kind: "config", field: "to", fallback: "24:00" },
  ],
};

/** `21:00` as minutes past midnight, or null. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Is `at` inside the window?
 *
 * **A window that ends before it starts wraps over midnight**, which is the case people actually
 * want: "only between 9pm and 2am" is one evening, not an empty set. Refusing it would make the
 * commonest use of this node impossible to express.
 */
export function withinWindow(at: number, from: number, to: number): boolean {
  const date = new Date(at);
  const minutes = date.getHours() * 60 + date.getMinutes();
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/* -------------------------------------------------------------------------------------------- */
/* Picking                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const RANDOM_ITEM: NodeDefinition = {
  id: "random-item",
  kind: "action",
  title: "Pick one at random",
  description: "Chooses a single item out of a list.",
  category: "Lists",
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [{ id: "item", label: "Item", type: "json" }],
  body: [
    { kind: "literal", text: "one of " },
    { kind: "port", port: "list" },
  ],
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const FIND_IN_LIST: NodeDefinition = {
  id: "find-in-list",
  kind: "action",
  title: "Search a list",
  description: "Keeps the items that match a search, by text or by regular expression.",
  category: "Lists",
  inputs: [
    { id: "list", label: "List", type: "list<json>", required: true },
    { id: "query", label: "Search for", type: "string", required: true },
  ],
  outputs: [
    { id: "matches", label: "Matches", type: "list<json>" },
    { id: "first", label: "First match", type: "json" },
    { id: "count", label: "How many", type: "number" },
  ],
  config: [
    {
      kind: "select",
      id: "mode",
      label: "Match",
      options: [
        { value: "contains", label: "contains the text" },
        { value: "equals", label: "is exactly the text" },
        { value: "starts", label: "starts with the text" },
        { value: "regex", label: "matches a regular expression" },
      ],
      default: "contains",
    },
    {
      kind: "boolean",
      id: "caseSensitive",
      label: "Case sensitive",
      description: "Off by default: people search for names the way they remember them.",
    },
    {
      kind: "text",
      id: "path",
      label: "Search in field",
      placeholder: "displayName",
      description: "Left blank, the whole item is searched.",
    },
  ],
  body: [
    { kind: "literal", text: "search for " },
    { kind: "port", port: "query" },
  ],
};

/**
 * Does one item match?
 *
 * The **query is a port here, not config** — that is the whole difference from `Filter list`, whose
 * test is typed into the node. A search whose term arrives on a wire is what lets a graph look for
 * whoever the trigger just named, or for something a person typed elsewhere.
 *
 * A regular expression that will not compile matches nothing, the same answer `Compare` gives: the
 * pattern is the author's, and a run is not the place to learn about a typo in it.
 */
export function matchesQuery(
  item: unknown,
  query: string,
  mode: string,
  caseSensitive: boolean,
): boolean {
  const haystack = asText(item);
  if (mode === "regex") {
    try {
      return new RegExp(query, caseSensitive ? "" : "i").test(haystack);
    } catch {
      return false;
    }
  }
  const left = caseSensitive ? haystack : haystack.toLowerCase();
  const right = caseSensitive ? query : query.toLowerCase();
  if (mode === "equals") return left === right;
  if (mode === "starts") return left.startsWith(right);
  return left.includes(right);
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function operatorNodes(now: () => number): BuiltinNode[] {
  return [
    {
      definition: MATH,
      execute: (inputs, config): PortValues => {
        const a = asNumber(inputs.a);
        const b = inputs.b === undefined ? asNumber(config.value) : asNumber(inputs.b);
        if (a === null || b === null) return {};
        const result = evaluateMath(typeof config.op === "string" ? config.op : "add", a, b);
        return result === null ? {} : { result };
      },
    },
    {
      definition: TEXT_OP,
      execute: (inputs, config): PortValues => {
        const text = asText(inputs.text);
        switch (configText(config, "op", "upper")) {
          case "lower":
            return { text: text.toLowerCase() };
          case "trim":
            return { text: text.trim() };
          case "replace": {
            const find = configText(config, "find");
            // A blank "find" replaces nothing rather than inserting between every character, which
            // is what `String.replaceAll("")` would do and nobody has ever wanted.
            return {
              text: find === "" ? text : text.replaceAll(find, configText(config, "replace")),
            };
          }
          default:
            return { text: text.toUpperCase() };
        }
      },
    },
    {
      definition: SPLIT,
      execute: (inputs, config): PortValues => {
        const separator = configText(config, "separator", " ");
        return {
          parts: asText(inputs.text)
            .split(separator)
            .filter((part) => part !== ""),
        };
      },
    },
    {
      definition: JOIN,
      execute: (inputs, config): PortValues => ({
        text: asArray(inputs.list)
          .map(asText)
          .join(configText(config, "separator", ", ")),
      }),
    },
    {
      definition: FORMAT_TIME,
      execute: (inputs, config): PortValues => {
        const at = asNumber(inputs.at);
        return at === null ? {} : { text: formatTime(at, configText(config, "style", "time")) };
      },
    },
    {
      definition: TIME_WINDOW,
      execute: (inputs, config): PortValues => {
        const from = parseClock(configText(config, "from"));
        const to = parseClock(configText(config, "to"));
        // An unreadable window stops the run rather than letting everything through: a typo in a
        // gate must fail closed, since the whole point of the node is to hold things back.
        if (from === null || to === null) return {};
        return withinWindow(now(), from, to) ? { out: inputs.payload ?? true } : {};
      },
    },
    {
      definition: FIND_IN_LIST,
      execute: (inputs, config): PortValues => {
        const query = asText(inputs.query);
        const mode = configText(config, "mode", "contains");
        const caseSensitive = config.caseSensitive === true;
        const path = configText(config, "path");
        const matches = asArray(inputs.list).filter((item) =>
          matchesQuery(path === "" ? item : readPath(item, path), query, mode, caseSensitive),
        );
        return {
          matches,
          // Absent rather than null when nothing matched, so "and then do something with it" stops
          // instead of acting on nobody. `matches` and `count` are still there for the graph that
          // wants to know it found none.
          ...(matches.length === 0 ? {} : { first: matches[0] }),
          count: matches.length,
        };
      },
    },
    {
      definition: RANDOM_ITEM,
      execute: (inputs): PortValues => {
        const list = asArray(inputs.list);
        // Empty produces nothing, like `first item`: "pick somebody in the room" has no answer in
        // an empty room, and `null` would have the graph act on nobody.
        if (list.length === 0) return {};
        return { item: list[Math.floor(Math.random() * list.length)] };
      },
    },
  ];
}
