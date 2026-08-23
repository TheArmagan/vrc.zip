/**
 * The shot list: every picture in `docs/`, what it shows, and what its caption says.
 *
 * One manifest, read by four things — the plan the browser is driven from, the captioned renders,
 * the poster's grid, and the GIFs' frames. That is deliberate: a caption written next to the image
 * it captions in four places is four captions that disagree by the third refresh.
 *
 * The `route` is a UI hash. `hold` names something to do before the shutter, in plain English,
 * because the person (or agent) driving the browser is the one who does it — automating a hover or
 * a half-dragged wire would mean a second, worse copy of the app's own interaction code.
 */

export interface Shot {
  /** File stem: `docs/screenshots/<id>.jpg` in, `docs/renders/<id>.jpg` out. */
  readonly id: string;
  /** The UI hash to open, without the leading `#`. */
  readonly route: string;
  /** Rendered above the shot. Two or three words. */
  readonly title: string;
  /** One sentence, rendered under the title. Says what the screen is *for*, not what it contains. */
  readonly caption: string;
  /** What to do before capturing, when the screen needs a state a URL cannot express. */
  readonly hold?: string;
  /** Which surfaces this shot appears on, beyond its own captioned render. */
  readonly uses?: readonly ("poster" | "hero" | "short" | "ad")[];
}

export const SHOTS: readonly Shot[] = [
  {
    id: "live-sessions",
    route: "/sessions",
    title: "Live sessions",
    caption:
      "Every VRChat client running right now, including one signed into an account it does not manage.",
    uses: ["poster", "ad"],
  },
  {
    id: "friends",
    route: "/friends",
    title: "Friends",
    caption: "Presence off VRChat's own socket, across every account at once.",
    uses: ["poster", "hero", "short", "ad"],
  },
  {
    id: "feed",
    route: "/feed",
    title: "Feed",
    caption: "One searchable timeline: presence, the game log, and what your automations did.",
    uses: ["poster", "short", "ad"],
  },
  {
    id: "graphs",
    route: "/graphs",
    title: "Automations",
    caption: "Two switches, not one — a graph can run without being allowed to reach anybody yet.",
    uses: ["poster", "ad"],
  },
  {
    id: "graph-editor",
    route: "/graphs",
    title: "The canvas",
    caption: "Wire a trigger to an action. Every edge is type-checked as you draw it.",
    hold: "Open the 'Welcome someone once' graph and fit the view.",
    uses: ["poster", "hero", "short", "ad"],
  },
  {
    id: "graph-palette",
    route: "/graphs",
    title: "Four hundred nodes",
    caption: "Every VRChat operation, every pipeline event, and whatever your plugins add.",
    hold: "Open a graph, type 'group' into the palette search so several API groups match.",
    uses: ["poster", "ad"],
  },
  {
    id: "graph-picker",
    route: "/graphs",
    title: "Drop a wire anywhere",
    caption: "Let go over empty canvas and it offers only the nodes that would actually connect.",
    hold: "Open a graph, drag from an output port and release over empty canvas.",
    uses: ["ad"],
  },
  {
    id: "graph-stores",
    route: "/graphs",
    title: "Shared stores",
    caption: "What your automations wrote down. Anything naming the same store shares it.",
    hold: "Scroll to the Stores panel and expand 'tonight'.",
    uses: ["poster", "ad"],
  },
  {
    id: "game-log",
    route: "/gamelog",
    title: "Game log",
    caption: "Who joined, who left, which world — read straight out of VRChat's own log files.",
    uses: ["poster", "ad"],
  },
  {
    id: "notifications",
    route: "/notifications",
    title: "Notifications",
    caption: "Invites and friend requests, kept after VRChat has forgotten them.",
    uses: ["poster"],
  },
  {
    id: "accounts",
    route: "/accounts",
    title: "Accounts",
    caption: "Several at once is the normal case here, not an edge case.",
    uses: ["poster", "ad"],
  },
  {
    id: "history",
    route: "/friends",
    title: "History",
    caption: "When you met somebody, and every time you have seen them since.",
    hold: "Open a friend's card and switch to the History tab.",
    uses: ["poster"],
  },
  {
    id: "connected-apps",
    route: "/apps",
    title: "Connected apps",
    caption: "What each app was allowed to see, when it last asked, and one button to end it.",
    uses: ["poster", "ad"],
  },
  {
    id: "plugins",
    route: "/plugins",
    title: "Plugins",
    caption:
      "Extensions that run with your privileges, and are described that way rather than as sandboxed.",
    uses: ["poster"],
  },
  {
    id: "plugin-consent",
    route: "/plugins",
    title: "Consent",
    caption: "Every capability spelled out in plain language, and held down rather than clicked.",
    hold: "Start an install so the consent sheet is open.",
  },
  {
    id: "forward-proxy",
    route: "",
    title: "Forward proxy",
    caption:
      "Point an app at one address and it reaches VRChat through vrc.zip's limits, not around them.",
    hold: "Open the forward proxy page on its own port.",
    uses: ["poster"],
  },
  {
    id: "settings",
    route: "/settings",
    title: "Settings",
    caption: "Contact address, retention, and how long each kind of event is kept.",
    uses: ["poster"],
  },
  {
    id: "command-palette",
    route: "/feed",
    title: "Command palette",
    caption: "CTRL+SHIFT+P reaches every screen, every account, and whatever a plugin contributed.",
    hold: "Press CTRL+SHIFT+P and type a couple of letters.",
    uses: ["ad"],
  },
];

/** The three beats of the short GIF, in order. */
export const SHORT_FRAMES: readonly string[] = ["friends", "feed", "graph-editor"];

export function shot(id: string): Shot {
  const found = SHOTS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No shot called ${id}. See tools/src/docs/shots.ts.`);
  return found;
}

export function shotsFor(surface: NonNullable<Shot["uses"]>[number]): Shot[] {
  return SHOTS.filter((entry) => entry.uses?.includes(surface) === true);
}
