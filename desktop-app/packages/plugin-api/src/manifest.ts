/**
 * `vrcz-plugin.json` — the plugin manifest contract.
 *
 * **The Zod schema below is the single source of truth.** The published JSON Schema, the consent
 * screen, and the docs reference are all generated from it, and the TypeScript types are *inferred*
 * from it (`z.infer`) rather than declared beside it. A hand-written type next to a schema is two
 * declarations of one contract, and they drift in the direction that hurts: the type says a field is
 * safe while the validator lets something else through. See PLAN.md §Phase 3 "Manifest, lifecycle,
 * storage".
 *
 * Two themes run through the whole file and explain most of the individual decisions:
 *
 * 1. **Strict, everywhere.** Every object rejects unknown keys. A manifest that says
 *    `"permisions"` or `"netwrok"` must fail loudly at install rather than parse into a plugin
 *    running with permissions nobody was asked about. PLAN.md: "attacks fail loudly at install with
 *    a message the user reads."
 * 2. **Errors are written for the person reading them at install time**, not for a developer with a
 *    stack trace. Every message names the field, says what was wrong with it, and where possible
 *    says what to write instead.
 */

import { createHash } from "node:crypto";
import {
  type BusEventKind,
  EVENT_FAMILIES,
  type EventFamily,
  isBusEventKind,
  isScope,
  NATIVE_SCOPES,
  PLUGIN_API_PROTOCOL_MAJOR,
  SCOPES,
  type Scope,
} from "@vrcz/shared";
import { z } from "zod";
import {
  ALL_PLUGIN_CAPABILITIES,
  isPluginCapability,
  type PluginCapability,
} from "./capabilities.ts";

/* ------------------------------------------------------------------------------------------------
 * Small validation helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * A string schema whose output type is narrowed to `T`.
 *
 * `.refine()` in Zod 4 returns the schema it was called on, so a type-guard predicate does not
 * narrow the inferred output the way it did in Zod 3. `z.custom<T>()` does, without a cast — which
 * matters here because `Scope` and {@link EventPattern} are the two places the manifest's inferred
 * type is genuinely load-bearing.
 */
function stringMatching<T extends string>(
  guard: (value: string) => boolean,
  describe: (display: string, raw: unknown) => string,
) {
  return z.custom<T>((value) => typeof value === "string" && guard(value), {
    error: (issue) => describe(showValue(issue.input), issue.input),
  });
}

/** Renders an arbitrary rejected value for an error message without dumping an object graph. */
function showValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === undefined) return "nothing";
  if (typeof value === "object" && value !== null)
    return Array.isArray(value) ? "a list" : "an object";
  return String(value);
}

/** Sorted, de-duplicated copy. Used by {@link grantHash}, never to repair a manifest. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Reports the first value that appears twice, so a duplicate can be named rather than counted. */
function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * `publisher.name`, VS Code style: lowercase, dot-separated, hyphens inside a segment.
 *
 * The id is the primary key for grants, the plugin's data directory, and the content-addressed
 * artifact path, so it is restricted to characters that are safe in all three. No uppercase (two ids
 * differing only in case would collide on a case-insensitive filesystem and not in the grant table),
 * no dot-only segments, nothing that could be read as `..`.
 */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

/** Semantic version, the official semver.org regex reduced to what a manifest may declare. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** One path segment of a relative, POSIX-style path inside the plugin directory. */
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!\.\.?(?:\/|$))(?:[\w.-]+\/)*[\w.-]+$/;

const idSchema = z.string().min(3).max(128).regex(PLUGIN_ID_PATTERN, {
  error:
    'must look like "publisher.plugin-name" — lowercase letters, digits and hyphens, at least one dot. This id is the key for your grants and your data directory, so it cannot be changed later without the user re-approving the plugin.',
});

const versionSchema = z.string().regex(SEMVER_PATTERN, {
  error:
    'must be a semantic version like "1.4.0". Grants are keyed by version, so an unparseable version means vrc.zip cannot tell an update from a downgrade.',
});

