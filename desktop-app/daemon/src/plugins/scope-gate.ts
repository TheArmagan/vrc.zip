/**
 * The scope gate: the one place a plugin call is checked against what the user approved.
 *
 * PLAN.md §Phase 3 is explicit — "a single dispatcher does arg parsing and the scope check — never
 * the handlers" — and this module is the half of that sentence that decides. It is pure: it reads a
 * frame and a grant and returns a verdict. Nothing here fetches, charges, or mutates, so the
 * dispatcher is left with "authorize, then charge, then invoke" and there is no second place a
 * scope could be consulted.
 *
 * Three properties are load-bearing:
 *
 *  - **Default deny.** An unknown method is `E_UNKNOWN_METHOD`, a method whose scope is not in the
 *    grant is `E_SCOPE_DENIED`, and a call naming an account the grant does not cover is
 *    `E_ACCOUNT_DENIED`. There is no path through {@link ScopeGate.check} that returns `ok` without
 *    having answered all three questions.
 *  - **Scopes come from the shared registry, not from a plugin namespace.** The strings a plugin is
 *    granted are the same strings a third-party app is granted — `friends:read` is `friends:read`
 *    — so there is one registry, one set of user-facing descriptions on the consent sheet, and one
 *    place a scope is declared. A `plugin:` namespace would have been a second registry to keep in
 *    agreement with the first.
 *  - **The gate reads the grant, never the manifest.** `@vrcz/plugin-api` deliberately keeps
 *    `protocol.ts` unable to import `manifest.ts`, because the manifest is what the author
 *    *requested* and the grant is what the person at the consent screen *approved* — narrower
 *    whenever they unticked something. Nothing in this file imports a manifest, and that is a
 *    safety property rather than tidiness.
 *
 * The account check is the one PLAN.md §Manifest calls out by name: "a plugin with `friends:read`
 * must not implicitly get it for all six of your accounts." A grant names its accounts, so a call
 * naming one outside that list is a scope failure and not a not-found.
 */

import {
  authorizeCall,
  defineMethod,
  type ErasedMethod,
  type MethodDefinition,
  type MethodTable,
  type ParseResult,
  type PluginGrant,
  type RequestFrame,
} from "@vrcz/plugin-api";
import { isJsonObject, isScope, type JsonValue, type Scope } from "@vrcz/shared";

/**
 * Whether a method acts *as an account* or not.
 *
 * A flag on the method rather than a check inside the handler, for the same reason the scope is:
 * a handler that decides whether it needs an account is a handler making an authorisation
 * decision. `"none"` is spelled out rather than defaulted so that adding a method without thinking
 * about which account it speaks for is not possible.
 */
export type AccountRequirement = "required" | "none";

/** A protocol method plus the one thing {@link ErasedMethod} cannot carry: its account posture. */
export interface GatedMethod {
  readonly method: ErasedMethod;
  readonly account: AccountRequirement;
}

export type GatedMethodTable = Readonly<Record<string, GatedMethod>>;

/**
 * Wraps a typed method definition for the table, binding `parse` to `handle` through
 * {@link defineMethod} so parse-then-handle stays atomic and a handler never sees raw parameters.
 */
export function defineGatedMethod<Params, Result extends JsonValue | undefined>(
  account: AccountRequirement,
  definition: MethodDefinition<Params, Result>,
): GatedMethod {
  return { account, method: defineMethod(definition) };
}

/** What an authorised call carries forward: the method to invoke, and who it speaks for. */
export interface AuthorizedCall {
  readonly method: ErasedMethod;
  /** Already checked against {@link PluginGrant.accountIds}. Absent for account-free methods. */
  readonly accountId?: string;
}

export interface ScopeGate {
  /** Method names in the table. Diagnostics and the docs generator, never the call path. */
  readonly methods: readonly string[];
  /**
   * The whole decision: method lookup, deadline, scope, then account.
   *
   * `now` is the host's own clock. The deadline check lives inside {@link authorizeCall} and runs
   * before the scope check on purpose — a call whose budget is already spent must not consume rate
   * limiter or storage on its way to being discarded.
   */
  check(frame: RequestFrame, grant: PluginGrant, now?: number): ParseResult<AuthorizedCall>;
}

