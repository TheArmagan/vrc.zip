/**
 * The fictional evening every screenshot is taken during.
 *
 * ## Why the pictures need a world of their own
 *
 * The README's screens used to be shot from a real machine, which meant real friends' display names
 * and real avatars in a public repository, and it meant nobody but their owner could ever regenerate
 * them. Both are fixable the same way: invent the evening, and write it down here.
 *
 * Everything below is made up. The names are ordinary first names, the ids are the right *shape*
 * (`usr_` + a uuid) but not real ids, and no image is fetched from anywhere — a friend row with no
 * icon renders as initials, which is what VRChat's own empty-string icon does.
 *
 * ## One file, two consumers
 *
 * `vrchat-stub.ts` serves this as if it were VRChat; `seed.ts` writes the parts VRChat could never
 * tell us — game-log sessions, saved graphs, a store somebody's automations have been filling in.
 * Both read *this* file, so a friend who is in The Long Hallway on the Friends screen is in The Long
 * Hallway in the feed, and the two cannot drift.
 *
 * ## Time is relative to one instant
 *
 * Every timestamp is an offset from {@link EVENING}, resolved against the clock at seed time. That
 * is what makes "12 minutes ago" say 12 minutes ago in a screenshot taken next year, rather than
 * "2 years ago" — a feed full of stale relative times reads as a dead project.
 */

/** Minutes before "now", so a shot taken at any time reads as a live evening. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** The instant the evening is anchored to. Resolved once per run so a whole seed is consistent. */
export interface Evening {
  readonly now: number;
  /** `ago(12)` is twelve minutes before now. */
  ago(minutes: number): number;
}

export function evening(now: number): Evening {
  return { now, ago: (minutes) => now - minutes * MINUTE };
}

/* -------------------------------------------------------------------------------------------- */
/* Accounts                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export interface DemoAccount {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly displayName: string;
  /** Whether this one demands a second factor. Two accounts, and only one does — see the note. */
  readonly twoFactor: boolean;
}

/**
 * Two accounts, because multi-account is the default posture here rather than an edge case, and the
 * screenshots have to show that on every screen that has an account filter.
 *
 * Only one demands 2FA. Both would be tidier and less honest: the account picker's interesting state
 * is a *mixed* one, where the row that needs a code sits next to the row that does not.
 */
export const ACCOUNTS: readonly DemoAccount[] = [
  {
    id: "usr_3f9c2a10-7b41-4d88-9c02-16ae0f4d1b77",
    username: "demo-primary",
    password: "not-a-real-password",
    displayName: "Wren",
    twoFactor: true,
  },
  {
    id: "usr_8b5e1d64-2c93-4f07-a1de-53c78b920e45",
    username: "demo-alt",
    password: "not-a-real-password",
    displayName: "Wren Alt",
    twoFactor: false,
  },
];

export const TWO_FACTOR_CODE = "123456";

/* -------------------------------------------------------------------------------------------- */
/* Worlds and instances                                                                           */
/* -------------------------------------------------------------------------------------------- */

export interface DemoWorld {
  readonly id: string;
  readonly name: string;
  readonly authorName: string;
  readonly capacity: number;
}

export const WORLDS: readonly DemoWorld[] = [
  {
    id: "wrld_a1c0f7e2-5d38-4b91-8f6a-2e0b47d95c13",
    name: "The Long Hallway",
    authorName: "sable",
    capacity: 24,
  },
  {
    id: "wrld_b7e4d219-8a05-42fc-93d7-6c1f80a2be44",
    name: "Rooftop, Raining",
    authorName: "kestrel",
    capacity: 16,
  },
  {
    id: "wrld_c2f81b53-4e77-4a06-b8d2-91ac35e0f768",
    name: "Quiet Library",
    authorName: "mote",
    capacity: 12,
  },
  {
    id: "wrld_d9a37c60-1b52-4e83-a4f1-708de65b2c39",
    name: "The Workshop",
    authorName: "pike",
    capacity: 40,
  },
];

/** `wrld_x:12345~region(eu)` — the shape VRChat writes, which the parser downstream depends on. */
export function instanceOf(world: DemoWorld, id: string, region = "eu"): string {
  return `${world.id}:${id}~region(${region})`;
}

export const HOME_INSTANCE = instanceOf(WORLDS[0] as DemoWorld, "41827");
export const ALT_INSTANCE = instanceOf(WORLDS[1] as DemoWorld, "90233", "use");

/* -------------------------------------------------------------------------------------------- */
/* Friends                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export interface DemoFriend {
  readonly id: string;
  readonly displayName: string;
  readonly status: "join me" | "active" | "ask me" | "busy" | "offline";
  readonly statusDescription: string;
  /** `offline`, `private`, or a real instance string. VRChat's own vocabulary. */
  readonly location: string;
  readonly platform: "standalonewindows" | "android";
  readonly trust: "trusted" | "known" | "user" | "new";
}

/**
 * Fourteen friends, mixed across every state the list can render.
 *
 * The mix is the point rather than the count: a screenshot of eleven identical "active" rows says
 * nothing about the screen. There is somebody in a private instance (which the app is right not to
 * name), somebody on Android, somebody offline, and a trust level of each kind, because those are
 * the four things the row draws differently.
 */