/**
 * A path relative to the plugin root. Rejects absolute paths, Windows separators, and any `..`
 * segment — the install pipeline reads these paths off disk, and a manifest is untrusted input.
 */
function relativePath(what: string) {
  return z
    .string()
    .min(1)
    .max(255)
    .regex(RELATIVE_PATH_PATTERN, {
      error: `must be a path inside the plugin folder, written with forward slashes — for example "src/${what}.ts". Absolute paths, backslashes, and ".." are refused.`,
    });
}

/* ------------------------------------------------------------------------------------------------
 * engines
 * ---------------------------------------------------------------------------------------------- */

const enginesSchema = z.strictObject({
  /**
   * The **plugin API protocol major**, not the vrc.zip version.
   *
   * Deliberately a bare integer rather than a semver range string. A range invites
   * `"engines": { "pluginApi": "^1.2.0" }`, which reads as a statement about the app's version and
   * is not one — the protocol and the app version move independently, and conflating them would
   * force a plugin-ecosystem break on every app release. One integer has exactly one meaning.
   */
  pluginApi: z
    .int({
      error: `must be a whole number: the plugin API protocol major. Write ${PLUGIN_API_PROTOCOL_MAJOR}, not a version range and not the vrc.zip version — the two are versioned separately.`,
    })
    .refine((major) => major === PLUGIN_API_PROTOCOL_MAJOR, {
      error: (issue) =>
        typeof issue.input === "number" && issue.input > PLUGIN_API_PROTOCOL_MAJOR
          ? `is ${issue.input}, but this build of vrc.zip only speaks plugin API ${PLUGIN_API_PROTOCOL_MAJOR}. The plugin is newer than the app — update vrc.zip.`
          : `is ${showValue(issue.input)}, but this build of vrc.zip only speaks plugin API ${PLUGIN_API_PROTOCOL_MAJOR}. The plugin was written for an older protocol that no longer exists — its author needs to update it.`,
    }),
});

/* ------------------------------------------------------------------------------------------------
 * permissions.capabilities
 * ---------------------------------------------------------------------------------------------- */

/*
 * The capability vocabulary moved to `capabilities.ts` and is re-exported here.
 *
 * It had to: a capability is checked on the call path beside the scope, and the call path may not
 * import this file — the manifest is the *request*, the grant is the *approval*, and nothing that
 * authorises a call is allowed to read the request. Re-exported rather than relocated silently,
 * because an author importing `PluginCapability` from `@vrcz/plugin-api` should not notice.
 */
export {
  ALL_PLUGIN_CAPABILITIES,
  isPluginCapability,
  PLUGIN_CAPABILITIES,
  type PluginCapability,
  type PluginCapabilityDefinition,
} from "./capabilities.ts";

/**
 * Why `permissions.network` does not exist, quoted at the schema so nobody re-adds it as a
 * convenience. PLAN.md §Phase 3 correction 1:
 *
 * > Arbitrary HTTP collapses the sandbox to nothing — `friends:read` + network means your friends
 * > list is on someone's server.
 *
 * The two replacements are narrow *because the host executes them*, which is also what makes them
 * loggable and rate-limitable:
 *
 * - `webhook` — the plugin supplies a JSON body; the destination is a URL **the user typed** into
 *   the plugin's settings. The plugin never learns a new place to send data to.
 * - `fetch:allowlist` — the manifest declares exact domains, each shown individually at consent, and
 *   the response is size-capped by the host. **No wildcards**: `*.example.com` is one line on a
 *   consent screen that means "any of an unbounded set of hosts, including ones that do not exist
 *   yet", so a user cannot meaningfully agree to it. An author who needs three subdomains lists
 *   three subdomains, and the user reads three lines.
 */
const NETWORK_NOTE =
  'Use "webhook" (you supply a JSON body; the user types the destination into settings) or "fetch:allowlist" with the exact domains listed under permissions.fetch.domains.';

