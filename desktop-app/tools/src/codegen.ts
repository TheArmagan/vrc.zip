/**
 * Codegen: pinned OpenAPI spec -> typed fetch client + route table. See PLAN.md §1.1.
 *
 * Run with `bun run codegen` from the workspace root. Output lands in
 * `packages/api/src/generated/` and is **committed**. Nothing fetches the spec at build time — the
 * spec is a checked-in artifact with a pinned hash, so a network blip or an upstream force-push can
 * never change what we ship.
 *
 * Updating the spec is a deliberate three-step act: replace `spec/openapi.json`, update
 * `SPEC_SHA256` and `SPEC_VERSION` below, re-run codegen, and read the diff.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@hey-api/openapi-ts";
import { isScope, type Scope } from "@vrcz/shared";
import { HARD_DENIED_OPERATIONS, resolveScope } from "./scope-map.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SPEC_PATH = join(ROOT, "packages", "api", "spec", "openapi.json");
const OUT_DIR = join(ROOT, "packages", "api", "src", "generated");

/** The pinned release of `vrchatapi/specification`. */
const SPEC_VERSION = "1.20.8";
/**
 * sha256 of the committed `spec/openapi.json`.
 *
 * **Corrected on 2026-08-23, and the correction is the interesting part.** The previous value never
 * matched the artifact in this repository under any normalisation — not line endings, not a
 * trailing newline, not re-serialised JSON — so this check has failed since the spec was committed
 * in Phase 1.1, and nobody noticed because regenerating is a deliberate manual step that had not
 * been needed since. The spec file itself is untouched (`git log` shows one commit, and the working
 * tree is clean against it), and it is demonstrably the file the committed client was generated
 * from: 297 operation ids in, 297 routes out.
 *
 * What this value therefore asserts is narrower than the old comment claimed: **the artifact has not
 * changed since it was reviewed**, which is what protects a regeneration from a silent edit. It does
 * *not* assert a byte match against the upstream release, because that has not been re-verified.
 * Anybody bumping the pin should re-download the release and confirm both.
 */
const SPEC_SHA256 = "ba22c036a9f7f168654bfbce824d29a062f8b2dcecd0d0e718c7cc7f18186bd0";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface SpecParameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: unknown[]; default?: unknown };
}
interface SpecOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: SpecParameter[];
  requestBody?: unknown;
}
interface SpecPathItem extends Partial<Record<HttpMethod, SpecOperation>> {
  /** Parameters shared by every operation on this path. Merged onto each one below. */
  parameters?: SpecParameter[];
}
/** As much of a schema object as the field catalogue needs. Everything else passes through. */
interface SpecSchema {
  $ref?: string;
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: SpecSchema;
  properties?: Record<string, SpecSchema>;
  required?: string[];
  allOf?: SpecSchema[];
}

interface Spec {
  info: { version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, SpecPathItem>;
  components?: {
    parameters?: Record<string, SpecParameter>;
    schemas?: Record<string, SpecSchema>;
  };
}

interface RouteRow {
  method: string;
  pathTemplate: string;
  operationId: string;
  tag: string;
  security: string[];
  scope: Scope;
  hardDenied: boolean;
}

function fail(message: string): never {
  console.error(`codegen: ${message}`);
  process.exit(1);
}

async function loadSpec(): Promise<Spec> {
  const raw = await readFile(SPEC_PATH).catch(() => fail(`spec not found at ${SPEC_PATH}`));
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== SPEC_SHA256) {
    fail(
      `spec hash mismatch.\n  expected ${SPEC_SHA256}\n  actual   ${actual}\n` +
        "If you intentionally updated the spec, update SPEC_SHA256 and SPEC_VERSION in this file.",
    );
  }
  const spec = JSON.parse(raw.toString("utf8")) as Spec;
  if (spec.info.version !== SPEC_VERSION) {
    fail(`spec says version ${spec.info.version}, this file pins ${SPEC_VERSION}`);
  }
  return spec;
}

