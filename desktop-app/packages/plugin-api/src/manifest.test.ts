import { describe, expect, test } from "bun:test";
import { PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/shared";
import {
  grantHash,
  type ManifestParseResult,
  type PluginManifest,
  type PluginManifestInput,
  parseManifest,
} from "./manifest.ts";

/** The smallest manifest that is legal: identity, entry point, and the protocol it targets. */
const MINIMAL = {
  id: "acme.friend-notes",
  name: "Friend Notes",
  version: "1.0.0",
  publisher: "Acme",
  main: "src/index.ts",
  engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
} satisfies PluginManifestInput;

function withPermissions(permissions: Record<string, unknown>): Record<string, unknown> {
  return { ...MINIMAL, permissions };
}

function expectOk(result: ManifestParseResult): PluginManifest {
  if (!result.ok) throw new Error(`expected a valid manifest, got:\n${result.message}`);
  return result.manifest;
}

function expectFailure(value: unknown): { path: string; message: string } {
  const result = parseManifest(value);
  if (result.ok) throw new Error("expected the manifest to be rejected, but it parsed");
  const first = result.issues[0];
  if (first === undefined) throw new Error("a failed parse reported no issues");
  // Every message is going in front of a person at install time, so none of them may be a bare
  // Zod string like "Invalid input" or leak an issue code.
  for (const issue of result.issues) {
    expect(issue.message.length).toBeGreaterThan(20);
    expect(issue.message).not.toMatch(/invalid_|unrecognized_keys|ZodError/);
  }
  expect(result.message).toContain(first.message);
  return { path: first.path, message: first.message };
}

function parsed(value: Record<string, unknown>): PluginManifest {
  return expectOk(parseManifest(value));
}

describe("parseManifest", () => {
  test("a minimal manifest parses and gets the safe defaults", () => {
    const manifest = parsed(MINIMAL);

    expect(manifest.id).toBe("acme.friend-notes");
    expect(manifest.performance).toBe("smol");
    expect(manifest.permissions.scopes).toEqual([]);
    expect(manifest.permissions.capabilities).toEqual([]);
    expect(manifest.permissions.events).toEqual([]);
    expect(manifest.permissions.fetch.domains).toEqual([]);
    // No account binding is requested unless the manifest says so.
    expect(manifest.permissions.accounts.mode).toBe("none");
    expect(manifest.contributes.panels).toEqual([]);
    expect(manifest.contributes.nodes).toEqual([]);
  });

  test("a fully populated manifest parses", () => {
    const manifest = parsed({
      $schema: "https://vrc.zip/schema/vrcz-plugin.json",
      ...MINIMAL,
      description: "Private notes about the people you meet.",
      homepage: "https://example.com/friend-notes",
      repository: "https://github.com/acme/friend-notes",
      license: "MIT",
      keywords: ["notes", "friends"],
      icon: "assets/icon.png",
      permissions: {
        scopes: ["friends:read", "users:read", "moderation:write"],
        accounts: { mode: "many", optional: false, reason: "Notes are kept per account." },
        events: ["friend.online", "gamelog.*", "session.start"],
        capabilities: ["storage", "webhook", "fetch:allowlist", "notify"],
        fetch: { domains: ["api.example.com", "cdn.example.com"], reason: "Avatar metadata." },
      },
      contributes: {
        panels: [{ id: "notes", title: "Notes", placement: "sidebar" }],
        settings: [
          { key: "digest-url", type: "url", label: "Daily digest webhook" },
          {
            key: "tone",
            type: "select",
            label: "Tone",
            options: [{ value: "terse", label: "Terse" }],
          },
        ],
        commands: [{ id: "export", title: "Export notes" }],
        nodes: [{ id: "note-added", title: "Note added", category: "Notes" }],
      },
      performance: "throughput",
      signing: {
        algorithm: "ed25519",
        publisherKey: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
        keyId: "2026-08",
      },
    });

    // A dangerous scope is legal to *request* — it is the consent screen that isolates it.
    expect(manifest.permissions.scopes).toContain("moderation:write");
    expect(manifest.performance).toBe("throughput");
    expect(manifest.signing?.algorithm).toBe("ed25519");
  });

  test("a missing required field names the field", () => {
    const { id, ...withoutId } = MINIMAL;
    expect(id).toBeString();
    expect(expectFailure(withoutId).path).toBe("id");

    expect(expectFailure({ ...MINIMAL, id: "Friend Notes" }).message).toContain(
      "publisher.plugin-name",
    );
    expect(expectFailure({ ...MINIMAL, version: "v1" }).message).toContain("semantic version");
    expect(expectFailure({ ...MINIMAL, main: "../../etc/passwd" }).path).toBe("main");
    expect(expectFailure({ ...MINIMAL, main: "C:\\evil.ts" }).message).toContain("forward slashes");
    expect(expectFailure({ ...MINIMAL, homepage: "not-a-url" }).message).toContain("full URL");
  });

  test("an unknown scope is rejected and quoted back", () => {
    const failure = expectFailure(withPermissions({ scopes: ["friends:reed"] }));
    expect(failure.path).toBe("permissions.scopes[0]");
    expect(failure.message).toContain('"friends:reed"');
    expect(failure.message).toContain("friends:read");
  });

  test("an unknown event kind is rejected, but a family wildcard is not", () => {
    const failure = expectFailure(withPermissions({ events: ["friend.onlin"] }));
    expect(failure.path).toBe("permissions.events[0]");
    expect(failure.message).toContain("friend.*");

    expect(expectFailure(withPermissions({ events: ["nosuchfamily.*"] })).path).toBe(
      "permissions.events[0]",
    );
    expect(
      parsed(withPermissions({ events: ["*", "gamelog.*", "friend.online"] })).permissions.events,
    ).toHaveLength(3);
  });

  test("a wildcard in fetch:allowlist is rejected", () => {
    const failure = expectFailure(
      withPermissions({
        capabilities: ["fetch:allowlist"],
        fetch: { domains: ["*.example.com"] },
      }),
    );
    expect(failure.path).toBe("permissions.fetch.domains[0]");
    expect(failure.message).toContain("wildcard");
    expect(failure.message).toContain("unbounded set");
  });

  test("fetch domains must be bare, public, lowercase hosts", () => {
    const cases: [string, string][] = [
      ["https://api.example.com/v1", "URL"],
      ["API.example.com", "lowercase"],
      ["localhost", "this computer"],
      ["127.0.0.1", "this computer"],
      ["example", "not a domain name"],
    ];
    for (const [domain, expected] of cases) {
      const failure = expectFailure(
        withPermissions({ capabilities: ["fetch:allowlist"], fetch: { domains: [domain] } }),
      );
      expect(failure.message).toContain(expected);
    }
  });

  test("the fetch capability and its domain list must agree", () => {
    expect(
      expectFailure(withPermissions({ capabilities: ["fetch:allowlist"], fetch: { domains: [] } }))
        .path,
    ).toBe("permissions.fetch.domains");

    expect(expectFailure(withPermissions({ fetch: { domains: ["api.example.com"] } })).path).toBe(
      "permissions.capabilities",
    );
  });

  test('a "network" permission is rejected and points at the two replacements', () => {
    const failure = expectFailure(withPermissions({ network: ["https://example.com"] }));
    expect(failure.path).toBe("permissions.network");
    expect(failure.message).toContain("webhook");
    expect(failure.message).toContain("fetch:allowlist");

    // Spelled as a capability instead, it gets the same answer.
    const asCapability = expectFailure(withPermissions({ capabilities: ["network"] }));
    expect(asCapability.message).toContain("webhook");
    expect(asCapability.message).toContain("fetch:allowlist");
  });

  test("a VRChat scope with no account binding is rejected", () => {
    const failure = expectFailure(
      withPermissions({ scopes: ["friends:read"], accounts: { mode: "none" } }),
    );
    expect(failure.path).toBe("permissions.accounts.mode");
    expect(failure.message).toContain("friends:read");

    // vrc.zip's own scopes are derived from local logs, so they need no account.
    expect(parsed(withPermissions({ scopes: ["sessions:read"] })).permissions.accounts.mode).toBe(
      "none",
    );
  });

  test('there is no way to ask for "all accounts"', () => {
    expect(expectFailure(withPermissions({ accounts: { mode: "all" } })).message).toContain(
      'There is no "all"',
    );
  });

  test("a future or past engines.pluginApi major is rejected", () => {
    const future = expectFailure({
      ...MINIMAL,
      engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR + 1 },
    });
    expect(future.path).toBe("engines.pluginApi");
    expect(future.message).toContain(`only speaks plugin API ${PLUGIN_API_PROTOCOL_MAJOR}`);
    expect(future.message).toContain("update vrc.zip");

    const past = expectFailure({ ...MINIMAL, engines: { pluginApi: -1 } });
    expect(past.path).toBe("engines.pluginApi");

    // A semver range is the mistake authors will import from other plugin systems.
    expect(expectFailure({ ...MINIMAL, engines: { pluginApi: "^0.1.0" } }).message).toContain(
      "whole number",
    );
  });

  test("unknown keys are rejected at every level", () => {
    const top = expectFailure({ ...MINIMAL, permisions: {} });
    expect(top.path).toBe("permisions");
    expect(top.message).toContain("refuses fields it does not recognise");

    expect(expectFailure({ ...MINIMAL, engines: { pluginApi: 0, vrczip: "1.0.0" } }).path).toBe(
      "engines.vrczip",
    );
    expect(expectFailure(withPermissions({ scopes: [], sqopes: [] })).path).toBe(
      "permissions.sqopes",
    );
    expect(
      expectFailure({
        ...MINIMAL,
        contributes: { panels: [{ id: "p", title: "P", plaicement: "sidebar" }] },
      }).path,
    ).toBe("contributes.panels[0].plaicement");
  });

  test("duplicate entries and duplicate contribution ids are rejected", () => {
    expect(expectFailure(withPermissions({ scopes: ["users:read", "users:read"] })).path).toBe(
      "permissions.scopes",
    );
    expect(
      expectFailure({
        ...MINIMAL,
        contributes: {
          panels: [
            { id: "notes", title: "One" },
            { id: "notes", title: "Two" },
          ],
        },
      }).message,
    ).toContain('"notes" twice');
  });

  test("a select setting needs options and nothing else may have them", () => {
    expect(
      expectFailure({
        ...MINIMAL,
        contributes: { settings: [{ key: "tone", type: "select", label: "Tone" }] },
      }).path,
    ).toBe("contributes.settings[0].options");

    expect(
      expectFailure({
        ...MINIMAL,
        contributes: {
          settings: [
            { key: "name", type: "string", label: "Name", options: [{ value: "a", label: "A" }] },
          ],
        },
      }).message,
    ).toContain('"select"');
  });

  test("a non-object is rejected without throwing", () => {
    for (const value of [null, undefined, 42, "{}", []]) {
      const result = parseManifest(value);
      expect(result.ok).toBe(false);
    }
  });
});