/* ------------------------------------------------------------------------------------------------
 * permissions.fetch
 * ---------------------------------------------------------------------------------------------- */

/** A single DNS label. */
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const fetchDomainSchema = z
  .string()
  .max(253)
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });

    // Checked before the shape rule so the wildcard gets its own explanation rather than a generic
    // "not a valid domain" — this is the mistake authors will actually make.
    if (value.includes("*")) {
      fail(
        `"${value}" contains a wildcard, and wildcards are not allowed here. A consent screen has to name every site vrc.zip may talk to on the plugin's behalf, and "${value}" names an unbounded set. List each domain in full instead.`,
      );
      return;
    }
    if (value.includes("://") || value.includes("/") || value.includes(":")) {
      fail(
        `"${value}" is a URL, not a domain. Write just the host, like "api.example.com" — the scheme is always https and the path is chosen at call time.`,
      );
      return;
    }
    if (value !== value.toLowerCase()) {
      fail(
        `"${value}" must be written in lowercase, so that two spellings cannot mean two entries.`,
      );
      return;
    }
    if (value === "localhost" || value.endsWith(".localhost") || IPV4_PATTERN.test(value)) {
      // The host performs these fetches, so a loopback entry aims the host's own network position at
      // the machine it is protecting — including vrc.zip's control API on 127.0.0.1.
      fail(
        `"${value}" points at this computer. vrc.zip makes these requests itself, so a local address would let the plugin reach services on your own machine that it cannot reach directly.`,
      );
      return;
    }
    if (!DOMAIN_PATTERN.test(value)) {
      fail(
        `"${value}" is not a domain name. Write something like "api.example.com": lowercase letters, digits and hyphens, with at least one dot.`,
      );
    }
  });

const fetchSchema = z
  .strictObject({
    /**
     * Exact hosts, shown one line each at consent. Capped low on purpose: a consent screen with
     * forty domains on it is a consent screen nobody reads.
     */
    domains: z.array(fetchDomainSchema).max(20).default([]),
    /**
     * Free text shown next to the domain list, so the user learns *why* before deciding.
     * Not consent-relevant for hashing purposes — see {@link grantHash}.
     */
    reason: z.string().max(200).optional(),
  })
  .prefault({});

/* ------------------------------------------------------------------------------------------------
 * permissions.accounts
 * ---------------------------------------------------------------------------------------------- */

/**
 * How a plugin asks to be bound to accounts.
 *
 * This is a *request*, and the binding itself is chosen by the user at consent — PLAN.md: "a plugin
 * with `friends:read` must not implicitly get it for all six of your accounts." There is
 * deliberately no way to spell "all accounts": the widest a manifest can ask for is `"many"`, which
 * renders an account picker, and the picker's answer is what the grant records.
 */
const accountsSchema = z
  .strictObject({
    mode: z
      .enum(["none", "one", "many"], {
        error: `must be "none" (the plugin never touches a VRChat account), "one" (you pick a single account for it), or "many" (you pick any number). There is no "all" — which accounts a plugin gets is your choice at install time, not the author's.`,
      })
      .default("none"),
    /** True when the plugin still functions with nothing bound — the picker may then be left empty. */
    optional: z.boolean().default(false),
    /** Shown beside the account picker. Prose only; see {@link grantHash}. */
    reason: z.string().max(200).optional(),
  })
  .prefault({});

/* ------------------------------------------------------------------------------------------------
 * permissions.events
 * ---------------------------------------------------------------------------------------------- */

/**
 * A bus subscription: every event, a whole family, or one exact kind. The vocabulary is
 * `@vrcz/shared/events` — never a locally redeclared kind string.
 */
export type EventPattern = "*" | `${EventFamily}.*` | BusEventKind;

function isEventPattern(value: string): boolean {
  if (value === "*") return true;
  if (value.endsWith(".*")) {
    return (EVENT_FAMILIES as readonly string[]).includes(value.slice(0, -2));
  }
  return isBusEventKind(value);
}

