import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { SQL } from "./queries.ts";
import type { Migration } from "./schema/index.ts";
import type {
  AccountRow,
  AuditRow,
  AvatarHistoryRow,
  CacheRow,
  EventRow,
  EventsDailyRow,
  FriendLogHistoryRow,
  FriendLogRow,
  GrantRow,
  KindCount,
  NewAuditEntry,
  NewEvent,
  NewFriendLogHistory,
  NewGrant,
  NewPairingRequest,
  NewSession,
  NoteRow,
  NotificationRow,
  PairingRequestRow,
  RetentionConfigRow,
  SessionRow,
} from "./types.ts";

/** In-memory database path. Tests use this; the daemon passes a real file. */
export const MEMORY = ":memory:";

/** Options for {@link Store.open}. */
export type StoreOptions = {
  /** Override the migration list. Only tests should need this. */
  readonly migrations?: readonly Migration[];
  /** Skip `journal_mode = WAL`. Set automatically for `:memory:`. */
  readonly wal?: boolean;
};

type Stmt<Row, Params extends SQLQueryBindings[]> = Statement<Row, Params>;

/**
 * The daemon's single SQLite handle.
 *
 * Opening a `Store` creates the file if needed, applies the connection pragmas, and runs any
 * pending migrations — there is no separate "initialise" step to forget. Every query method is
 * backed by a statement prepared once in the constructor.
 *
 * All timestamps crossing this API are unix milliseconds.
 */
export class Store {
  readonly db: Database;
  readonly path: string;
  readonly schemaVersion: number;

  private readonly stmts: ReturnType<typeof prepareAll>;

  private constructor(path: string, options: StoreOptions) {
    this.path = path;
    this.db = new Database(path, { create: true });
    applyPragmas(this.db, options.wal ?? path !== MEMORY);
    this.schemaVersion =
      options.migrations === undefined ? migrate(this.db) : migrate(this.db, options.migrations);
    this.stmts = prepareAll(this.db);

    // Before anything else touches sessions: a row still open here belongs to a process that is
    // no longer running. See `closeOrphanedSessions`.
    this.orphanedSessionsClosed = this.closeOrphanedSessions();
  }

  /**
   * How many stale open sessions the constructor closed. Surfaced so the composition root can log
   * it — a daemon that silently inherits ghost sessions is how "the game closed but it still shows
   * as live" goes unnoticed.
   */
  readonly orphanedSessionsClosed: number;

