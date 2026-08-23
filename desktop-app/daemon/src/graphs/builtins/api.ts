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
 * - **Path parameters are inputs.** They are ids, and an id comes from a trigger or a value node.
 * - **Query parameters are config.** They are the knobs somebody types once: a page size, a sort
 *   order, a search term. A spec `enum` becomes a picker.
 * - **A request body is one `json` input**, because generating a port per field of every request
 *   schema would produce nodes nobody can read, and `JSON value` already exists for building one.
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

function inputsFor(operation: ApiOperation): PortDefinition[] {
  const inputs: PortDefinition[] = operation.params
    .filter((param) => param.in === "path")
    .map((param) => ({
      id: param.name,
      label: titleFor(param.name),
      type: portTypeFor(param),
      required: true,
      ...(param.description === "" ? {} : { description: param.description }),
    }));

  if (operation.hasBody) {
    inputs.push({
      id: "body",
      label: "Body",
      type: "json",
      description: "The request body, as VRChat's API documents it.",
    });
  }
  return inputs.slice(0, MAX_NODE_PORTS);
}

function configFor(operation: ApiOperation): NodeConfigField[] {
  const fields: NodeConfigField[] = [];
  for (const param of operation.params) {
    if (param.in !== "query") continue;
    const label = titleFor(param.name);
    const description = param.description;
    const common = { id: param.name, label, ...(description === "" ? {} : { description }) };

    if (param.enumValues.length > 0) {
      fields.push({
        kind: "select",
        ...common,
        options: param.enumValues.map((value) => ({ value, label: value })),
        ...(typeof param.defaultValue === "string" ? { default: param.defaultValue } : {}),
      });
      continue;
    }
    if (param.type === "number") {
      fields.push({
        kind: "number",
        ...common,
        ...(typeof param.defaultValue === "number" ? { default: param.defaultValue } : {}),
      });
      continue;
    }
    if (param.type === "boolean") {
      fields.push({
        kind: "boolean",
        ...common,
        ...(typeof param.defaultValue === "boolean" ? { default: param.defaultValue } : {}),
      });
      continue;
    }
    fields.push({
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

/** Substitutes `{userId}` from the wired inputs, encoding each one. */
export function buildPath(operation: ApiOperation, inputs: PortValues): string {
  return operation.pathTemplate.replaceAll(/\{(\w+)\}/g, (_match, name: string) => {
    const value = inputs[name];
    const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
    return encodeURIComponent(text);
  });
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

/** True when every `{placeholder}` in the path got a value. An empty one would call the wrong URL. */
export function pathIsComplete(operation: ApiOperation, inputs: PortValues): boolean {
  return operation.params
    .filter((param) => param.in === "path")
    .every((param) => {
      const value = inputs[param.name];
      return value !== undefined && value !== null && String(value) !== "";
    });
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

      if (!pathIsComplete(operation, inputs)) {
        // Nothing, which stops the run. Calling `/users//friendStatus` would either 404 or, worse,
        // hit a different endpoint than the author drew.
        return {};
      }

      const request: GraphApiRequest = {
        method: operation.method,
        path: buildPath(operation, inputs),
        query: buildQuery(operation, config),
        body: inputs.body,
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