/**
 * Unknown kinds are rejected rather than tolerated, which is the opposite of how the *consumer* side
 * of `EventKind` behaves (see the note at the top of `events.ts`: a kind from a newer daemon must
 * still render). The asymmetry is deliberate. A feed row with an unrecognised kind is just news; a
 * manifest with a mistyped kind is a subscription that silently never fires, and the author finds
 * out from a bug report months later. An author who genuinely wants kinds this build has not heard
 * of writes `family.*`, which is stable across daemon versions by construction.
 */
const eventPatternSchema = stringMatching<EventPattern>(
  isEventPattern,
  (value) =>
    `${value} is not an event this build of vrc.zip publishes. Write one exact kind (for example "friend.online"), a whole family with "friend.*", or "*" for everything. Families: ${EVENT_FAMILIES.join(", ")}.`,
);

/* ------------------------------------------------------------------------------------------------
 * permissions
 * ---------------------------------------------------------------------------------------------- */

const scopeSchema = stringMatching<Scope>(
  isScope,
  (value) =>
    `${value} is not a permission vrc.zip recognises. Scopes look like "friends:read" — see the scope reference for the full list of ${Object.keys(SCOPES).length}.`,
);

const permissionsSchema = z
  .strictObject({
    /**
     * VRChat (and vrc.zip control) scopes, validated against the shared registry. Dangerous scopes
     * are legal to request — they are shown in their own block behind a second toggle at consent,
     * which is where the decision belongs. A manifest that could not *ask* would just push authors
     * toward asking the user to do it by hand.
     */
    scopes: z.array(scopeSchema).max(64).default([]),
    accounts: accountsSchema,
    events: z.array(eventPatternSchema).max(64).default([]),
    capabilities: z
      .array(
        stringMatching<PluginCapability>(isPluginCapability, (display, raw) =>
          raw === "network"
            ? `"network" is not a capability, on purpose. ${NETWORK_NOTE}`
            : `${display} is not a capability vrc.zip offers. The full list is: ${ALL_PLUGIN_CAPABILITIES.join(", ")}.`,
        ),
      )
      .max(16)
      .default([]),
    /** Configuration for the `fetch:allowlist` capability. Required with it, refused without it. */
    fetch: fetchSchema,
  })
  .prefault({})
  .superRefine((permissions, ctx) => {
    const duplicates: [keyof typeof permissions & string, readonly string[]][] = [
      ["scopes", permissions.scopes],
      ["events", permissions.events],
      ["capabilities", permissions.capabilities],
    ];
    for (const [field, values] of duplicates) {
      const duplicate = firstDuplicate(values);
      if (duplicate !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `lists "${duplicate}" twice. Remove the duplicate — a repeated entry usually means two edits landed on the same list.`,
        });
      }
    }

    const duplicateDomain = firstDuplicate(permissions.fetch.domains);
    if (duplicateDomain !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fetch", "domains"],
        message: `lists "${duplicateDomain}" twice. Remove the duplicate — each domain gets one line on the consent screen.`,
      });
    }

    // The capability and its configuration are declared in two places, so the two have to agree or
    // one of them is a lie the user might read.
    const wantsFetch = permissions.capabilities.includes("fetch:allowlist");
    if (wantsFetch && permissions.fetch.domains.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["fetch", "domains"],
        message:
          'is empty, but the plugin asks for the "fetch:allowlist" capability. List the exact domains it needs, or drop the capability.',
      });
    }
    if (!wantsFetch && permissions.fetch.domains.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message:
          'does not include "fetch:allowlist", but permissions.fetch.domains lists domains. Add the capability so the domains appear on the consent screen, or remove them.',
      });
    }

    // A VRChat scope with nothing to apply it to is a permission the user grants for no effect. The
    // native scopes are the exception: sessions and webhooks are vrc.zip's own data, derived from
    // local log files rather than from any one account.
    const needsAccount = permissions.scopes.filter(
      (scope) => !(NATIVE_SCOPES as readonly string[]).includes(scope),
    );
    const first = needsAccount[0];
    if (first !== undefined && permissions.accounts.mode === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["accounts", "mode"],
        message: `is "none", but the plugin asks for "${first}", which only means anything against a VRChat account. Set it to "one" or "many" so you can choose which of your accounts the plugin sees.`,
      });
    }
  });

