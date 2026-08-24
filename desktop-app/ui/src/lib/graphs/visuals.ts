/**
 * What a node looks like, in one place.
 *
 * The card, the palette, the node picker and the edges all have to agree about what colour a
 * `Control` node is and what colour a `boolean` wire is, and they are four files. Four copies of a
 * lookup table is four chances for the palette to teach a taxonomy the canvas then contradicts.
 *
 * Colours are CSS variable names, not values: the tokens are declared once per theme in `app.css`,
 * so a card drawn on a dark canvas picks up the lifted variant without this module knowing there is
 * more than one theme.
 *
 * The icons are Lucide, imported by the components that draw them — an icon is a Svelte component
 * and this file stays plain data so it can be unit-tested without a renderer.
 */

import { listElement, type PortType } from "@vrcz/plugin-api/nodes";

/** The visual family a palette category belongs to. One hue and one icon per member. */
export type NodeFamily =
  | "trigger"
  | "logic"
  | "control"
  | "data"
  | "value"
  | "send"
  | "vrchat"
  | "plugin";

/**
 * Which family a node belongs to, from the same two facts the palette groups by.
 *
 * `owner` decides first and it has to: a plugin's node may declare any category it likes, and a
 * plugin claiming the Triggers hue would be a plugin drawing itself as part of vrc.zip. Categories
 * are matched exactly against the built-in set, because they are the strings the built-ins ship.
 */
export function familyOf(category: string | undefined, owner: string): NodeFamily {
  if (owner !== "vrcz") return "plugin";
  switch (category) {
    case "Triggers":
      return "trigger";
    case "Logic":
      return "logic";
    case "Control":
      return "control";
    case "Data":
    case "Lists":
    case "Collections":
    case "Stored data":
      return "data";
    case "Send":
      return "send";
    case "VRChat":
      return "vrchat";
    default:
      // The generated API groups are `API: <tag>`, nineteen of them, and they are all VRChat.
      // Everything genuinely unrecognised falls to the neutral hue rather than to a guess.
      return category?.startsWith("API: ") === true ? "vrchat" : "value";
  }
}

/** The CSS variable holding this family's accent colour. */
export function familyColor(family: NodeFamily): string {
  return `var(--node-${family})`;
}

/**
 * The Lucide icon name for a family, plus the two categories that earn their own inside `data`.
 *
 * A list and a stored collection are both `data` in colour because they are the same kind of thing,
 * and different in icon because the choice between them is the one decision in that group that
 * matters: whether the answer survives a restart.
 */
export function iconNameFor(category: string | undefined, owner: string): string {
  if (owner !== "vrcz") return "puzzle";
  if (category === "Lists") return "list";
  if (category === "Collections") return "layers";
  if (category === "Stored data") return "archive";
  switch (familyOf(category, owner)) {
    case "trigger":
      return "zap";
    case "logic":
      return "split";
    case "control":
      return "repeat";
    case "data":
      return "database";
    case "send":
      return "send";
    case "vrchat":
      return "globe";
    default:
      return "hash";
  }
}

/** The colour family a port type belongs to. Five, not one per type. See `app.css`. */
export type PortFamily = "json" | "string" | "number" | "boolean" | "entity";

/**
 * A port's colour family, ignoring whether it is a list.
 *
 * `list<user>` is the same green as `user`, because it carries the same kind of thing. Whether it
 * is one or several is drawn as a filled dot against a hollow one — the distinction the lattice
 * refuses to widen across, so it deserves a difference in shape rather than a sixth hue nobody can
 * name.
 */
export function portFamily(type: string): PortFamily {
  switch (elementOf(type)) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "json";
    case "friend":
    case "user":
    case "world":
    case "instance":
    case "group":
    case "avatar":
      return "entity";
    default:
      return "json";
  }
}

export function portColor(type: string): string {
  return `var(--port-${portFamily(type)})`;
}

/** True for a port that carries several of something, which is drawn hollow rather than filled. */
export function isListPort(type: string): boolean {
  return listElement(type as PortType) !== null;
}

/**
 * The dot that stands for a port: filled for one of something, hollow for several.
 *
 * `background` is what shows through the hollow ones, so it has to be whatever surface the dot is
 * sitting on — the card on the canvas, the popover of the detail panel. A hollow dot drawn against
 * the wrong surface is a filled dot in the wrong colour.
 */
export function portDotStyle(type: string, background = "var(--card)"): string {
  const color = portColor(type);
  return isListPort(type)
    ? `width:10px;height:10px;border:2px solid ${color};background:${background};`
    : `width:10px;height:10px;border:1px solid ${color};background:${color};`;
}

/**
 * A port type's element, or the type itself when it is a scalar.
 *
 * The cast is safe rather than convenient: `listElement` reads the string and nothing else, and it
 * answers null for anything that is not `list<something in the lattice>` — including the type of a
 * node whose plugin is stopped, which is a string this module has no business asserting about.
 */
function elementOf(type: string): string {
  return listElement(type as PortType) ?? type;
}
