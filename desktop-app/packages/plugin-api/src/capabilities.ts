/**
 * Host capabilities a plugin may request, and the one place they are declared.
 *
 * ## Why this is its own module rather than part of `manifest.ts`
 *
 * A capability is checked on the **call path**, beside the scope, and the call path is structurally
 * forbidden from importing `manifest.ts` — the manifest is what an author *requested*, the grant is
 * what a person *approved*, and nothing that authorises a call may consult the former. That rule is
 * what keeps `protocol.ts`, `ui.ts` and `nodes.ts` free of manifest imports.
 *
 * So the vocabulary lives here, in a leaf that imports nothing: `manifest.ts` reads it to validate
 * what an author asked for, `protocol.ts` reads it to check what the grant carries, and neither
 * needs the other. Re-exported from `manifest.ts` as well, because an author reaching for
 * `PluginCapability` should not have to know which file it sits in.
 *
 * ## What a capability is, as distinct from a scope
 *
 * A **scope** is authority over the user's VRChat account: what the daemon will ask VRChat on the
 * plugin's behalf. A **capability** is a host power that has nothing to do with VRChat — a private
 * database, a notification, an outbound request the *host* performs. They are separate because they
 * fail differently and read differently to the person granting them: `friends:read` is about other
 * people, `storage` is about this computer.
 *
 * The shape deliberately mirrors the scope registry in `@vrcz/shared/scopes`: the consent screen
 * renders both lists with the same component, and the docs generator reads both the same way.
 */

export interface PluginCapabilityDefinition {
  /** Plain English, addressed to the user granting it. Rendered verbatim on the consent screen. */
  readonly description: string;
  /** Shown in the separate block behind a second toggle, alongside dangerous scopes. */
  readonly dangerous: boolean;
}

/**
 * Every capability that exists.
 *
 * **There is no `network` capability, and there is no way to spell one** — PLAN.md §Phase 3
 * correction 1. `webhook` and `fetch:allowlist` are its two narrow, host-executed replacements, and
 * the manifest refuses `network` with a message pointing at them.
 */
export const PLUGIN_CAPABILITIES = {
  storage: {
    description: "Keep its own settings and records in a private database on this computer.",
    dangerous: false,
  },
  "storage:sql": {
    description:
      "Run raw SQL against its own private database. Only its own — it cannot reach vrc.zip's.",
    dangerous: true,
  },
  webhook: {
    description:
      "Send messages to a web address that you type into its settings. The plugin chooses what to say, never where it goes.",
    dangerous: false,
  },
  "fetch:allowlist": {
    description:
      "Ask vrc.zip to fetch pages from the specific websites listed below, and read the replies.",
    dangerous: true,
  },
  notify: {
    description: "Show you desktop and in-headset notifications.",
    dangerous: false,
  },
} as const satisfies Record<string, PluginCapabilityDefinition>;

export type PluginCapability = keyof typeof PLUGIN_CAPABILITIES;

export const ALL_PLUGIN_CAPABILITIES = Object.keys(PLUGIN_CAPABILITIES) as PluginCapability[];

export function isPluginCapability(value: string): value is PluginCapability {
  return Object.hasOwn(PLUGIN_CAPABILITIES, value);
}