describe("grantHash", () => {
  const CONSENTED = {
    ...MINIMAL,
    permissions: {
      scopes: ["friends:read", "users:read"],
      accounts: { mode: "many" },
      events: ["friend.online", "gamelog.*"],
      capabilities: ["storage", "fetch:allowlist"],
      fetch: { domains: ["api.example.com", "cdn.example.com"] },
    },
    performance: "smol",
  } satisfies Record<string, unknown>;

  const baseline = grantHash(parsed(CONSENTED));

  test("is a hex sha256", () => {
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across key order, list order, and formatting", () => {
    const reordered = parsed({
      engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
      main: "src/index.ts",
      publisher: "Acme",
      version: "1.0.0",
      name: "Friend Notes",
      id: "acme.friend-notes",
      performance: "smol",
      permissions: {
        fetch: { domains: ["cdn.example.com", "api.example.com"] },
        capabilities: ["fetch:allowlist", "storage"],
        events: ["gamelog.*", "friend.online"],
        accounts: { mode: "many" },
        scopes: ["users:read", "friends:read"],
      },
    });
    expect(grantHash(reordered)).toBe(baseline);

    // Round-tripping through JSON must not change it either.
    expect(grantHash(parsed(JSON.parse(JSON.stringify(CONSENTED))))).toBe(baseline);
  });

  test("does not change for cosmetic edits", () => {
    const cosmetic = parsed({
      ...CONSENTED,
      description: "A completely rewritten description.",
      name: "Friend Notes (Pro)",
      publisher: "Acme Labs",
      homepage: "https://example.com/new",
      license: "Apache-2.0",
      keywords: ["a", "b"],
      icon: "assets/other.png",
      permissions: {
        ...CONSENTED.permissions,
        accounts: { mode: "many", reason: "Reworded justification." },
        fetch: { ...CONSENTED.permissions.fetch, reason: "Reworded justification." },
      },
      contributes: {
        panels: [{ id: "notes", title: "Notes" }],
        commands: [{ id: "export", title: "Export" }],
        nodes: [{ id: "note-added", title: "Note added" }],
      },
      signing: {
        algorithm: "ed25519",
        publisherKey: "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=",
      },
    });
    expect(grantHash(cosmetic)).toBe(baseline);
  });

  test("changes when any consent-relevant field changes", () => {
    const variants: [string, Record<string, unknown>][] = [
      [
        "an added scope",
        {
          ...CONSENTED,
          permissions: {
            ...CONSENTED.permissions,
            scopes: [...CONSENTED.permissions.scopes, "worlds:read"],
          },
        },
      ],
      [
        "a removed scope",
        {
          ...CONSENTED,
          permissions: { ...CONSENTED.permissions, scopes: ["friends:read"] },
        },
      ],
      [
        "a narrower account mode",
        {
          ...CONSENTED,
          permissions: { ...CONSENTED.permissions, accounts: { mode: "one" } },
        },
      ],
      [
        "an optional account binding",
        {
          ...CONSENTED,
          permissions: {
            ...CONSENTED.permissions,
            accounts: { mode: "many", optional: true },
          },
        },
      ],
      [
        "a widened event subscription",
        {
          ...CONSENTED,
          permissions: { ...CONSENTED.permissions, events: ["*"] },
        },
      ],
      [
        "an added capability",
        {
          ...CONSENTED,
          permissions: {
            ...CONSENTED.permissions,
            capabilities: [...CONSENTED.permissions.capabilities, "notify"],
          },
        },
      ],
      [
        "an added fetch domain",
        {
          ...CONSENTED,
          permissions: {
            ...CONSENTED.permissions,
            fetch: { domains: [...CONSENTED.permissions.fetch.domains, "evil.example.com"] },
          },
        },
      ],
      ["spending the user's memory", { ...CONSENTED, performance: "throughput" }],
    ];

    for (const [what, value] of variants) {
      expect(`${what}: ${grantHash(parsed(value))}`).not.toBe(`${what}: ${baseline}`);
    }
  });

  test("a version bump alone does not change it — that is what the grant key is for", () => {
    // Grants are keyed by (pluginId, version, grantHash). If the version were hashed, every release
    // would look like a permission change and the hash would tell nobody anything.
    expect(grantHash(parsed({ ...CONSENTED, version: "2.0.0" }))).toBe(baseline);
    expect(grantHash(parsed({ ...CONSENTED, id: "acme.other-plugin" }))).toBe(baseline);
  });
});
