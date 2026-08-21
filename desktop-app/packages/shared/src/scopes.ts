/**
 * The scope registry. **This is the single declaration site for every scope string in the system** —
 * the proxy's `scopeGuard`, the plugin consent screen, and the generated docs all read from here.
 * Never write a scope as a bare string literal anywhere else.
 *
 * Taxonomy is `resource:verb`, with a small number of three-segment scopes where a single operation
 * is destructive enough to deserve isolating from the rest of its resource's writes
 * (`favorites:group:clear`).
 *
 * `dangerous` scopes are shown in a separate block behind a second toggle at consent, and are
 * **never reachable through a wildcard grant** — they must be requested by name. See PLAN.md §Phase 2
 * "Enforcement".
 */
export interface ScopeDefinition {
  /** Plain English, addressed to the user granting it. Rendered verbatim in the consent UI. */
  readonly description: string;
  /** Shown separately at consent, excluded from wildcard grants, and denied by default. */
  readonly dangerous: boolean;
}

export const SCOPES = {
  "account:read": {
    description: "Read your account profile, email status, and login state.",
    dangerous: false,
  },
  "account:write": {
    description: "Change your account settings and confirm your email address.",
    dangerous: false,
  },
  "account:credentials": {
    description: "Manage your two-factor authentication, including recovery codes.",
    dangerous: true,
  },
  "account:destroy": {
    description: "Delete your VRChat account, or register new ones.",
    dangerous: true,
  },

  "avatars:read": { description: "Search and read avatars.", dangerous: false },
  "avatars:write": {
    description: "Upload, change, and delete your avatars, and switch which one you wear.",
    dangerous: false,
  },

  "calendar:read": { description: "Read group calendar events.", dangerous: false },
  "calendar:write": {
    description: "Create, edit, delete, and follow group calendar events.",
    dangerous: false,
  },

  "economy:read": {
    description: "Read your balance, purchases, subscriptions, and payout details.",
    dangerous: true,
  },
  "economy:write": {
    description: "Spend money: buy listings, and create or change things you sell.",
    dangerous: true,
  },

  "favorites:read": { description: "Read your favorites and favorite groups.", dangerous: false },
  "favorites:write": {
    description: "Add and remove individual favorites, and rename favorite groups.",
    dangerous: false,
  },
  "favorites:group:clear": {
    description: "Empty an entire favorite group at once. This cannot be undone.",
    dangerous: true,
  },

  "files:read": { description: "Read and download your uploaded files.", dangerous: false },
  "files:write": { description: "Upload files, images, and icons.", dangerous: false },
  "files:delete": {
    description: "Permanently delete your uploaded files and their versions.",
    dangerous: true,
  },

  "friends:read": {
    description: "Read your friends list and their online status.",
    dangerous: false,
  },
  "friends:write": {
    description: "Send and cancel friend requests, unfriend people, and boop them.",
    dangerous: false,
  },

  "groups:read": { description: "Read groups you can see, and their members.", dangerous: false },
  "groups:write": {
    description: "Join and leave groups, and post to ones you belong to.",
    dangerous: false,
  },
  "groups:invite": {
    description: "Invite people to your groups. They will see this as coming from you.",
    dangerous: true,
  },
  "groups:owner": {
    description:
      "Administer groups you run: kick, ban, assign roles, edit settings, read audit logs, and transfer ownership.",
    dangerous: true,
  },

  "instances:read": {
    description: "Read instance details and recent locations.",
    dangerous: false,
  },
  "instances:write": { description: "Create instances.", dangerous: false },
  "instances:close": {
    description: "Close a running instance, removing everyone in it.",
    dangerous: true,
  },

  "inventory:read": { description: "Read your inventory and drops.", dangerous: false },
  "inventory:write": {
    description: "Use, equip, share, and delete your inventory items.",
    dangerous: false,
  },

  "invite:read": { description: "Read your saved invite messages.", dangerous: false },
  "invite:write": { description: "Edit and reset your invite message slots.", dangerous: false },
  "invite:send": {
    description: "Send invites and invite requests to other people, as you.",
    dangerous: true,
  },

  "jams:read": { description: "Read jams and their submissions.", dangerous: false },
  "jams:write": { description: "Submit content to jams, and withdraw it.", dangerous: false },

  "moderation:read": {
    description: "Read who you have blocked or muted, and your moderation reports.",
    dangerous: true,
  },
  "moderation:write": {
    description: "Block, mute, and report other people, as you.",
    dangerous: true,
  },

  "notifications:read": { description: "Read your notifications and invites.", dangerous: false },
  "notifications:write": {
    description: "Accept, decline, reply to, and clear your notifications.",
    dangerous: false,
  },

  "prints:read": { description: "Read prints.", dangerous: false },
  "prints:write": { description: "Upload, edit, and delete your prints.", dangerous: false },

  "props:read": { description: "Read props.", dangerous: false },
  "props:write": {
    description: "Create, edit, publish, and delete your props.",
    dangerous: false,
  },

  "system:read": {
    description: "Read VRChat's public configuration, health, and online-user count.",
    dangerous: false,
  },

  "users:read": {
    description: "Look up users, their profiles, groups, and your notes about them.",
    dangerous: false,
  },
  "users:write": {
    description: "Edit your own profile and notes, and delete your world save data.",
    dangerous: false,
  },

  "worlds:read": { description: "Search and read worlds.", dangerous: false },
  "worlds:write": {
    description: "Create, edit, publish, and delete your worlds.",
    dangerous: false,
  },
} as const satisfies Record<string, ScopeDefinition>;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

export function isScope(value: string): value is Scope {
  return Object.hasOwn(SCOPES, value);
}

export function isDangerousScope(scope: Scope): boolean {
  return SCOPES[scope].dangerous;
}

/**
 * The scopes a grant gets when the app requested none. Read-only, and deliberately narrow: an app
 * that wants more says so, which is what makes the consent screen meaningful.
 */
export const DEFAULT_SCOPES: readonly Scope[] = [
  "account:read",
  "friends:read",
  "users:read",
  "worlds:read",
  "instances:read",
  "system:read",
] as const;

/** Expands a wildcard grant. Dangerous scopes are excluded by construction — see `SCOPES`. */
export function expandWildcard(): Scope[] {
  return ALL_SCOPES.filter((s) => !SCOPES[s].dangerous);
}