/* ------------------------------------------------------------------------------------------------
 * contributes
 * ---------------------------------------------------------------------------------------------- */

/** Identifiers inside a plugin's own namespace: panels, commands, settings keys, node types. */
const CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

const contributionId = z.string().min(1).max(64).regex(CONTRIBUTION_ID_PATTERN, {
  error:
    'must be a lowercase identifier like "friend-notes" or "notes.export" — letters, digits, hyphens and dots.',
});

const panelSchema = z.strictObject({
  id: contributionId,
  title: z.string().min(1).max(64),
  description: z.string().max(200).optional(),
  /** From the host's icon set by name. Never a URL — see PLAN.md §Phase 3 "Limits, kept deliberately". */
  icon: z.string().max(64).optional(),
  placement: z.enum(["sidebar", "main", "settings"]).default("sidebar"),
});

const settingSchema = z.strictObject({
  key: contributionId,
  /**
   * `url` exists as its own type because it is the destination half of the `webhook` capability:
   * the user types the URL here, and the plugin only ever supplies a body. `secret` is stored in
   * the OS credential store rather than the plugin's database.
   */
  type: z.enum(["string", "number", "boolean", "select", "url", "secret"]),
  label: z.string().min(1).max(64),
  description: z.string().max(200).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Required for `select`, refused for everything else. */
  options: z
    .array(z.strictObject({ value: z.string().min(1).max(64), label: z.string().min(1).max(64) }))
    .max(64)
    .optional(),
  required: z.boolean().default(false),
});

const commandSchema = z.strictObject({
  id: contributionId,
  title: z.string().min(1).max(64),
  description: z.string().max(200).optional(),
  icon: z.string().max(64).optional(),
});

/**
 * A node type this plugin registers with the graph editor — **the declaration only**.
 *
 * The seam is deliberate. The full `NodeDefinition` (ports, the port-type lattice, the host-evaluated
 * body template) lives in `nodes.ts` and feeds three consumers — the Svelte Flow editor, the graph
 * runtime, and the type checker. Putting it here would mean the manifest, which the consent screen
 * and the install pipeline read, also carried the graph type system; and it would mean a plugin
 * could not add a node type without a manifest change the user has to re-approve. The manifest says
 * *which* node type ids exist so grants, uninstall, and "paused and marked unavailable" have
 * something stable to key on; `nodes.ts` says what each one *is*. The install pipeline is what
 * checks that the two lists match.
 */
const nodeContributionSchema = z.strictObject({
  id: contributionId,
  title: z.string().min(1).max(64),
  category: z.string().max(64).optional(),
  description: z.string().max(200).optional(),
});

/** Rejects two contributions sharing an id, naming the field and the id. */
function checkUniqueIds(
  entries: readonly { readonly id: string }[] | readonly { readonly key: string }[],
  field: string,
  ctx: z.RefinementCtx,
): void {
  const ids = entries.map((entry) => ("id" in entry ? entry.id : entry.key));
  const duplicate = firstDuplicate(ids);
  if (duplicate !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: [field],
      message: `declares "${duplicate}" twice. Every contribution needs its own id, because that is what the host addresses it by.`,
    });
  }
}