  /** Opens (creating if absent) the database at `path` and brings its schema up to date. */
  static open(path: string, options: StoreOptions = {}): Store {
    return new Store(path, options);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside a single SQLite transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // -- accounts -------------------------------------------------------------

  upsertAccount(row: AccountRow): void {
    this.stmts.upsertAccount.run(
      row.id,
      row.display_name,
      row.added_at,
      row.enabled,
      row.last_seen_at,
    );
  }

  getAccount(id: string): AccountRow | null {
    return this.stmts.getAccount.get(id);
  }

  listAccounts(): AccountRow[] {
    return this.stmts.listAccounts.all();
  }

  setAccountEnabled(id: string, enabled: boolean): void {
    this.stmts.setAccountEnabled.run(enabled ? 1 : 0, id);
  }

  touchAccount(id: string, at: number): void {
    this.stmts.touchAccount.run(at, id);
  }

  deleteAccount(id: string): void {
    this.stmts.deleteAccount.run(id);
  }

  // -- sessions -------------------------------------------------------------

  /** Inserts a session (or returns the existing one for the same log file + start time). */
  startSession(session: NewSession): number {
    const row = this.stmts.insertSession.get(
      session.account_id,
      session.display_name,
      session.log_path,
      session.log_inode,
      session.started_at,
      session.vr_mode,
      session.current_location,
      session.current_world_id,
    );
    if (row === null) throw new Error("startSession: insert returned no id");
    return row.id;
  }

  endSession(id: number, endedAt: number, exitKind: string | null): void {
    this.stmts.endSession.run(endedAt, exitKind, id);
  }

  updateSessionLocation(id: number, location: string | null, worldId: string | null): void {
    this.stmts.updateSessionLocation.run(location, worldId, id);
  }

  /**
   * Writes retroactive attribution onto a session: which account owns this log file, its display
   * name, and the VR mode. All three arrive *after* the row exists — the `User Authenticated:`
   * line is seconds into the log — so without this the row keeps the nulls it was created with and
   * every session shows as unlinked forever.
   *
   * `undefined` means "not in this patch" and leaves the column alone. `null` means the same, by
   * design: identity only ever becomes more known. See `SQL.updateSessionIdentity`.
   */
  updateSessionIdentity(
    id: number,
    patch: {
      account_id?: string | null;
      display_name?: string | null;
      vr_mode?: string | null;
    },
  ): void {
    this.stmts.updateSessionIdentity.run(
      patch.account_id ?? null,
      patch.display_name ?? null,
      patch.vr_mode ?? null,
      id,
    );
  }

  /**
   * Closes every session left open by a previous process. Returns how many were closed.
   *
   * Called once at open. A row still open at that moment cannot belong to this run, and leaving it
   * would show a game client that exited hours ago as live — one ghost card per daemon restart,
   * which under `bun --watch` is one per code edit. The watcher immediately re-adopts whichever
   * files are genuinely still being written, and `startSession`'s upsert clears `ended_at` again
   * for those, so a real live session survives this sweep.
   */
  closeOrphanedSessions(): number {
    return this.db.run(SQL.closeOrphanedSessions).changes;
  }

  getSession(id: number): SessionRow | null {
    return this.stmts.getSession.get(id);
  }

  listOpenSessions(): SessionRow[] {
    return this.stmts.listOpenSessions.all();
  }

  listSessions(accountId: string, limit = 50): SessionRow[] {
    return this.stmts.listSessions.all(accountId, limit);
  }

  // -- events ---------------------------------------------------------------

  insertEvent(event: NewEvent): number {
    const changes = this.stmts.insertEvent.run(
      event.account_id,
      event.ts,
      event.session_id,
      event.kind,
      event.subject_id,
      event.location,
      event.payload,
    );
    return Number(changes.lastInsertRowid);
  }

  /** Bulk insert in one transaction — the pipeline flushes batches through here. */
  insertEvents(events: readonly NewEvent[]): number {
    return this.transaction(() => {
      let n = 0;
      for (const event of events) {
        this.insertEvent(event);
        n += 1;
      }
      return n;
    });
  }

  /**
   * Newest-first feed page for one account. `before` is an exclusive upper bound on `ts`;
   * `kind` narrows to a single event kind, and `null` means every kind.
   *
   * The `kind` filter is a SQL predicate rather than a `.filter()` on the result, in every one of
   * these four: filtering after `LIMIT` returns a page shorter than asked for and then an empty
   * one, which the infinite scroll reads as the end of history.
   */
  listEvents(
    accountId: string,
    before: number,
    limit: number,
    kind: string | null = null,
  ): EventRow[] {
    return kind === null
      ? this.stmts.listEvents.all(accountId, before, limit)
      : this.stmts.listEventsOfKind.all(accountId, kind, before, limit);
  }

  /**
   * Newest-first feed page across *every* account, including rows with `account_id IS NULL`.
   *
   * Those nulls are the whole reason this exists as its own query. A game client signed into an
   * account vrc.zip does not manage is a normal state (PLAN.md §1.7), and fanning `listEvents` out
   * over the known accounts — the shape the control API used to have — can never return them.
   */
  listAllEvents(before: number, limit: number, kind: string | null = null): EventRow[] {
    return kind === null
      ? this.stmts.listAllEvents.all(before, limit)
      : this.stmts.listAllEventsOfKind.all(kind, before, limit);
  }

  /** Newest-first page of one game client's events — `sessions.id`, not an account. */
  listEventsBySession(
    sessionId: number,
    before: number,
    limit: number,
    kind: string | null = null,
  ): EventRow[] {
    return kind === null
      ? this.stmts.listEventsBySession.all(sessionId, before, limit)
      : this.stmts.listEventsBySessionOfKind.all(sessionId, kind, before, limit);
  }

  /** Newest-first page of everything ever recorded about one subject, across all accounts. */
  listEventsBySubject(
    subjectId: string,
    before: number,
    limit: number,
    kind: string | null = null,
  ): EventRow[] {
    return kind === null
      ? this.stmts.listEventsBySubject.all(subjectId, before, limit)
      : this.stmts.listEventsBySubjectOfKind.all(subjectId, kind, before, limit);
  }

  /** Row count per event kind — the number Settings shows next to each retention window. */
  countEventsByKind(): KindCount[] {
    return this.stmts.countEventsByKind.all();
  }

  distinctEventKinds(): string[] {
    return this.stmts.distinctEventKinds.all().map((row) => row.kind);
  }

  listEventsDaily(accountId: string, fromDay: number, toDay: number): EventsDailyRow[] {
    return this.stmts.listEventsDaily.all(accountId, fromDay, toDay);
  }

  // -- friend log -----------------------------------------------------------

  upsertFriend(row: FriendLogRow): void {
    this.stmts.upsertFriend.run(
      row.account_id,
      row.user_id,
      row.display_name,
      row.trust_level,
      row.friended_at,
      row.unfriended_at,
    );
  }

  getFriend(accountId: string, userId: string): FriendLogRow | null {
    return this.stmts.getFriend.get(accountId, userId);
  }

  listFriends(accountId: string): FriendLogRow[] {
    return this.stmts.listFriends.all(accountId);
  }

  insertFriendHistory(row: NewFriendLogHistory): void {
    this.stmts.insertFriendHistory.run(
      row.account_id,
      row.ts,
      row.type,
      row.user_id,
      row.display_name,
      row.previous_display_name,
      row.trust_level,
      row.previous_trust_level,
    );
  }

  listFriendHistory(accountId: string, before: number, limit: number): FriendLogHistoryRow[] {
    return this.stmts.listFriendHistory.all(accountId, before, limit);
  }

  // -- caches ---------------------------------------------------------------

  /**
   * Caches one `GET /users/{id}` body **as seen by one account**.
   *
   * `accountId` is part of the key, not incidental: VRChat returns different fields to a friend
   * than to a stranger, so a cache shared across accounts serves one account the other's view.
   * See migration 002.
   */
  putUserCache(accountId: string, userId: string, fetchedAt: number, data: string): void {
    this.stmts.putUserCache.run(accountId, userId, fetchedAt, data);
  }

  getUserCache(accountId: string, userId: string): CacheRow | null {
    return this.stmts.getUserCache.get(accountId, userId);
  }

  putWorldCache(worldId: string, fetchedAt: number, data: string): void {
    this.stmts.putWorldCache.run(worldId, fetchedAt, data);
  }

  getWorldCache(worldId: string): CacheRow | null {
    return this.stmts.getWorldCache.get(worldId);
  }

  putAvatarCache(avatarId: string, fetchedAt: number, data: string): void {
    this.stmts.putAvatarCache.run(avatarId, fetchedAt, data);
  }

  getAvatarCache(avatarId: string): CacheRow | null {
    return this.stmts.getAvatarCache.get(avatarId);
  }

  // -- notes ----------------------------------------------------------------

  putNote(accountId: string, userId: string, note: string, updatedAt: number): void {
    this.stmts.putNote.run(accountId, userId, note, updatedAt);
  }

  getNote(accountId: string, userId: string): NoteRow | null {
    return this.stmts.getNote.get(accountId, userId);
  }

  deleteNote(accountId: string, userId: string): void {
    this.stmts.deleteNote.run(accountId, userId);
  }

  // -- notifications --------------------------------------------------------

  putNotification(row: NotificationRow): void {
    this.stmts.putNotification.run(
      row.id,
      row.account_id,
      row.ts,
      row.type,
      row.sender_user_id,
      row.sender_display_name,
      row.message,
      row.seen,
      row.data,
    );
  }

  listNotifications(accountId: string, limit = 100): NotificationRow[] {
    return this.stmts.listNotifications.all(accountId, limit);
  }

  markNotificationSeen(id: string): void {
    this.stmts.markNotificationSeen.run(id);
  }

  // -- avatar history -------------------------------------------------------

  recordAvatarSeen(accountId: string, avatarId: string, at: number): void {
    this.stmts.recordAvatarSeen.run(accountId, avatarId, at, at);
  }

  listAvatarHistory(accountId: string, limit = 100): AvatarHistoryRow[] {
    return this.stmts.listAvatarHistory.all(accountId, limit);
  }

  // -- retention config -----------------------------------------------------

  listRetentionConfig(): RetentionConfigRow[] {
    return this.stmts.listRetentionConfig.all();
  }

  setRetentionConfig(kind: string, retainDays: number, updatedAt: number): void {
    if (!Number.isInteger(retainDays) || retainDays <= 0) {
      throw new RangeError(`retain_days must be a positive integer, got ${retainDays}`);
    }
    this.stmts.setRetentionConfig.run(kind, retainDays, updatedAt);
  }

  deleteRetentionConfig(kind: string): void {
    this.stmts.deleteRetentionConfig.run(kind);
  }

  // -- proxy grants (Phase 2) -----------------------------------------------

  /**
   * Files a new grant. `token_hash` and `two_factor_hash` are hashes — this method never sees, and
   * must never be handed, the plaintext cookie value. See `security/proxy-tokens.ts`.
   */
  insertGrant(grant: NewGrant): void {
    this.stmts.insertGrant.run(
      grant.id,
      grant.account_id,
      grant.app_name,
      grant.app_version,
      grant.app_contact,
      grant.scopes,
      grant.token_hash,
      grant.two_factor_hash,
      grant.created_at,
    );
  }

  /** The live grant for a presented token hash, or null. Revoked grants are never returned. */
  grantByTokenHash(tokenHash: string): GrantRow | null {
    return this.stmts.getGrantByTokenHash.get(tokenHash) ?? null;
  }

  grantByTwoFactorHash(hash: string): GrantRow | null {
    return this.stmts.getGrantByTwoFactorHash.get(hash) ?? null;
  }

  getGrant(id: string): GrantRow | null {
    return this.stmts.getGrant.get(id) ?? null;
  }

  /** The live grant this app already holds for this account, if any. Drives scope escalation. */
  findGrantForApp(accountId: string, appName: string, appContact: string): GrantRow | null {
    return this.stmts.findGrantForApp.get(accountId, appName, appContact) ?? null;
  }

  listGrants(accountId?: string): GrantRow[] {
    return accountId === undefined
      ? this.stmts.listGrants.all()
      : this.stmts.listGrantsForAccount.all(accountId);
  }

  touchGrant(id: string, at: number): void {
    this.stmts.touchGrant.run(at, id);
  }

  setGrantTwoFactorHash(id: string, hash: string | null): void {
    this.stmts.setGrantTwoFactorHash.run(hash, id);
  }

  /** Revokes one grant. Idempotent: revoking an already-revoked grant changes nothing. */
  revokeGrant(id: string, at: number): void {
    this.stmts.revokeGrant.run(at, id);
  }

  /** The kill switch, per account or global. Returns how many live grants it closed. */
  revokeGrants(at: number, accountId?: string): number {
    const closed = this.listGrants(accountId).filter((g) => g.revoked_at === null).length;
    if (accountId === undefined) this.stmts.revokeAllGrants.run(at);
    else this.stmts.revokeGrantsForAccount.run(at, accountId);
    return closed;
  }

  insertPairingRequest(request: NewPairingRequest): void {
    this.stmts.insertPairingRequest.run(
      request.id,
      request.account_id,
      request.requested_username,
      request.app_name,
      request.app_version,
      request.app_contact,
      request.scopes,
      request.half_token_hash,
      request.code_hash,
      request.created_at,
      request.expires_at,
    );
  }

  getPairingRequest(id: string): PairingRequestRow | null {
    return this.stmts.getPairingRequest.get(id) ?? null;
  }

  /** The pending request an app's half-authenticated cookie belongs to. Expired rows never match. */
  pairingByHalfToken(halfTokenHash: string, now: number): PairingRequestRow | null {
    return this.stmts.getPairingByHalfToken.get(halfTokenHash, now) ?? null;
  }

  listPendingPairings(now: number): PairingRequestRow[] {
    return this.stmts.listPendingPairings.all(now);
  }

  /** Wrong-code attempts by this app identity since `since`. The brute-force brake. */
  countPairingAttempts(appName: string, appContact: string, since: number): number {
    return this.stmts.countPairingAttemptsSince.get(appName, appContact, since)?.count ?? 0;
  }

  bumpPairingAttempts(id: string): void {
    this.stmts.bumpPairingAttempts.run(id);
  }

  setPairingAccount(id: string, accountId: string): void {
    this.stmts.setPairingAccount.run(accountId, id);
  }

  resolvePairing(id: string, at: number, outcome: string, grantId: string | null): void {
    this.stmts.resolvePairing.run(at, outcome, grantId, id);
  }

  /** Marks every lapsed pending request expired. Returns how many. */
  expirePairings(now: number): number {
    const stale = this.stmts.listPendingPairings.all(0).filter((row) => row.expires_at <= now);
    this.stmts.expirePairings.run(now, now);
    return stale.length;
  }

  /** Records one mutating proxy call. Reads are deliberately not audited — see 003. */
  appendAudit(entry: NewAuditEntry): void {
    this.stmts.insertAudit.run(
      entry.ts,
      entry.grant_id,
      entry.account_id,
      entry.app_name,
      entry.method,
      entry.path,
      entry.operation_id,
      entry.scope,
      entry.outcome,
      entry.status,
    );
  }

  listAudit(options: { grantId?: string; before?: number; limit?: number } = {}): AuditRow[] {
    const before = options.before ?? Date.now() + 1;
    const limit = options.limit ?? 100;
    return options.grantId === undefined
      ? this.stmts.listAudit.all(before, limit)
      : this.stmts.listAuditForGrant.all(options.grantId, before, limit);
  }

  // -- meta / housekeeping --------------------------------------------------

  getMeta(key: string): string | null {
    return this.stmts.getMeta.get(key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }

  /** Bytes the database occupies on disk (page_count * page_size). */
  dbSizeBytes(): number {
    const row = this.db
      .query<{ size: number }, []>(
        `SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS size`,
      )
      .get();
    return row?.size ?? 0;
  }

  /**
   * Reclaims up to `pages` freelist pages. Only does anything with
   * `auto_vacuum = INCREMENTAL`, which {@link applyPragmas} sets before the first table exists.
   */
  incrementalVacuum(pages?: number): void {
    this.db.run(
      pages === undefined ? `PRAGMA incremental_vacuum` : `PRAGMA incremental_vacuum(${pages})`,
    );
  }
}

/**
 * Connection pragmas. `auto_vacuum` has to be set before any table is created for a fresh
 * database to pick it up, which is why this runs before the migrations rather than inside them
 * (`journal_mode` and `auto_vacuum` also cannot be changed inside a transaction).
 */
function applyPragmas(db: Database, wal: boolean): void {
  db.run(`PRAGMA auto_vacuum = INCREMENTAL`);
  if (wal) db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`PRAGMA synchronous = NORMAL`);
  db.run(`PRAGMA busy_timeout = 5000`);
}

/** Prepares every statement once, at open time, so no query path compiles SQL on the fly. */
function prepareAll(db: Database) {
  const q = <Row, Params extends SQLQueryBindings[]>(sql: string): Stmt<Row, Params> =>
    db.query(sql) as unknown as Stmt<Row, Params>;

  return {
    upsertAccount: q<void, [string, string, number, number, number | null]>(SQL.upsertAccount),
    getAccount: q<AccountRow, [string]>(SQL.getAccount),
    listAccounts: q<AccountRow, []>(SQL.listAccounts),
    setAccountEnabled: q<void, [number, string]>(SQL.setAccountEnabled),
    touchAccount: q<void, [number, string]>(SQL.touchAccount),
    deleteAccount: q<void, [string]>(SQL.deleteAccount),

    insertSession: q<
      { id: number },
      [
        string | null,
        string | null,
        string,
        number | null,
        number,
        string | null,
        string | null,
        string | null,
      ]
    >(SQL.insertSession),
    endSession: q<void, [number, string | null, number]>(SQL.endSession),
    updateSessionIdentity: q<void, [string | null, string | null, string | null, number]>(
      SQL.updateSessionIdentity,
    ),
    updateSessionLocation: q<void, [string | null, string | null, number]>(
      SQL.updateSessionLocation,
    ),
    getSession: q<SessionRow, [number]>(SQL.getSession),
    listOpenSessions: q<SessionRow, []>(SQL.listOpenSessions),
    listSessions: q<SessionRow, [string, number]>(SQL.listSessions),

    insertEvent: q<
      void,
      [string | null, number, number | null, string, string | null, string | null, string | null]
    >(SQL.insertEvent),
    listEvents: q<EventRow, [string, number, number]>(SQL.listEvents),
    listEventsOfKind: q<EventRow, [string, string, number, number]>(SQL.listEventsOfKind),
    listAllEvents: q<EventRow, [number, number]>(SQL.listAllEvents),
    listAllEventsOfKind: q<EventRow, [string, number, number]>(SQL.listAllEventsOfKind),
    listEventsBySession: q<EventRow, [number, number, number]>(SQL.listEventsBySession),
    listEventsBySessionOfKind: q<EventRow, [number, string, number, number]>(
      SQL.listEventsBySessionOfKind,
    ),
    listEventsBySubject: q<EventRow, [string, number, number]>(SQL.listEventsBySubject),
    listEventsBySubjectOfKind: q<EventRow, [string, string, number, number]>(
      SQL.listEventsBySubjectOfKind,
    ),
    countEventsByKind: q<KindCount, []>(SQL.countEventsByKind),
    distinctEventKinds: q<{ kind: string }, []>(SQL.distinctEventKinds),
    listEventsDaily: q<EventsDailyRow, [string, number, number]>(SQL.listEventsDaily),

    upsertFriend: q<void, [string, string, string, string | null, number, number | null]>(
      SQL.upsertFriend,
    ),
    getFriend: q<FriendLogRow, [string, string]>(SQL.getFriend),
    listFriends: q<FriendLogRow, [string]>(SQL.listFriends),
    insertFriendHistory: q<
      void,
      [string, number, string, string, string | null, string | null, string | null, string | null]
    >(SQL.insertFriendHistory),
    listFriendHistory: q<FriendLogHistoryRow, [string, number, number]>(SQL.listFriendHistory),

    putUserCache: q<void, [string, string, number, string]>(SQL.putUserCache),
    getUserCache: q<CacheRow, [string, string]>(SQL.getUserCache),
    putWorldCache: q<void, [string, number, string]>(SQL.putWorldCache),
    getWorldCache: q<CacheRow, [string]>(SQL.getWorldCache),
    putAvatarCache: q<void, [string, number, string]>(SQL.putAvatarCache),
    getAvatarCache: q<CacheRow, [string]>(SQL.getAvatarCache),

    putNote: q<void, [string, string, string, number]>(SQL.putNote),
    getNote: q<NoteRow, [string, string]>(SQL.getNote),
    deleteNote: q<void, [string, string]>(SQL.deleteNote),

    putNotification: q<
      void,
      [
        string,
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        number,
        string | null,
      ]
    >(SQL.putNotification),
    listNotifications: q<NotificationRow, [string, number]>(SQL.listNotifications),
    markNotificationSeen: q<void, [string]>(SQL.markNotificationSeen),

    recordAvatarSeen: q<void, [string, string, number, number]>(SQL.recordAvatarSeen),
    listAvatarHistory: q<AvatarHistoryRow, [string, number]>(SQL.listAvatarHistory),

    listRetentionConfig: q<RetentionConfigRow, []>(SQL.listRetentionConfig),
    setRetentionConfig: q<void, [string, number, number]>(SQL.setRetentionConfig),
    deleteRetentionConfig: q<void, [string]>(SQL.deleteRetentionConfig),

    insertGrant: q<
      void,
      [string, string, string, string, string, string, string, string | null, number]
    >(SQL.insertGrant),
    getGrantByTokenHash: q<GrantRow, [string]>(SQL.getGrantByTokenHash),
    getGrantByTwoFactorHash: q<GrantRow, [string]>(SQL.getGrantByTwoFactorHash),
    getGrant: q<GrantRow, [string]>(SQL.getGrant),
    findGrantForApp: q<GrantRow, [string, string, string]>(SQL.findGrantForApp),
    listGrants: q<GrantRow, []>(SQL.listGrants),
    listGrantsForAccount: q<GrantRow, [string]>(SQL.listGrantsForAccount),
    touchGrant: q<void, [number, string]>(SQL.touchGrant),
    setGrantTwoFactorHash: q<void, [string | null, string]>(SQL.setGrantTwoFactorHash),
    revokeGrant: q<void, [number, string]>(SQL.revokeGrant),
    revokeGrantsForAccount: q<void, [number, string]>(SQL.revokeGrantsForAccount),
    revokeAllGrants: q<void, [number]>(SQL.revokeAllGrants),

    insertPairingRequest: q<
      void,
      [
        string,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
      ]
    >(SQL.insertPairingRequest),
    getPairingRequest: q<PairingRequestRow, [string]>(SQL.getPairingRequest),
    getPairingByHalfToken: q<PairingRequestRow, [string, number]>(SQL.getPairingByHalfToken),
    listPendingPairings: q<PairingRequestRow, [number]>(SQL.listPendingPairings),
    countPairingAttemptsSince: q<{ count: number }, [string, string, number]>(
      SQL.countPairingAttemptsSince,
    ),
    bumpPairingAttempts: q<void, [string]>(SQL.bumpPairingAttempts),
    setPairingAccount: q<void, [string, string]>(SQL.setPairingAccount),
    resolvePairing: q<void, [number, string, string | null, string]>(SQL.resolvePairing),
    expirePairings: q<void, [number, number]>(SQL.expirePairings),

    insertAudit: q<
      void,
      [
        number,
        string | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        number | null,
      ]
    >(SQL.insertAudit),
    listAudit: q<AuditRow, [number, number]>(SQL.listAudit),
    listAuditForGrant: q<AuditRow, [string, number, number]>(SQL.listAuditForGrant),

    getMeta: q<{ value: string }, [string]>(SQL.getMeta),
    setMeta: q<void, [string, string]>(SQL.setMeta),
  };
}
