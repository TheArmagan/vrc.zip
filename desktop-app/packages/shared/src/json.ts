/**
 * JSON as `JSON.parse` produces it.
 *
 * This lived in two places — `pipeline/events.ts` and `servers/control.ts` — each with a comment
 * explaining why it was local. The control API's read ("so the control API owns no foreign types")
 * was the right instinct aimed at the wrong type: JSON is not a foreign shape borrowed from another
 * subsystem, it is the shape of the wire itself, and every subsystem that touches the wire needs the
 * same one. Two structurally identical declarations type-check against each other silently, so the
 * duplication cost nothing until the day one of them gained a `undefined` branch and the other did
 * not — which is exactly the failure this hoist exists to prevent.
 */

/** A JSON value exactly as `JSON.parse` produces it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object exactly as `JSON.parse` produces it. */
export type JsonObject = { [key: string]: JsonValue };

/** Narrows to a JSON object. `null` is a `JsonValue` and `typeof null === "object"`, hence the guard. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