const contributesSchema = z
  .strictObject({
    panels: z.array(panelSchema).max(32).default([]),
    settings: z.array(settingSchema).max(64).default([]),
    commands: z.array(commandSchema).max(64).default([]),
    nodes: z.array(nodeContributionSchema).max(64).default([]),
  })
  .prefault({})
  .superRefine((contributes, ctx) => {
    checkUniqueIds(contributes.panels, "panels", ctx);
    checkUniqueIds(contributes.settings, "settings", ctx);
    checkUniqueIds(contributes.commands, "commands", ctx);
    checkUniqueIds(contributes.nodes, "nodes", ctx);

    for (const [index, setting] of contributes.settings.entries()) {
      if (setting.type === "select" && (setting.options?.length ?? 0) === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", index, "options"],
          message: `is missing: the setting "${setting.key}" is a dropdown, so it needs at least one option to choose from.`,
        });
      }
      if (setting.type !== "select" && setting.options !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", index, "options"],
          message: `only applies to a setting of type "select", but "${setting.key}" is a "${setting.type}".`,
        });
      }
    }
  });

/* ------------------------------------------------------------------------------------------------
 * Signing — cut
 * ---------------------------------------------------------------------------------------------- */

/**
 * Why `signing` does not exist, quoted at the schema so nobody re-adds it as a convenience.
 *
 * This field *did* exist, declaring an Ed25519 publisher key for a detached signature the install
 * pipeline would check. PLAN.md §Phase 3 correction 5 cut the whole mechanism.
 */
const SIGNING_NOTE =
  'vrc.zip verifies no signatures. A plugin is installed from a local path or a git URL pinned to a commit, and that pin is the provenance: it says exactly what code ran, and anyone can read it afterwards. A signature checked against a key handed over in the same manifest proves only that the key signed the thing it signed, and there is no registry to distribute publisher keys through. Because nothing is signed, nothing is "more trusted" either — every plugin gets the same install confirmation, which says plainly that it can do anything your computer can do.';

/* ------------------------------------------------------------------------------------------------
 * The manifest
 * ---------------------------------------------------------------------------------------------- */

export const pluginManifestSchema = z.strictObject({
  /**
   * Editors add this automatically when a JSON Schema is available, and the schema we publish is
   * generated from this very file. Accepted and otherwise ignored — without it, every author who
   * wires up completion would hit an "unknown field" error on their first save.
   */
  $schema: z.string().max(2048).optional(),

  id: idSchema,
  name: z.string().min(1).max(64),
  version: versionSchema,
  description: z.string().max(300).optional(),
  /**
   * Display name of the author or organisation. Presentation only — anyone may write anything here,
   * and nothing verifies it. What actually pins identity is `id` plus the install source: a local
   * path, or a git URL pinned to a commit.
   */
  publisher: z.string().min(1).max(64),
  homepage: z.url({ error: "must be a full URL, like https://example.com/my-plugin." }).optional(),
  repository: z
    .url({
      error: "must be a full URL to the source repository, like https://github.com/you/repo.",
    })
    .optional(),
  license: z.string().max(64).optional(),
  keywords: z.array(z.string().min(1).max(32)).max(10).default([]),
  /** Relative path to an icon inside the plugin folder. Never a remote URL — a remote icon is a beacon. */
  icon: relativePath("icon.png").optional(),

  /** Entry point, compiled at install by `Bun.build`. See PLAN.md §"Install-time compilation". */
  main: relativePath("index"),

  engines: enginesSchema,
  permissions: permissionsSchema,
  contributes: contributesSchema,

  /**
   * Whether the plugin process is spawned with `--smol`.
   *
   * Defaults to `"smol"`, and `"throughput"` is an opt-out rather than a tuning knob: it spends
   * the *user's* memory, so it surfaces on the consent screen and is part of {@link grantHash}.
   * PLAN.md §"Isolation: child process, not Worker" — "that's their call to make, not the
   * author's to make silently."
   */
  performance: z
    .enum(["smol", "throughput"], {
      error:
        'must be "smol" (the default — the plugin runs in a small-heap process) or "throughput" (more memory, for a plugin that genuinely computes).',
    })
    .default("smol"),
});