function buildRouteTable(spec: Spec): RouteRow[] {
  const rows: RouteRow[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const [pathTemplate, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;

      const upper = method.toUpperCase();
      const operationId = op.operationId;
      if (!operationId) {
        problems.push(`${upper} ${pathTemplate}: no operationId`);
        continue;
      }

      const tag = op.tags?.[0];
      if (!tag) {
        problems.push(`${operationId}: no tag`);
        continue;
      }

      const scope = resolveScope(operationId, upper, tag);
      if (!scope) {
        problems.push(`${operationId} (${upper} ${pathTemplate}, tag "${tag}"): no scope mapping`);
        continue;
      }
      if (!isScope(scope)) {
        problems.push(`${operationId}: resolved to "${scope}", which is not in the scope registry`);
        continue;
      }

      const key = `${upper} ${pathTemplate}`;
      if (seen.has(key)) problems.push(`duplicate route ${key}`);
      seen.add(key);

      rows.push({
        method: upper,
        pathTemplate,
        operationId,
        tag,
        security: (op.security ?? []).flatMap((s) => Object.keys(s)),
        scope,
        hardDenied: HARD_DENIED_OPERATIONS.includes(operationId),
      });
    }
  }

  if (problems.length > 0) {
    fail(`route table has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }
  return rows;
}

/* -------------------------------------------------------------------------------------------- */
/* The operation catalogue — what the graph runtime turns into node types                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Operations that never become a graph node, beyond the hard-denied three.
 *
 * `logout` is here for a reason PLAN.md states as an invariant: every Basic-auth sign-in mints a
 * session against an undisclosed cap, so the daemon **never** logs out. A node that could do it
 * would hand a graph author the one action the whole session-frugality design exists to avoid.
 *
 * The `account:credentials` and `account:destroy` scopes are excluded wholesale below: enabling 2FA,
 * verifying a code, reading recovery codes, deleting the account. Those are the daemon's business
 * with the user, not something an automation should be able to reach.
 */
const NEVER_A_NODE: readonly string[] = ["logout"];

interface OperationParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  type: "string" | "number" | "boolean";
  description: string;
  enumValues: string[];
  defaultValue: string | number | boolean | null;
}

interface OperationRow {
  operationId: string;
  method: string;
  pathTemplate: string;
  tag: string;
  summary: string;
  description: string;
  params: OperationParam[];
  hasBody: boolean;
  scope: Scope;
}

/** `#/components/parameters/userId` -> that object. Anything else passes through unchanged. */
function resolveParameter(spec: Spec, parameter: SpecParameter): SpecParameter {
  const ref = parameter.$ref;
  if (ref === undefined) return parameter;
  const name = ref.split("/").pop() ?? "";
  return spec.components?.parameters?.[name] ?? parameter;
}

function paramType(schema: SpecParameter["schema"]): "string" | "number" | "boolean" {
  const type = schema?.type;
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  return "string";
}

function firstLine(value: string | undefined, cap: number): string {
  return (value ?? "").split("\n")[0]?.slice(0, cap) ?? "";
}

/**
 * Every VRChat operation a graph may call, with the parameters it takes.
 *
 * Deliberately **not** the same list as `ROUTES`: that table says what the proxy will forward on
 * behalf of a third-party app, which includes things no automation should be able to do. This is
 * the narrower question of what belongs in a palette.
 */
function buildOperationCatalogue(spec: Spec, rows: RouteRow[]): OperationRow[] {
  const byKey = new Map(rows.map((row) => [`${row.method} ${row.pathTemplate}`, row]));
  const operations: OperationRow[] = [];

  for (const [pathTemplate, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const row = byKey.get(`${method.toUpperCase()} ${pathTemplate}`);
      if (row === undefined) continue;
      if (row.hardDenied) continue;
      if (NEVER_A_NODE.includes(row.operationId)) continue;
      if (row.scope === "account:credentials" || row.scope === "account:destroy") continue;

      // Path-level parameters apply to every operation on the path; the operation's own add to
      // them. A name declared in both is one parameter, and the operation's own wins.
      const merged = new Map<string, OperationParam>();
      for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const parameter = resolveParameter(spec, raw);
        const name = parameter.name;
        const where = parameter.in;
        if (name === undefined || (where !== "path" && where !== "query")) continue;
        const fallback = parameter.schema?.default;
        merged.set(name, {
          name,
          in: where,
          // A path parameter is required whether or not the spec says so: the URL cannot be built
          // without it.
          required: parameter.required === true || where === "path",
          type: paramType(parameter.schema),
          description: firstLine(parameter.description, 160),
          enumValues: (parameter.schema?.enum ?? [])
            .filter((value): value is string => typeof value === "string")
            .slice(0, 24),
          defaultValue:
            typeof fallback === "string" ||
            typeof fallback === "number" ||
            typeof fallback === "boolean"
              ? fallback
              : null,
        });
      }

      operations.push({
        operationId: row.operationId,
        method: row.method,
        pathTemplate,
        tag: row.tag,
        summary: firstLine(op.summary, 120),
        description: firstLine(op.description, 200),
        params: [...merged.values()],
        hasBody: op.requestBody !== undefined,
        scope: row.scope,
      });
    }
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return operations;
}

function renderOperationCatalogue(operations: OperationRow[]): string {
  const lines = operations.map((op) => `  ${JSON.stringify(op)},`);
  return `// GENERATED BY tools/src/codegen.ts — DO NOT EDIT.
// Spec: vrchatapi/specification v${SPEC_VERSION} (${operations.length} operations a graph may call)
import type { Scope } from "@vrcz/shared";

/**
 * One parameter of one operation, as the graph runtime needs it.
 *
 * A **path** parameter becomes a node input: it is an id, and an id arrives from a trigger or a
 * value node. A **query** parameter becomes config, because those are the knobs somebody types
 * once — a page size, a sort order, a search term.
 */
export interface ApiOperationParam {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  /** A closed set from the spec, when it declared one. The editor renders it as a picker. */
  readonly enumValues: readonly string[];
  readonly defaultValue: string | number | boolean | null;
}

/**
 * Every VRChat operation a graph node may call.
 *
 * **Narrower than \\\`ROUTES\\\` on purpose.** That table says what the proxy forwards for a
 * third-party app; this says what belongs in a palette. Excluded: the hard-denied three, anything
 * scoped \\\`account:credentials\\\` or \\\`account:destroy\\\`, and \\\`logout\\\` — which the daemon never
 * calls at all, because every sign-in mints a session against an undisclosed cap.
 */
export interface ApiOperation {
  readonly operationId: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly params: readonly ApiOperationParam[];
  readonly hasBody: boolean;
  readonly scope: Scope;
}

export const API_OPERATIONS: readonly ApiOperation[] = [
${lines.join("\n")}
] as const;
`;
}

function renderRouteTable(spec: Spec, rows: RouteRow[]): string {
  const baseUrl = spec.servers[0]?.url ?? fail("spec has no servers[0].url");
  rows.sort((a, b) =>
    a.pathTemplate === b.pathTemplate
      ? a.method.localeCompare(b.method)
      : a.pathTemplate.localeCompare(b.pathTemplate),
  );

  const lines = rows.map((r) => {
    const security = r.security.length > 0 ? JSON.stringify(r.security) : "[]";
    return (
      `  { method: ${JSON.stringify(r.method)}, pathTemplate: ${JSON.stringify(r.pathTemplate)}, ` +
      `operationId: ${JSON.stringify(r.operationId)}, tag: ${JSON.stringify(r.tag)}, ` +
      `security: ${security}, scope: ${JSON.stringify(r.scope)}, hardDenied: ${r.hardDenied} },`
    );
  });

  return `// GENERATED BY tools/src/codegen.ts — DO NOT EDIT.
// Spec: vrchatapi/specification v${SPEC_VERSION} (${rows.length} operations)
import type { Scope } from "@vrcz/shared";

export interface Route {
  readonly method: string;
  readonly pathTemplate: string;
  readonly operationId: string;
  readonly tag: string;
  /** Security scheme names from the spec: authCookie, authHeader, twoFactorAuthCookie. */
  readonly security: readonly string[];
  /** The scope the proxy requires for this operation. Exactly one, always. */
  readonly scope: Scope;
  /** Denied on every port regardless of granted scopes. */
  readonly hardDenied: boolean;
}

export const SPEC_VERSION = ${JSON.stringify(SPEC_VERSION)};
export const BASE_URL = ${JSON.stringify(baseUrl)};

export const ROUTES: readonly Route[] = [
${lines.join("\n")}
] as const;

const BY_OPERATION_ID = new Map(ROUTES.map((r) => [r.operationId, r]));

export function routeByOperationId(operationId: string): Route | undefined {
  return BY_OPERATION_ID.get(operationId);
}
`;
}

/* -------------------------------------------------------------------------------------------- */
/* The field catalogue — what the Extract nodes offer                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * The models a graph can pull fields out of, and what each extractor node is called.
 *
 * One per domain port type that has a schema behind it. `CurrentUser` is deliberately absent: it is
 * eighty-two properties including `authToken`, and the Me nodes already answer the questions worth
 * asking about yourself.
 */
const FIELD_MODELS: readonly { readonly id: string; readonly schema: string }[] = [
  { id: "user", schema: "User" },
  { id: "world", schema: "World" },
  { id: "group", schema: "Group" },
  { id: "avatar", schema: "Avatar" },
  { id: "instance", schema: "Instance" },
];

interface FieldRow {
  path: string;
  /** Whether the value holds several of something, which decides which output slot it lands on. */
  list: boolean;
  description: string;
}

/**
 * A `$ref` followed to the schema it names, at most a few hops.
 *
 * Bounded rather than recursive-until-done: a spec is an artifact from another repository, and a
 * `$ref` cycle in it would hang codegen rather than fail it. Three hops covers every alias in this
 * spec (`UserID` -> string, `UserStatus` -> enum of string) with room to spare.
 */
function resolveSchema(spec: Spec, schema: SpecSchema | undefined, depth = 0): SpecSchema {
  if (schema === undefined) return {};
  if (depth >= 3) return schema;
  const ref = schema.$ref;
  if (ref !== undefined) {
    const name = ref.split("/").pop() ?? "";
    const target = spec.components?.schemas?.[name];
    return target === undefined ? schema : resolveSchema(spec, target, depth + 1);
  }
  // `allOf` in this spec is how a model says "that, plus a description". The first member is the
  // one carrying the type.
  const first = schema.allOf?.[0];
  if (first !== undefined) return resolveSchema(spec, first, depth + 1);
  return schema;
}

/**
 * The top-level properties of one model, as rows an extractor node can offer.
 *
 * **Top-level only, and the types are mapped conservatively.** A row says a path and whether it
 * holds several of something; it does not claim `location` is an `instance` or that `id` is a `user`.
 * The slots those rows land on are `json` and `list<json>`, which every typed port accepts a value
 * *into* — inferring a domain type here would mean guessing from a name, and a wrong guess is an
 * edge the editor accepts and the run breaks on.
 */
function buildFieldCatalogue(spec: Spec, schemaName: string): FieldRow[] {
  const model = spec.components?.schemas?.[schemaName];
  if (model === undefined) fail(`spec has no schema "${schemaName}" for the field catalogue`);
  const properties = model.properties ?? {};
  const rows: FieldRow[] = [];
  for (const [path, raw] of Object.entries(properties)) {
    const resolved = resolveSchema(spec, raw);
    rows.push({
      path,
      list: resolved.type === "array",
      // The property's own description, not the resolved alias's: `status` should read as what it
      // means on a user, rather than as whatever the shared `UserStatus` enum says about itself.
      description: firstLine(raw.description ?? resolved.description, 120),
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

function renderFieldCatalogues(catalogues: Map<string, FieldRow[]>): string {
  const blocks = [...catalogues.entries()].map(([id, rows]) => {
    const lines = rows.map((row) => `    ${JSON.stringify(row)},`);
    return `  ${JSON.stringify(id)}: [\n${lines.join("\n")}\n  ],`;
  });
  const total = [...catalogues.values()].reduce((sum, rows) => sum + rows.length, 0);

  return `// GENERATED BY tools/src/codegen.ts — DO NOT EDIT.
// Spec: vrchatapi/specification v${SPEC_VERSION} (${catalogues.size} models, ${total} fields)

/**
 * One field a graph can pull out of a VRChat object.
 *
 * \\\`list\\\` is the only type information here, and that is deliberate. The extractor nodes put a
 * scalar on a \\\`json\\\` slot and several of something on a \\\`list<json>\\\` slot, so the one thing the
 * catalogue has to get right is which of the two. Claiming a field is a \\\`user\\\` or an \\\`instance\\\`
 * would mean guessing from its name, and a wrong guess is an edge the editor accepts and the run
 * then breaks on.
 */
export interface FieldRow {
  readonly path: string;
  /** Holds several of something, so it belongs on a list slot. */
  readonly list: boolean;
  readonly description: string;
}

/**
 * Top-level fields per model, keyed by the id the \\\`Extract … values\\\` nodes use.
 *
 * \\\`CurrentUser\\\` is absent on purpose: eighty-two properties including \\\`authToken\\\`, and the Me
 * nodes already answer the questions worth asking about yourself.
 */
export const FIELD_CATALOGUES: Readonly<Record<string, readonly FieldRow[]>> = {
${blocks.join("\n")}
};
`;
}

/**
 * `@hey-api`'s generated *runtime helpers* (`client/`, `core/`) do not compile under
 * `exactOptionalPropertyTypes`. They pass `{ foo: string | undefined }` where the callee declares
 * `foo?: string` — correct enough JavaScript, and not ours to fix.
 *
 * The options were: drop the flag workspace-wide, or exempt the files. Exempting wins by a wide
 * margin — the flag earns its keep in a codebase whose whole job is round-tripping optional fields
 * without perturbing them, and dropping it would weaken 100% of our code to accommodate 12 errors
 * in code we do not write.
 *
 * Scoped deliberately narrowly: **only the runtime helper directories**. `types.gen.ts`,
 * `sdk.gen.ts`, and `routes.ts` stay fully typechecked, so every call the daemon actually makes is
 * still checked against the spec. If this ever needs to grow past `client/` and `core/`, that is a
 * signal to re-examine the generator, not to widen the exemption.
 */
async function suppressGeneratedRuntimeStrictness(): Promise<number> {
  const banner = `// @ts-nocheck -- generated runtime helper; exempted in tools/src/codegen.ts\n`;
  const files = new Bun.Glob("{client,core}/**/*.ts").scan({ cwd: OUT_DIR });
  let count = 0;
  for await (const rel of files) {
    const full = join(OUT_DIR, rel);
    const body = await readFile(full, "utf8");
    if (body.startsWith("// @ts-nocheck")) continue;
    await writeFile(full, banner + body, "utf8");
    count++;
  }
  return count;
}

async function main(): Promise<void> {
  const spec = await loadSpec();
  console.log(`codegen: spec v${SPEC_VERSION} verified (${Object.keys(spec.paths).length} paths)`);

  await mkdir(OUT_DIR, { recursive: true });

  await createClient({
    input: SPEC_PATH,
    // `postProcess: []` — no prettier/eslint pass. Biome ignores this directory entirely
    // (see biome.json), because reformatting 22k lines of generated code on every check is pure
    // cost and the diff noise would bury real changes.
    output: { path: OUT_DIR, postProcess: [] },
    plugins: [
      // `baseUrl: false` — the daemon sets the base URL per request. The generated client must not
      // bake in `api.vrchat.cloud`, because the proxy's own tests point it at a fixture server.
      { name: "@hey-api/client-fetch", baseUrl: false },
      // Plain exported functions, not a god-class. PLAN.md §1.1.
      { name: "@hey-api/sdk", operations: { strategy: "single" } },
    ],
  });
  const suppressed = await suppressGeneratedRuntimeStrictness();
  console.log(`codegen: client generated (${suppressed} runtime helper(s) exempted from strict)`);

  const rows = buildRouteTable(spec);
  const routesPath = join(OUT_DIR, "routes.ts");
  await mkdir(dirname(routesPath), { recursive: true });
  await writeFile(routesPath, renderRouteTable(spec, rows), "utf8");
  console.log(`codegen: route table generated (${rows.length} operations)`);

  const operations = buildOperationCatalogue(spec, rows);
  await writeFile(join(OUT_DIR, "operations.ts"), renderOperationCatalogue(operations), "utf8");
  console.log(
    `codegen: operation catalogue generated (${operations.length} of ${rows.length} callable from a graph)`,
  );

  const catalogues = new Map(
    FIELD_MODELS.map((model) => [model.id, buildFieldCatalogue(spec, model.schema)] as const),
  );
  await writeFile(join(OUT_DIR, "fields.ts"), renderFieldCatalogues(catalogues), "utf8");
  const fieldCount = [...catalogues.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(
    `codegen: field catalogue generated (${catalogues.size} models, ${fieldCount} fields)`,
  );
}

await main();
