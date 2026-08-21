import type { Scope } from "@vrcz/shared";

/**
 * Spec operation -> scope. Consumed by `codegen.ts` to bake the `scope` column into the generated
 * route table, which is what the proxy's `scopeGuard` reads at request time.
 *
 * The mapping is **rule-first with an explicit override list**, rather than 297 hand-written lines.
 * A rule that covers 240 operations cannot fall out of date when the spec adds an endpoint; a hand
 * table silently would. The overrides are the cases where the rule is wrong — almost always because
 * an operation is more dangerous than its tag and verb suggest.
 *
 * Codegen fails hard if any operation resolves to no scope, so a new tag in a future spec is a build
 * error rather than an unguarded route.
 */

/** Default: the operation's first tag decides the resource. */
const TAG_RESOURCE: Record<string, string> = {
  authentication: "account",
  avatars: "avatars",
  calendar: "calendar",
  economy: "economy",
  favorites: "favorites",
  files: "files",
  friends: "friends",
  groups: "groups",
  instances: "instances",
  inventory: "inventory",
  invite: "invite",
  jams: "jams",
  miscellaneous: "system",
  notifications: "notifications",
  playermoderation: "moderation",
  prints: "prints",
  props: "props",
  users: "users",
  worlds: "worlds",
};

/** Default: GET is a read, everything else is a write. (The spec has no PATCH, HEAD, or OPTIONS.) */
function defaultVerb(method: string): "read" | "write" {
  return method === "GET" ? "read" : "write";
}

/**
 * Overrides by `operationId`. Every entry is here because the default rule under-classifies the
 * risk. Grouped by why.
 */
const OVERRIDES: Record<string, Scope> = {
  // --- Credentials. Tagged `authentication`, so the rule would call these ordinary account writes.
  // Anything that can add, remove, or read a second factor is a credential operation.
  enable2FA: "account:credentials",
  disable2FA: "account:credentials",
  cancelPending2FA: "account:credentials",
  verifyPending2FA: "account:credentials",
  verify2FA: "account:credentials",
  verify2FAEmailCode: "account:credentials",
  verifyRecoveryCode: "account:credentials",
  getRecoveryCodes: "account:credentials",

  // --- Account existence.
  deleteUser: "account:destroy",
  registerUserAccount: "account:destroy",

  // --- Moderation wearing an `authentication` tag. Reports and global avatar moderations are
  // moderation actions no matter which tag the spec files them under.
  getModerationReports: "moderation:read",
  submitModerationReport: "moderation:write",
  deleteModerationReport: "moderation:write",
  getGlobalAvatarModerations: "moderation:read",
  createGlobalAvatarModeration: "moderation:write",
  deleteGlobalAvatarModeration: "moderation:write",

  // --- Outbound social. Visible to other people, and the fastest route to getting the user
  // moderated by VRChat. See PLAN.md §Phase 3 correction 4.
  inviteUser: "invite:send",
  inviteUserWithPhoto: "invite:send",
  requestInvite: "invite:send",
  requestInviteWithPhoto: "invite:send",
  respondInvite: "invite:send",
  respondInviteWithPhoto: "invite:send",
  inviteMyselfTo: "invite:send",

  // --- Group administration. The rule would flatten all 51 group operations into read/write, which
  // would let a grant that only wanted to read group posts also ban members.
  createGroup: "groups:write",
  deleteGroup: "groups:owner",
  updateGroup: "groups:owner",
  initiateOrAcceptGroupTransfer: "groups:owner",
  cancelGroupTransfer: "groups:owner",
  getGroupTransferability: "groups:owner",
  createGroupRole: "groups:owner",
  updateGroupRole: "groups:owner",
  deleteGroupRole: "groups:owner",
  addGroupMemberRole: "groups:owner",
  removeGroupMemberRole: "groups:owner",
  banGroupMember: "groups:owner",
  unbanGroupMember: "groups:owner",
  kickGroupMember: "groups:owner",
  updateGroupMember: "groups:owner",
  respondGroupJoinRequest: "groups:owner",
  createGroupAnnouncement: "groups:owner",
  deleteGroupAnnouncement: "groups:owner",
  // Privileged reads — visible only to group staff, and each one discloses something about
  // third parties rather than about the account holder.
  getGroupAuditLogs: "groups:owner",
  getGroupAuditLogEntryTypes: "groups:owner",
  getGroupBans: "groups:owner",
  getGroupRequests: "groups:owner",
  getGroupInvites: "groups:owner",
  // Inviting into a group is outbound social, same argument as `invite:send`.
  createGroupInvite: "groups:invite",
  deleteGroupInvite: "groups:invite",

  // --- Single destructive operations isolated from their resource's ordinary writes.
  clearFavoriteGroup: "favorites:group:clear",
  deleteFile: "files:delete",
  deleteFileVersion: "files:delete",
  closeInstance: "instances:close",
};

/**
 * Denied regardless of the granted scopes, on every port, forever. Not a scope check — a hard gate
 * ahead of one. PLAN.md §Phase 2 names the first two; `registerUserAccount` is added here because
 * mass account creation through a user's own daemon and IP is the most abuse-prone operation in the
 * spec and has no legitimate third-party use in this system.
 */
export const HARD_DENIED_OPERATIONS: readonly string[] = [
  "deleteUser",
  "disable2FA",
  "registerUserAccount",
];

export function resolveScope(operationId: string, method: string, tag: string): Scope | null {
  const override = OVERRIDES[operationId];
  if (override) return override;

  const resource = TAG_RESOURCE[tag];
  if (!resource) return null;

  return `${resource}:${defaultVerb(method)}` as Scope;
}