/**
 * The parsed manifest: defaults applied, every list validated.
 *
 * Inferred from the schema, never declared beside it. See the note at the top of this file.
 */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** What an author actually writes in `vrcz-plugin.json` — defaults still optional. */
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

export type PluginPermissions = PluginManifest["permissions"];
export type PluginContributes = PluginManifest["contributes"];
export type PluginAccountMode = PluginPermissions["accounts"]["mode"];
export type PluginPerformanceMode = PluginManifest["performance"];
export type PluginPanelContribution = PluginContributes["panels"][number];
export type PluginSettingContribution = PluginContributes["settings"][number];
export type PluginCommandContribution = PluginContributes["commands"][number];
export type PluginNodeContribution = PluginContributes["nodes"][number];

/* ------------------------------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------------------------------- */

export interface ManifestIssue {
  /** Dotted path with array indices, e.g. `permissions.fetch.domains[1]`. Empty for the root. */
  readonly path: string;
  /** One sentence, written for whoever is staring at a failed install. */
  readonly message: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | {
      readonly ok: false;
      readonly issues: readonly ManifestIssue[];
      /** The issues rendered as text, ready to put in front of a person unchanged. */
      readonly message: string;
    };

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/**
 * Turns Zod's issues into sentences.
 *
 * The one piece of real translation is unknown keys. Strictness is what stops a typo'd permission
 * from parsing into something nobody granted, so the message has to explain that rather than say
 * "unrecognized_keys" — and `network` gets its own answer, because it is the field authors coming
 * from every other plugin system will reach for first.
 */
function toIssues(error: z.ZodError): ManifestIssue[] {
  return error.issues.map((issue) => {
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys;
      const parent = formatPath(issue.path);
      const where = parent === "" ? "the manifest" : parent;
      if (keys.includes("network")) {
        return {
          path: parent === "" ? "network" : `${parent}.network`,
          message: `There is no "network" permission in vrc.zip, on purpose: a plugin that can read your friends list and also call any server can put your friends list on that server. ${NETWORK_NOTE}`,
        };
      }
      // `signing` was a real field until correction 5 cut it, so a manifest carrying one is more
      // likely to be out of date than mistyped. Saying so beats "is not something the manifest
      // accepts", which reads as a typo the author cannot find.
      if (parent === "" && keys.includes("signing")) {
        return {
          path: "signing",
          message: `was removed rather than mistyped: it declared a publisher key for a signature vrc.zip no longer checks. Delete the field. ${SIGNING_NOTE}`,
        };
      }
      const first = keys[0] ?? "";
      const rest = keys.slice(1);
      const alsoNamed =
        rest.length === 0 ? "" : ` (nor ${rest.map((key) => `"${key}"`).join(", ")})`;
      return {
        path: parent === "" ? first : `${parent}.${first}`,
        message: `is not something ${where} accepts${alsoNamed}. vrc.zip refuses fields it does not recognise rather than ignoring them, because a mistyped permission would otherwise look granted while doing nothing. Check the spelling against the manifest reference.`,
      };
    }
    return { path: formatPath(issue.path), message: issue.message };
  });
}

