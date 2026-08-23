/**
 * The half of the evening VRChat could never tell us.
 *
 * The stub covers everything that comes *from* VRChat — friends, worlds, notifications, live frames.
 * What is left is what vrc.zip knows and VRChat does not: a game client's log, the sessions it
 * produced, the automations somebody saved, and what those automations have written down. None of it
 * has an upstream, so it is written straight into the database.
 *
 * ## Why raw SQL rather than importing the daemon's `Store`
 *
 * `tools` deliberately depends on `@vrcz/shared` and nothing else. Reaching into `daemon/src/store`
 * for a docs script would make a build-time tool a consumer of daemon internals, and the next person
 * refactoring the store would have a screenshot generator in their blast radius. The cost is a
 * handful of INSERTs written out here; the schema they target is the one in
 * `daemon/src/store/schema/`, and if it moves this file fails loudly on the next run rather than
 * silently producing an empty screenshot.
 *
 * **The daemon must have opened the database first.** Migrations are its job, not this one's — this
 * writes rows into a schema that already exists, which is also why it runs after the daemon is up.
 */

import { Database } from "bun:sqlite";
import {
  ACCOUNTS,
  type DemoWorld,
  type Evening,
  FRIENDS,
  HOME_INSTANCE,
  instanceOf,
  WORLDS,
} from "./demo.ts";

/** One VRChat client, running now, with a log the watcher would have been tailing. */
interface DemoSession {
  readonly accountIndex: number | null;
  readonly displayName: string | null;
  readonly logPath: string;
  readonly startedMinutesAgo: number;
  readonly location: string;
  readonly vrMode: "vr" | "desktop";
}

/**
 * Three clients, and the third is the one worth having in the picture.
 *
 * Two are the managed accounts. The third is signed into an account vrc.zip does not manage, which
 * is a normal state rather than an error (PLAN.md §1.7) — `sessions.account_id` is nullable exactly
 * for it, and a screenshot where every session is neatly attributed would hide the one row that
 * explains why sessions rather than accounts are the unit here.
 */
const SESSIONS: readonly DemoSession[] = [
  {
    accountIndex: 0,
    displayName: "Wren",
    logPath: "C:/Users/you/AppData/LocalLow/VRChat/VRChat/output_log_2026-08-23_19-04-11.txt",
    startedMinutesAgo: 96,
    location: HOME_INSTANCE,
    vrMode: "vr",
  },
  {
    accountIndex: 1,
    displayName: "Wren Alt",
    logPath: "C:/Users/you/AppData/LocalLow/VRChat/VRChat/output_log_2026-08-23_20-12-40.txt",
    startedMinutesAgo: 28,
    location: instanceOf(WORLDS[3] as DemoWorld, "58211", "usw"),
    vrMode: "desktop",
  },
  {
    accountIndex: null,
    displayName: null,
    logPath: "D:/VRChat/output_log_2026-08-23_18-40-02.txt",
    startedMinutesAgo: 120,
    location: instanceOf(WORLDS[2] as DemoWorld, "17740"),
    vrMode: "desktop",
  },
];

export interface SeedResult {
  readonly sessions: number;
  readonly events: number;
  readonly graphs: number;
  readonly storeEntries: number;
}