/**
 * Builds a gate over a method table, validating the table itself first.
 *
 * A method declaring a scope that is not in the shared registry is a **host bug**, not a runtime
 * denial, so it throws here — at composition, in `app.ts`, where a developer sees it — rather than
 * failing one plugin's call at 3am. There is no honest runtime behaviour for it: the scope can
 * never appear in a grant, because a consent sheet cannot render a description that does not exist.
 */
export function createScopeGate(table: GatedMethodTable): ScopeGate {
  const plain: Record<string, ErasedMethod> = {};
  for (const [name, entry] of Object.entries(table)) {
    const scope = entry.method.scope;
    if (scope !== null && !isScope(scope)) {
      throw new Error(`Plugin method "${name}" declares "${scope}", which is not a known scope.`);
    }
    if (!Number.isInteger(entry.method.cost) || entry.method.cost < 0) {
      throw new Error(`Plugin method "${name}" has a cost that is not a non-negative integer.`);
    }
    plain[name] = entry.method;
  }
  const methodTable: MethodTable = plain;
  const methods = Object.keys(table);

  return {
    methods,
    check(frame, grant, now = Date.now()) {
      // Method lookup, deadline, and scope, in that order. Reused rather than reimplemented: a
      // second copy of the scope comparison is a second thing that can be subtly wrong.
      const authorized = authorizeCall(methodTable, frame, grant, now);
      if (!authorized.ok) return authorized;

      const entry = table[frame.method];
      if (entry === undefined) {
        // Unreachable — `plain` is built from `table` — but a lookup that returns `undefined` must
        // never fall through to "allowed" in a file whose job is default-deny.
        return { ok: false, code: "E_UNKNOWN_METHOD", message: `No such method: ${frame.method}` };
      }

      const account = resolveAccount(frame.params, grant, entry.account);
      if (!account.ok) return account;

      return {
        ok: true,
        value: {
          method: authorized.value,
          ...(account.value === undefined ? {} : { accountId: account.value }),
        },
      };
    },
  };
}

/**
 * Decides which account a call speaks for.
 *
 * `accountId` is a parameter every account-scoped method shares, read here generically rather than
 * by each method's `parse`, because the *membership* question is authorisation and authorisation
 * does not live in handlers. `parse` still owns the rest of the parameters.
 *
 * When the call names no account and the grant covers exactly one, that one is used. Anything else
 * is refused rather than guessed: picking "the first" out of six accounts would mean a plugin
 * sending traffic as whichever account happened to sort first, which is not something a user
 * consented to and not something they could predict.
 */
export function resolveAccount(
  params: JsonValue | undefined,
  grant: PluginGrant,
  requirement: AccountRequirement,
): ParseResult<string | undefined> {
  const granted = grant.accountIds;
  const named =
    isJsonObject(params) && typeof params.accountId === "string" ? params.accountId : undefined;

  if (named !== undefined) {
    // Checked even for `account: "none"`. A method that does not need an account has no business
    // being handed one, and answering "denied" costs nothing while silently ignoring it would
    // teach an author that the field is honoured.
    if (!granted.includes(named)) {
      return {
        ok: false,
        code: "E_ACCOUNT_DENIED",
        message: "This plugin was not granted access to that account.",
      };
    }
    return { ok: true, value: requirement === "none" ? undefined : named };
  }

  if (requirement === "none") return { ok: true, value: undefined };

  const only = granted[0];
  if (only === undefined) {
    return {
      ok: false,
      code: "E_ACCOUNT_DENIED",
      message: "This plugin was granted no accounts, so it cannot act as one.",
    };
  }
  if (granted.length > 1) {
    return {
      ok: false,
      code: "E_BAD_REQUEST",
      message: "This plugin is granted more than one account, so accountId is required.",
    };
  }
  return { ok: true, value: only };
}

/**
 * Whether this plugin's calls under `scope` are still shadowed.
 *
 * The seam for PLAN.md correction 4 and PROGRESS.md decision 109: outbound social actions are
 * dry-run until the user lifts it by an explicit per-plugin, per-scope gesture in the plugin's
 * management page. **Nothing in this pass is an outbound action**, so nothing calls this yet — the
 * read methods have nothing to shadow. It lives here rather than in the action step so that the
 * question "is this scope live for this plugin" has one answer, next to the grant that decides
 * every other one.
 */
export function isShadowed(grant: PluginGrant, scope: Scope | null): boolean {
  if (scope === null) return false;
  return grant.dryRunScopes?.includes(scope) ?? false;
}
