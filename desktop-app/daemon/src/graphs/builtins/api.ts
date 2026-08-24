/**
 * A node for every VRChat operation, generated from the pinned spec.
 *
 * `packages/api/src/generated/operations.ts` is the catalogue — 286 of the spec's 297 operations,
 * with the hard-denied three, the credential and account-destroy scopes, and `logout` excluded at
 * generation time rather than here. Nothing in this file is hand-maintained per endpoint: a spec
 * bump regenerates the catalogue and the palette grows on its own.
 *
 * ## Why generated rather than curated
 *
 * The alternative was a few dozen hand-written nodes with nicer ports, and the cost of that is a
 * palette that is permanently, invisibly incomplete: the endpoint somebody needs is the one nobody
 * wrote. The curated nodes still exist — `Look up a user` and friends in `resolvers.ts` — and they
 * are better where they overlap, because they hand back *typed* ports rather than a blob. These are
 * the floor, not the ceiling.
 *
 * ## The shape of a generated node
 *
 * - **Path parameters are inputs *and* boxes.** They are ids, so they come from a trigger or a value
 *   node — but a graph that always calls the same endpoint about the same world should not have to
 *   place a second node to say so. Each path parameter gets a port and a config field, the port
 *   wins when it is wired, and neither is marked required because either one will do.
 * - **Query parameters are config.** They are the knobs somebody types once: a page size, a sort
 *   order, a search term. A spec `enum` becomes a picker.
 * - **A request body is one `json` input, plus a box to type one into.** Generating a port per field
 *   of every request schema would produce nodes nobody can read. The port takes an object a graph
 *   built; the box takes JSON typed in, which is what a fixed body actually is.
 * - **The output is `result` plus `status`.** `Read field` is how a graph reaches into the result,
 *   which is exactly what that node is for.
 *
 * ## Paging
 *
 * One page, exactly what the endpoint does. `n` and `offset` are ordinary config fields with the
 * spec's own defaults; a graph that wants everything loops with a counter. A node that quietly made
 * twelve requests would hide the cost of the thing it is doing.
 */

import { API_OPERATIONS, type ApiOperation, type ApiOperationParam } from "@vrcz/api/operations";
import type {
  NodeConfigField,
  NodeConfigValues,
  NodeDefinition,
  PortDefinition,
  PortType,
  PortValues,
} from "@vrcz/plugin-api/nodes";
import { MAX_NODE_CONFIG_FIELDS, MAX_NODE_PORTS } from "@vrcz/plugin-api/nodes";
import type { ExecuteContext } from "../types.ts";
import type { BuiltinNode } from "./types.ts";