export const FRIENDS: readonly DemoFriend[] = [
  {
    id: "usr_c81f4a26-3e70-4b95-8d12-6ca9037fe504",
    displayName: "Ada",
    status: "join me",
    statusDescription: "come say hi",
    location: HOME_INSTANCE,
    platform: "standalonewindows",
    trust: "trusted",
  },
  {
    id: "usr_2d70b93e-8f14-4c62-a057-91b3ed4c8a7f",
    displayName: "Bo",
    status: "active",
    statusDescription: "",
    location: HOME_INSTANCE,
    platform: "standalonewindows",
    trust: "known",
  },
  {
    id: "usr_9e15c807-42ab-4d39-b6f0-3c81a72de956",
    displayName: "Cass",
    status: "active",
    statusDescription: "wandering",
    location: ALT_INSTANCE,
    platform: "android",
    trust: "known",
  },
  {
    id: "usr_4a6208df-15c9-4e70-83b1-72fd0e9a6c38",
    displayName: "Devi",
    status: "ask me",
    statusDescription: "in a call",
    location: "private",
    platform: "standalonewindows",
    trust: "trusted",
  },
  {
    id: "usr_7c3e9b41-6d02-48fa-95c7-0be21d7f8340",
    displayName: "Emrys",
    status: "busy",
    statusDescription: "working",
    location: "private",
    platform: "standalonewindows",
    trust: "user",
  },
  {
    id: "usr_1b840f57-9a23-4e16-bd08-64c93a2e7f15",
    displayName: "Fen",
    status: "active",
    statusDescription: "",
    location: instanceOf(WORLDS[2] as DemoWorld, "17740"),
    platform: "standalonewindows",
    trust: "trusted",
  },
  {
    id: "usr_5f27ae13-4c80-49b2-a3f6-8d10e527c94b",
    displayName: "Gil",
    status: "join me",
    statusDescription: "open instance",
    location: instanceOf(WORLDS[3] as DemoWorld, "58211", "usw"),
    platform: "standalonewindows",
    trust: "known",
  },
  {
    id: "usr_6d19b3f0-72e5-4a81-9cd3-05fb2e740a86",
    displayName: "Hana",
    status: "active",
    statusDescription: "",
    location: instanceOf(WORLDS[3] as DemoWorld, "58211", "usw"),
    platform: "android",
    trust: "user",
  },
  {
    id: "usr_0a53e7c8-4b16-49d2-87fe-31c60b98a2d7",
    displayName: "Iris",
    status: "active",
    statusDescription: "afk",
    location: instanceOf(WORLDS[2] as DemoWorld, "17740"),
    platform: "standalonewindows",
    trust: "new",
  },
  {
    id: "usr_8e42c015-9f37-4b6a-a2d8-70c15be93f24",
    displayName: "Jun",
    status: "offline",
    statusDescription: "",
    location: "offline",
    platform: "standalonewindows",
    trust: "trusted",
  },
  {
    id: "usr_3c96fd81-2a04-4e75-b93c-18ef26a7c059",
    displayName: "Kit",
    status: "offline",
    statusDescription: "",
    location: "offline",
    platform: "standalonewindows",
    trust: "known",
  },
  {
    id: "usr_b2807e34-6c95-41da-8f07-9e3d15a2c680",
    displayName: "Lia",
    status: "offline",
    statusDescription: "",
    location: "offline",
    platform: "android",
    trust: "user",
  },
  {
    id: "usr_e5140a97-8b26-4c3f-91d5-0a7f38be2c41",
    displayName: "Mox",
    status: "offline",
    statusDescription: "",
    location: "offline",
    platform: "standalonewindows",
    trust: "known",
  },
  {
    id: "usr_7f38d260-1e94-4a05-b7c8-52d09fa1e376",
    displayName: "Nell",
    status: "offline",
    statusDescription: "",
    location: "offline",
    platform: "standalonewindows",
    trust: "trusted",
  },
];

/** VRChat's tag vocabulary for a trust level, which is how the daemon reads it back off a user. */
export function trustTag(trust: DemoFriend["trust"]): string {
  switch (trust) {
    case "trusted":
      return "system_trust_veteran";
    case "known":
      return "system_trust_known";
    case "user":
      return "system_trust_basic";
    default:
      return "system_trust_intermediate";
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Notifications                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export interface DemoNotification {
  readonly id: string;
  readonly type: "friendRequest" | "invite" | "requestInvite" | "message";
  readonly senderId: string;
  readonly senderName: string;
  readonly message: string;
  readonly minutesAgo: number;
  readonly seen: boolean;
}

export const NOTIFICATIONS: readonly DemoNotification[] = [
  {
    id: "not_1f4a",
    type: "invite",
    senderId: "usr_c81f4a26-3e70-4b95-8d12-6ca9037fe504",
    senderName: "Ada",
    message: "come to the hallway",
    minutesAgo: 4,
    seen: false,
  },
  {
    id: "not_2b71",
    type: "friendRequest",
    senderId: "usr_0a53e7c8-4b16-49d2-87fe-31c60b98a2d7",
    senderName: "Iris",
    message: "",
    minutesAgo: 26,
    seen: false,
  },
  {
    id: "not_3c09",
    type: "requestInvite",
    senderId: "usr_2d70b93e-8f14-4c62-a057-91b3ed4c8a7f",
    senderName: "Bo",
    message: "room for one more?",
    minutesAgo: 51,
    seen: true,
  },
  {
    id: "not_4d55",
    type: "message",
    senderId: "usr_1b840f57-9a23-4e16-bd08-64c93a2e7f15",
    senderName: "Fen",
    message: "thanks for the world rec",
    minutesAgo: 96,
    seen: true,
  },
  {
    id: "not_5e83",
    type: "invite",
    senderId: "usr_6d19b3f0-72e5-4a81-9cd3-05fb2e740a86",
    senderName: "Hana",
    message: "workshop, 2 free slots",
    minutesAgo: 140,
    seen: true,
  },
];
