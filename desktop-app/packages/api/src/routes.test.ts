import { expect, test } from "bun:test";
import { ALL_SCOPES, isScope, SCOPES } from "@vrcz/shared";
import spec from "../spec/openapi.json" with { type: "json" };
import { BASE_URL, ROUTES, routeByOperationId, SPEC_VERSION } from "./generated/routes.ts";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

function specOperations(): Array<{ method: string; path: string; operationId: string }> {
  const out: Array<{ method: string; path: string; operationId: string }> = [];
  for (const [path, item] of Object.entries(
    spec.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const operationId = (op as { operationId?: string }).operationId;
      expect(operationId, `${method.toUpperCase()} ${path} has no operationId`).toBeTruthy();
      out.push({ method: method.toUpperCase(), path, operationId: operationId as string });
    }
  }
  return out;
}

test("the route table covers every operation in the pinned spec", () => {
  // This is the test PLAN.md §1.1 calls for. Its job is to make proxy scope coverage impossible to
  // drift: if a spec bump adds an endpoint the mapping rules don't cover, codegen fails, and if
  // someone edits the generated table by hand, this fails.
  const ops = specOperations();
  expect(ROUTES.length).toBe(ops.length);

  for (const op of ops) {
    const route = ROUTES.find((r) => r.method === op.method && r.pathTemplate === op.path);
    expect(route, `${op.method} ${op.path} missing from the route table`).toBeDefined();
    expect(route?.operationId).toBe(op.operationId);
  }
});

test("every operation maps to exactly one scope, and that scope is in the registry", () => {
  for (const route of ROUTES) {
    expect(isScope(route.scope), `${route.operationId} -> unknown scope "${route.scope}"`).toBe(
      true,
    );
  }
});

test("routes are unique by (method, pathTemplate) and by operationId", () => {
  const byRoute = new Set(ROUTES.map((r) => `${r.method} ${r.pathTemplate}`));
  const byId = new Set(ROUTES.map((r) => r.operationId));
  expect(byRoute.size).toBe(ROUTES.length);
  expect(byId.size).toBe(ROUTES.length);
});

test("no scope in the registry is dead weight", () => {
  // A scope nobody can reach is a scope that shouldn't be on a consent screen.
  const used = new Set(ROUTES.map((r) => r.scope));
  const unused = ALL_SCOPES.filter((s) => !used.has(s));
  expect(unused).toEqual([]);
});

test("the operations PLAN.md hard-denies are marked hardDenied", () => {
  // PLAN.md §Phase 2 Enforcement: these are denied regardless of granted scopes.
  expect(routeByOperationId("deleteUser")?.hardDenied).toBe(true);
  expect(routeByOperationId("disable2FA")?.hardDenied).toBe(true);
  // Added by us — mass account creation from the user's own IP. See tools/src/scope-map.ts.
  expect(routeByOperationId("registerUserAccount")?.hardDenied).toBe(true);

  // And nothing else is, so a hard-deny can't be added without a deliberate edit here.
  const denied = ROUTES.filter((r) => r.hardDenied).map((r) => r.operationId);
  expect(denied.sort()).toEqual(["deleteUser", "disable2FA", "registerUserAccount"]);
});

test("abuse-adjacent operations are not reachable through an ordinary read/write scope", () => {
  // The high-risk list from PLAN.md §Phase 2. Each of these must sit behind a `dangerous` scope,
  // which is excluded from wildcard grants and shown separately at consent.
  const mustBeDangerous = [
    "inviteUser",
    "requestInvite",
    "moderateUser",
    "clearAllPlayerModerations",
    "banGroupMember",
    "kickGroupMember",
    "deleteGroup",
    "createGroupInvite",
    "clearFavoriteGroup",
    "deleteFile",
    "closeInstance",
    "purchaseProductListing",
    "enable2FA",
    "getRecoveryCodes",
  ];
  for (const operationId of mustBeDangerous) {
    const route = routeByOperationId(operationId);
    if (!route) throw new Error(`${operationId} is not in the route table`);
    expect(SCOPES[route.scope].dangerous, `${operationId} -> ${route.scope} is not dangerous`).toBe(
      true,
    );
  }
});

test("the spec facts PLAN.md relies on still hold", () => {
  expect(SPEC_VERSION).toBe("1.20.8");
  expect(BASE_URL).toBe("https://api.vrchat.cloud/api/1");
  expect(Object.keys(spec.paths).length).toBe(232);
  expect(ROUTES.length).toBe(297);
  expect(new Set(ROUTES.map((r) => r.tag)).size).toBe(19);

  // No PATCH verbs anywhere, and no apiKey query parameter — both are load-bearing assumptions.
  expect(ROUTES.some((r) => r.method === "PATCH")).toBe(false);
  expect(Object.keys(spec.components.securitySchemes)).toEqual([
    "authCookie",
    "authHeader",
    "twoFactorAuthCookie",
  ]);
});