/** One VRChat request, as the graph runtime asks for it. */
export interface GraphApiRequest {
  readonly method: string;
  /** Already substituted and encoded: `/users/usr_123/friendStatus`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface GraphApiResponse {
  readonly status: number;
  readonly data: unknown;
}

/**
 * The seam. Satisfied by `wiring/graph-api.ts`, which owns the account, the rate limiter and the
 * User-Agent — none of which the graph runtime should know about.
 */
export type GraphApiCall = (
  accountId: string,
  request: GraphApiRequest,
) => Promise<GraphApiResponse>;

/** `getUser` -> `Get user`. Used for a node title and for a parameter label. */
export function titleFor(operationId: string): string {
  const spaced = operationId
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The node title, which is **not** just the humanised operation id.
 *
 * The `(API)` suffix exists because the curated nodes and the generated ones overlap by design, and
 * `boop` collided with `Boop` the first time these were assembled — two palette entries reading the
 * same thing, which is a palette nobody can choose from. The suffix also tells a reader which one
 * they are looking at: the plain name is the hand-written node with typed ports, and this is the
 * raw endpoint.
 */
export function nodeTitleFor(operationId: string): string {
  return `${titleFor(operationId)} (API)`;
}

/**
 * `getUser` -> `api-get-user`.
 *
 * A node id has to be lowercase and hyphenated — `validateNodeDefinition` refuses anything else,
 * which is how this was found: all 286 definitions failed at once on `api-getUser`. The `api-`
 * prefix is what keeps the generated `get-user` from colliding with the curated node of that name,
 * and a saved graph stores this string, so it may not change without a migration.
 */
export function nodeIdFor(operationId: string): string {
  const kebab = operationId
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `api-${kebab}`;
}

/**
 * The port type for a path parameter, by name.
 *
 * `userId` is a `user`, not a string, and that is the difference between an edge the lattice checks
 * and one it waves through. The names are VRChat's own and stable across the spec; anything this
 * does not recognise stays a `string`, which is honest rather than clever.
 */
export function portTypeFor(param: ApiOperationParam): PortType {
  if (param.type === "number") return "number";
  if (param.type === "boolean") return "boolean";
  switch (param.name) {
    case "userId":
    case "ownerId":
      return "user";
    case "worldId":
      return "world";
    case "avatarId":
      return "avatar";
    case "groupId":
      return "group";
    case "instanceId":
      return "instance";
    default:
      return "string";
  }
}

/**
 * The placeholder for a path parameter's box, which is the only hint about what belongs in it.
 *
 * VRChat's own descriptions say "Must be a valid user ID" without saying what one looks like, and
 * the prefix is the half somebody typing into an empty box actually needs.
 */
function placeholderFor(type: PortType): string {
  switch (type) {
    case "user":
      return "usr_…";
    case "world":
      return "wrld_…";
    case "avatar":
      return "avtr_…";
    case "group":
      return "grp_…";
    case "instance":
      return "wrld_…:12345~region(eu)";
    default:
      return "";
  }
}

/**
 * Path parameters and the body, as ports.
 *
 * **Nothing here is `required`**, and that is not laxness: each one has a config field beside it
 * now, so "this port has no edge" stopped meaning "this node cannot run". What must still be true is
 * that the value arrives *somehow*, and `pathIsComplete` is where that is checked — at run time,
 * against both halves, with a gate rather than a call to a URL with a hole in it.
 */
function inputsFor(operation: ApiOperation): PortDefinition[] {
  const inputs: PortDefinition[] = operation.params
    .filter((param) => param.in === "path")
    .map((param) => ({
      id: param.name,
      label: titleFor(param.name),
      type: portTypeFor(param),
      description:
        param.description === ""
          ? "Or type one into the box below."
          : `${param.description} Or type one into the box below.`,
    }));

  if (operation.hasBody) {
    inputs.push({
      id: "body",
      label: "Body",
      type: "json",
      description: "The request body, as VRChat's API documents it. Wins over the box below.",
    });
  }
  return inputs.slice(0, MAX_NODE_PORTS);
}

/**
 * The boxes: one per path parameter, one for the body, then the query knobs.
 *
 * Path first because it is the field a node is unusable without, and the tail is what gets cut if a
 * future spec ever pushes an operation past `MAX_NODE_CONFIG_FIELDS`. Ids are deduped for the same
 * reason: today no operation has a path and a query parameter sharing a name, and a spec bump that
 * introduced one must not silently produce two fields writing to the same key.
 */
function configFor(operation: ApiOperation): NodeConfigField[] {
  const fields: NodeConfigField[] = [];
  const taken = new Set<string>();
  const add = (field: NodeConfigField): void => {
    if (taken.has(field.id)) return;
    taken.add(field.id);
    fields.push(field);
  };

  for (const param of operation.params) {
    if (param.in !== "path") continue;
    const label = titleFor(param.name);
    const common = { id: param.name, label, description: "Used when the port is not wired." };
    if (param.type === "number") {
      add({ kind: "number", ...common });
      continue;
    }
    if (param.type === "boolean") {
      add({ kind: "boolean", ...common, default: false });
      continue;
    }
    const placeholder = placeholderFor(portTypeFor(param));
    add({ kind: "text", ...common, ...(placeholder === "" ? {} : { placeholder }) });
  }

  if (operation.hasBody) {
    add({
      kind: "text",
      id: "body",
      label: "Body",
      description: "JSON, as VRChat's API documents it. Used when the Body port is not wired.",
      placeholder: '{ "userId": "usr_…" }',
    });
  }

  for (const param of operation.params) {
    if (param.in !== "query") continue;
    const label = titleFor(param.name);
    const description = param.description;
    const common = { id: param.name, label, ...(description === "" ? {} : { description }) };

    if (param.enumValues.length > 0) {
      add({
        kind: "select",
        ...common,
        options: param.enumValues.map((value) => ({ value, label: value })),
        ...(typeof param.defaultValue === "string" ? { default: param.defaultValue } : {}),
      });
      continue;
    }
    if (param.type === "number") {
      add({
        kind: "number",
        ...common,
        ...(typeof param.defaultValue === "number" ? { default: param.defaultValue } : {}),
      });
      continue;
    }
    if (param.type === "boolean") {
      add({
        kind: "boolean",
        ...common,
        ...(typeof param.defaultValue === "boolean" ? { default: param.defaultValue } : {}),
      });
      continue;
    }
    add({
      kind: "text",
      ...common,
      ...(typeof param.defaultValue === "string" ? { default: param.defaultValue } : {}),
    });
  }
  return fields.slice(0, MAX_NODE_CONFIG_FIELDS);
}

export function definitionFor(operation: ApiOperation): NodeDefinition {
  const summary = operation.summary === "" ? operation.description : operation.summary;
  return {
    id: nodeIdFor(operation.operationId),
    kind: "action",
    title: nodeTitleFor(operation.operationId),
    description: summary === "" ? `${operation.method} ${operation.pathTemplate}` : summary,
    // One group per spec tag. With 286 of these the palette needs the grouping *and* its search
    // box; a flat list of every VRChat endpoint is a list nobody reads.
    category: `API: ${operation.tag}`,
    inputs: inputsFor(operation),
    outputs: [
      { id: "result", label: "Result", type: "json" },
      { id: "status", label: "Status", type: "number" },
    ],
    config: configFor(operation),
    body: [{ kind: "literal", text: `${operation.method} ${operation.pathTemplate}` }],
  };
}

/**
 * One path parameter's value: the wire first, then the box.
 *
 * A blank wire is not a wire — the same rule the id literals follow, and for the same reason. A
 * `Read field` that found nothing must not blank a value the author typed in and can see.
 */
export function pathValue(name: string, inputs: PortValues, config: NodeConfigValues): string {
  const wired = inputs[name];
  const fromWire = wired === undefined || wired === null ? "" : String(wired).trim();
  if (fromWire !== "") return fromWire;
  const typed = config[name];
  return typed === undefined || typed === null ? "" : String(typed).trim();
}

/** Substitutes `{userId}` from the wired inputs or the typed-in boxes, encoding each one. */
export function buildPath(
  operation: ApiOperation,
  inputs: PortValues,
  config: NodeConfigValues,
): string {
  return operation.pathTemplate.replaceAll(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(pathValue(name, inputs, config)),
  );
}

/**
 * The request body: the wired port first, then the JSON typed into the box.
 *
 * Text that will not parse **throws**, unlike `JSON value`, which produces nothing. The difference
 * is who is being told: a `JSON value` node feeding nothing gates its consumer and shows up as a
 * skipped node, while a request body is the thing this node exists to send, and "vrc.zip called
 * VRChat with no body" is a worse answer than a sentence on the error port.
 */
export function buildBody(
  operation: ApiOperation,
  inputs: PortValues,
  config: NodeConfigValues,
): unknown {
  if (!operation.hasBody) return undefined;
  if (inputs.body !== undefined) return inputs.body;
  const typed = typeof config.body === "string" ? config.body.trim() : "";
  if (typed === "") return undefined;
  try {
    return JSON.parse(typed);
  } catch {
    throw new Error("The body typed into this node is not valid JSON.");
  }
}

/** Query parameters the author actually set. A blank field is *absent*, not an empty value. */
export function buildQuery(
  operation: ApiOperation,
  config: NodeConfigValues,
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const param of operation.params) {
    if (param.in !== "query") continue;
    const value = config[param.name];
    if (value === undefined || value === "") continue;
    query[param.name] = String(value);
  }
  return query;
}

/**
 * True when every `{placeholder}` in the path got a value, from either half. An empty one would
 * call the wrong URL.
 *
 * This is where "required" actually lives now that the ports are not marked so — the check moved
 * from the port definition to the run, because a value typed into a box satisfies it just as well
 * as an edge does.
 */
export function pathIsComplete(
  operation: ApiOperation,
  inputs: PortValues,
  config: NodeConfigValues,
): boolean {
  return operation.params
    .filter((param) => param.in === "path")
    .every((param) => pathValue(param.name, inputs, config) !== "");
}

function requireAccount(context: ExecuteContext, operation: ApiOperation): string {
  if (context.accountId === null || context.accountId === "") {
    throw new Error(
      `No account is set for this graph, so vrc.zip cannot call ${operation.operationId}.`,
    );
  }
  return context.accountId;
}

export function apiNodes(call: GraphApiCall | undefined): BuiltinNode[] {
  return API_OPERATIONS.map((operation) => ({
    definition: definitionFor(operation),
    execute: async (
      inputs: PortValues,
      config: NodeConfigValues,
      context: ExecuteContext,
    ): Promise<PortValues> => {
      if (call === undefined) throw new Error("This daemon cannot call VRChat.");
      const account = requireAccount(context, operation);

      if (!pathIsComplete(operation, inputs, config)) {
        // Nothing, which stops the run. Calling `/users//friendStatus` would either 404 or, worse,
        // hit a different endpoint than the author drew.
        return {};
      }

      const request: GraphApiRequest = {
        method: operation.method,
        path: buildPath(operation, inputs, config),
        query: buildQuery(operation, config),
        body: buildBody(operation, inputs, config),
      };

      /*
       * A read runs even in a rehearsal; anything else does not.
       *
       * Dry-run exists to keep a graph from *reaching other people* before its author has armed it.
       * A GET reaches nobody, and suppressing it would leave every node downstream with no data —
       * turning the rehearsal into a test of a different graph than the one being armed. It still
       * costs rate budget, which the limiter owns either way.
       */
      if (context.dryRun && operation.method !== "GET") {
        return { status: 0 };
      }

      const response = await call(account, request);
      return { result: response.data ?? null, status: response.status };
    },
  }));
}