export function seed(databasePath: string, at: Evening): SeedResult {
  // `readwrite` without `create`: the daemon owns the schema, so a missing file here means the
  // caller ran this before staging and should be told, not handed a fresh empty database that
  // every INSERT then fails against.
  const db = new Database(databasePath, { readwrite: true });
  // The daemon has the same file open and WAL allows exactly one writer at a time. Without a busy
  // timeout the very first INSERT loses that race against a feed-writer flush and fails outright,
  // which is a confusing way to be told "wait a moment".
  db.exec("PRAGMA busy_timeout = 10000");
  try {
    return db.transaction(() => {
      const sessions = seedSessions(db, at);
      const events = seedEvents(db, at, sessions);
      const graphs = seedGraphs(db, at);
      const storeEntries = seedStores(db, at);
      seedApps(db, at);
      return { sessions: sessions.length, events, graphs, storeEntries };
    })();
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Sessions and the game log                                                                      */
/* -------------------------------------------------------------------------------------------- */

function seedSessions(db: Database, at: Evening): number[] {
  const insert = db.prepare(
    `INSERT INTO sessions
       (account_id, display_name, log_path, log_inode, started_at, vr_mode,
        current_location, current_world_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const ids: number[] = [];
  for (const session of SESSIONS) {
    const accountId =
      session.accountIndex === null ? null : (ACCOUNTS[session.accountIndex]?.id ?? null);
    const row = insert.get(
      accountId,
      session.displayName,
      session.logPath,
      null,
      at.ago(session.startedMinutesAgo),
      session.vrMode,
      session.location,
      session.location.split(":")[0] ?? null,
    ) as { id: number } | null;
    if (row !== null) ids.push(row.id);
  }
  return ids;
}

/**
 * The log-derived half of the feed: who joined, who left, which world the client moved to.
 *
 * Written directly rather than by feeding a fake log file through the watcher. The watcher's job is
 * to turn bytes into these rows and it has its own tests; a docs tool that reimplemented VRChat's
 * log format would be maintaining a second parser to produce a picture.
 */
function seedEvents(db: Database, at: Evening, sessionIds: readonly number[]): number {
  const insert = db.prepare(
    `INSERT INTO events (account_id, ts, session_id, kind, subject_id, location, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const primary = ACCOUNTS[0]?.id ?? null;
  const home = sessionIds[0] ?? null;
  let written = 0;

  const write = (
    minutesAgo: number,
    kind: string,
    subject: string | null,
    payload: Record<string, unknown>,
    accountId: string | null = primary,
    sessionId: number | null = home,
  ): void => {
    insert.run(
      accountId,
      at.ago(minutesAgo),
      sessionId,
      kind,
      subject,
      HOME_INSTANCE,
      JSON.stringify(payload),
    );
    written += 1;
  };

  write(96, "session.started", null, { vrMode: "vr" });
  write(95, "gamelog.world_join", WORLDS[0]?.id ?? null, {
    worldId: WORLDS[0]?.id,
    worldName: WORLDS[0]?.name,
    location: HOME_INSTANCE,
  });
  // A handful of joins and leaves, in the order an evening actually produces them.
  const arrivals: [number, number][] = [
    [92, 0],
    [88, 1],
    [74, 3],
    [61, 5],
    [44, 6],
    [31, 8],
    [19, 7],
    [8, 2],
  ];
  for (const [minutesAgo, friendIndex] of arrivals) {
    const friend = FRIENDS[friendIndex];
    if (friend === undefined) continue;
    write(minutesAgo, "gamelog.player_join", friend.id, { displayName: friend.displayName });
  }
  for (const [minutesAgo, friendIndex] of [
    [67, 3],
    [37, 5],
    [12, 8],
  ] as [number, number][]) {
    const friend = FRIENDS[friendIndex];
    if (friend === undefined) continue;
    write(minutesAgo, "gamelog.player_leave", friend.id, { displayName: friend.displayName });
  }

  // The other client's session, so the game-log screen shows more than one.
  write(120, "session.started", null, { vrMode: "desktop" }, null, sessionIds[2] ?? null);

  // What an armed graph said out loud. `graph.note` is the built-in feed-note action, and having a
  // couple in the feed is the only way a screenshot shows automations and history as one timeline
  // rather than two features.
  write(
    41,
    "graph.note",
    null,
    { note: "Ada is in The Long Hallway — said hello.", graphId: "graph-welcome" },
    primary,
    null,
  );
  write(
    9,
    "graph.note",
    null,
    { note: "Instance is at 8 of 24.", graphId: "graph-headcount" },
    primary,
    null,
  );
  write(
    3,
    "graph.signal",
    "greeted",
    { name: "greeted", graphId: "graph-welcome", value: 8 },
    null,
    null,
  );

  return written;
}

/* -------------------------------------------------------------------------------------------- */
/* Automations                                                                                    */
/* -------------------------------------------------------------------------------------------- */

interface DemoGraph {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly armed: boolean;
  readonly definition: unknown;
}

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  config: Record<string, unknown> = {},
) {
  return { id, type, position: { x, y }, config };
}

function edge(id: string, from: string, fromPort: string, to: string, toPort: string) {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

/**
 * Three saved graphs, in the three states the list draws differently: off, rehearsing, armed.
 *
 * The middle one matters most. A graph that is enabled but not armed is the default a new graph
 * lands in, and the list's whole point is that those are two switches rather than one — a screenshot
 * of three armed graphs would make the distinction invisible.
 */
const GRAPHS: readonly DemoGraph[] = [
  {
    id: "graph-welcome",
    name: "Welcome someone once",
    description: "Greets a friend the first time they join, and never twice in an evening.",
    enabled: true,
    armed: true,
    definition: {
      nodes: [
        node("t", "vrcz/on-player-join", 0, 40),
        node("seen", "vrcz/store-set-add", 300, 40, { name: "welcomed", store: "tonight" }),
        node("gate", "vrcz/gate", 580, 40),
        node("text", "vrcz/template", 580, 220, { template: "{a} just joined." }),
        node("note", "vrcz/note", 860, 140),
      ],
      edges: [
        edge("e1", "t", "user", "seen", "item"),
        edge("e2", "seen", "added", "gate", "value"),
        edge("e3", "t", "displayName", "text", "a"),
        edge("e4", "gate", "out", "note", "after"),
        edge("e5", "text", "text", "note", "text"),
      ],
    },
  },
  {
    id: "graph-headcount",
    name: "Headcount every hour",
    description: "Counts who is in the instance and writes it to the feed.",
    enabled: true,
    armed: false,
    definition: {
      nodes: [
        node("t", "vrcz/on-schedule", 0, 40, { everyMs: 3_600_000 }),
        node("here", "vrcz/instance-players", 300, 40),
        node("text", "vrcz/template", 580, 40, { template: "{a} people here." }),
        node("note", "vrcz/note", 860, 40),
      ],
      edges: [
        edge("e1", "t", "at", "here", "after"),
        edge("e2", "here", "count", "text", "a"),
        edge("e3", "text", "text", "note", "text"),
      ],
    },
  },
  {
    id: "graph-quiet",
    name: "Tell me when the room empties",
    description: "Off for now. Watches leaves and notifies the desktop when the count hits zero.",
    enabled: false,
    armed: false,
    definition: {
      nodes: [
        node("t", "vrcz/on-player-leave", 0, 40),
        node("here", "vrcz/instance-players", 300, 40),
        node("cmp", "vrcz/compare", 580, 40, { op: "lte", value: "0" }),
        node("gate", "vrcz/gate", 860, 40),
        node("say", "vrcz/desktop-notification", 1140, 40, { title: "vrc.zip" }),
        node("text", "vrcz/text-value", 860, 220, { value: "Everyone has gone." }),
      ],
      edges: [
        edge("e1", "t", "at", "here", "after"),
        edge("e2", "here", "count", "cmp", "left"),
        edge("e3", "cmp", "result", "gate", "value"),
        edge("e4", "gate", "out", "say", "after"),
        edge("e5", "text", "value", "say", "text"),
      ],
    },
  },
];

function seedGraphs(db: Database, at: Evening): number {
  const insert = db.prepare(
    `INSERT INTO graphs
       (id, name, description, enabled, armed, concurrency, account_id, definition,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'parallel', ?, ?, ?, ?)`,
  );
  for (const [index, graph] of GRAPHS.entries()) {
    insert.run(
      graph.id,
      graph.name,
      graph.description,
      graph.enabled ? 1 : 0,
      graph.armed ? 1 : 0,
      ACCOUNTS[0]?.id ?? null,
      JSON.stringify(graph.definition),
      at.ago(600 + index * 90),
      at.ago(20 + index * 35),
    );
  }
  return GRAPHS.length;
}

/**
 * What the automations have written down.
 *
 * A store with something in it is the only way the Stores panel says anything: the whole feature is
 * that two graphs naming `tonight` share it, and an empty panel documents a table rather than an
 * idea.
 */
function seedStores(db: Database, at: Evening): number {
  const store = db.prepare(
    `INSERT OR IGNORE INTO graph_stores (name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  const kv = db.prepare(
    `INSERT INTO graph_kv (store, collection, key, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  store.run("tonight", "", at.ago(96), at.ago(8));

  let written = 0;
  // The set the welcome graph has been filling in, one member per person it greeted.
  for (const [index, friendIndex] of [0, 1, 3, 5, 6, 8].entries()) {
    const friend = FRIENDS[friendIndex];
    if (friend === undefined) continue;
    kv.run(
      "tonight",
      "set:welcomed",
      friend.id,
      JSON.stringify(friend.id),
      at.ago(92 - index * 12),
    );
    written += 1;
  }
  // A plain value and a map, so the panel shows more than one collection kind.
  kv.run("tonight", "", "last-headcount", JSON.stringify(8), at.ago(9));
  kv.run(
    "tonight",
    "map:first-seen",
    FRIENDS[0]?.id ?? "usr",
    JSON.stringify(at.ago(92)),
    at.ago(92),
  );
  return written + 2;
}

/* -------------------------------------------------------------------------------------------- */
/* Connected apps                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Two apps that have asked for access and been granted it, so the oversight screen has something to
 * oversee — including one with a narrow grant and one with a broad one, which is the comparison the
 * screen exists to let somebody make.
 */
function seedApps(db: Database, at: Evening): void {
  const insert = db.prepare(
    `INSERT INTO grants (id, account_id, app_name, app_version, app_contact, scopes, token_hash,
                         two_factor_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, '1.0.0', ?, ?, ?, NULL, ?, ?, NULL)`,
  );
  const rows: [string, string, string, string[], number, number][] = [
    [
      "grant-overlay",
      "Instance Overlay",
      "overlay@example.invalid",
      ["friends:read", "sessions:read"],
      480,
      2,
    ],
    [
      "grant-logbook",
      "Logbook",
      "hi@example.invalid",
      ["friends:read", "users:read", "sessions:read", "notifications:read"],
      2880,
      55,
    ],
  ];
  for (const [id, name, contact, scopes, createdAgo, usedAgo] of rows) {
    insert.run(
      id,
      ACCOUNTS[0]?.id ?? null,
      name,
      contact,
      JSON.stringify(scopes),
      // A hash of a token that was never issued. Nothing can authenticate with it, which is the
      // point: the row exists to be *listed and revoked* in a screenshot, not to be used.
      `docs-${id}`,
      at.ago(createdAgo),
      at.ago(usedAgo),
    );
  }
}