export function formatManifestIssues(issues: readonly ManifestIssue[]): string {
  return issues
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path} ${issue.message}`))
    .join("\n");
}

/**
 * Parses a `vrcz-plugin.json` value.
 *
 * Returns a result rather than throwing: every caller — the installer, the consent screen, `vrcz
 * dev`, and the docs tooling — wants the list of problems to *show*, and a thrown `ZodError` makes
 * each of them re-derive the same formatting. A rejected manifest is a normal outcome here, not an
 * exceptional one.
 */
export function parseManifest(value: unknown): ManifestParseResult {
  const result = pluginManifestSchema.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  const issues = toIssues(result.error);
  return { ok: false, issues, message: formatManifestIssues(issues) };
}

/* ------------------------------------------------------------------------------------------------
 * Grant hashing
 * ---------------------------------------------------------------------------------------------- */

/**
 * Bumped when the *set* of hashed fields changes, so hashes from two different definitions of
 * "consent-relevant" can never collide. A bump invalidates every stored grant, which is correct: if
 * the definition changed, the old grants were made against a different question.
 */
export const GRANT_HASH_VERSION = 1;

/**
 * A stable hash over exactly the fields a user is agreeing to.
 *
 * Grants are stored immutably keyed by `(pluginId, version, grantHash)` — PLAN.md §"Manifest,
 * lifecycle, storage" — so an update that adds a scope provably re-prompts, and a downgrade cannot
 * silently reuse a grant that was broader than what the older version asked for.
 *
 * ## What is hashed
 *
 * | Field | Why |
 * |---|---|
 * | `permissions.scopes` | The authority itself. |
 * | `permissions.accounts.mode` / `.optional` | How many accounts the plugin may be pointed at. |
 * | `permissions.events` | What it gets told about, unprompted. |
 * | `permissions.capabilities` | Host powers, including storage and the two network replacements. |
 * | `permissions.fetch.domains` | Where the host will send requests on its behalf. |
 * | `performance` | Spends the user's memory, so PLAN.md puts it on the consent screen. |
 *
 * Lists are sorted and de-duplicated first, so re-ordering a JSON array is not a re-prompt.
 *
 * ## What is deliberately not hashed, and why each is safe
 *
 * - **`id` and `version`** — they are the other two components of the grant key. Hashing them would
 *   make the hash change on every release even when nothing was asked for differently, which
 *   destroys the one thing it is for: telling "this update wants more" apart from "this update is
 *   an update".
 * - **`name`, `description`, `publisher`, `homepage`, `repository`, `license`, `keywords`, `icon`,
 *   and every `reason` string** — presentation. None of them can widen what the plugin may do, and
 *   re-prompting on a typo fix trains people to click through prompts, which costs more than it
 *   buys. Identity is pinned by `id`, which is a grant-key component, not by a display name.
 * - **`contributes`** — a new panel, command, setting or node type adds *surface*, not *authority*.
 *   Every one of them still runs inside the same scopes, events and capabilities that were granted.
 *   A plugin cannot reach anything new by declaring another panel.
 * - **`main`** — the entry path does not describe what the plugin may do, and the code behind it is
 *   pinned separately and more strongly: the artifact is content-addressed
 *   (`plugins/<id>/<sha256>.js`) and its hash is verified on every load, so changing the code
 *   without changing the version is caught there rather than here.
 * - **`engines.pluginApi`** — the schema pins it to the one major this build serves, so it is a
 *   constant for any manifest that got as far as a consent screen. A constant contributes nothing.
 *
 * ## Why {@link GRANT_HASH_VERSION} did not bump when `signing` was removed
 *
 * Because `signing` was never hashed. The version guards the *set of hashed fields*, and that set is
 * unchanged: a grant made before the removal answers exactly the same question as one made after it,
 * so invalidating it would re-prompt every user for nothing. Removing an unhashed field is not a
 * change to what anybody agreed to.
 */
export function grantHash(manifest: PluginManifest): string {
  const { permissions } = manifest;
  // Object literal key order is deterministic in JS for string keys, so this serialisation is stable
  // regardless of the key order in the source JSON.
  const canonical = JSON.stringify({
    v: GRANT_HASH_VERSION,
    scopes: sortedUnique(permissions.scopes),
    accounts: { mode: permissions.accounts.mode, optional: permissions.accounts.optional },
    events: sortedUnique(permissions.events),
    capabilities: sortedUnique(permissions.capabilities),
    fetchDomains: sortedUnique(permissions.fetch.domains),
    performance: manifest.performance,
  });
  // `node:crypto` rather than `Bun.CryptoHasher` in this one package: `@vrcz/plugin-api` is
  // published to npm and its docs/JSON-Schema tooling is expected to run outside Bun too. The daemon
  // is Bun-first everywhere else.
  return createHash("sha256").update(canonical).digest("hex");
}
