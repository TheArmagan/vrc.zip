/**
 * The nodes that actually do something, and therefore the nodes that dry-run.
 *
 * Every one of these has a side effect the user can see from outside vrc.zip: a POST to somebody's
 * endpoint, a datagram to an overlay, an invite in someone's notifications. That is the whole reason
 * they are in their own file, separate from the pure shaping nodes — and the reason each one begins
 * by asking `context.dryRun`.
 *
 * ## Dry-run is a note, not a silence
 *
 * A rehearsing action emits `graph.note` saying what it *would* have done. That gives the arming
 * gesture the evidence PLAN.md asks for without inventing a second log: the note is an ordinary
 * event, so it inherits the feed, retention and the enriched stream, and the graph's own screen can
 * show "here is what this would have sent" by reading the same rows as everything else.
 *
 * ## Why the webhook queue is not reused
 *
 * PLAN.md §Phase 4 says these go "through the Phase 2 delivery path", and they go through its
 * *hardening* — the SSRF-validated URL, the mandatory User-Agent, a hard timeout, a capped
 * response — but not its **queue**. Two reasons, both structural: a graph run does not retry
 * (decision 206 — re-running a chain that already sent an invite is worse than failing), and a
 * `webhooks` row per action node would put a graph's internals into the user's Connected-apps
 * webhook list, which is a list of *apps that registered a webhook*. There is also no shared secret
 * to sign with: a URL typed into a node is not a registration, so there is nothing to HMAC against.
 */

import {
  type NodeConfigValues,
  type NodeDefinition,
  type PortValues,
  parseButtonRows,
} from "@vrcz/plugin-api/nodes";
import { APP_NAME, APP_VERSION, DESKTOP_ACTIVATION_KIND } from "@vrcz/shared";
import type { BusEvent, EventBus } from "../../bus/event-bus.ts";
import { validateWebhookUrl } from "../../webhooks/url.ts";
import type { ExecuteContext } from "../types.ts";
import { ME_CATEGORY } from "./me.ts";
import { encodeOscMessage, sendUdp } from "./osc.ts";
import type { BuiltinNode } from "./types.ts";

/** Where an invite points. Declared here rather than imported: see {@link GraphSocialActions}. */
export interface GraphInviteTarget {
  readonly worldId: string;
  readonly instanceId: string;
}

/**
 * The outbound social actions, as the graph runtime needs them.
 *
 * Declared here and satisfied structurally by `wiring/social-actions.ts`, which is what keeps
 * `graphs/` unaware that `wiring/` exists. `app.ts` hands the one implementation to both callers.
 */
export interface GraphSocialActions {
  invite(
    accountId: string,
    userId: string,
    target: GraphInviteTarget,
    messageSlot?: number,
  ): Promise<void>;
  requestInvite(accountId: string, userId: string, requestSlot?: number): Promise<void>;
  boop(accountId: string, userId: string): Promise<void>;
  inviteToGroup(accountId: string, groupId: string, userId: string): Promise<void>;
  selectAvatar(accountId: string, avatarId: string): Promise<void>;
}

/**
 * The injectable fetch seam. Narrower than `typeof fetch` so a test double is a two-line function —
 * the same shape and the same reason as `webhooks/delivery.ts`.
 */
export type GraphFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Opening a link in the user's browser, as the graph runtime needs it.
 *
 * Structurally satisfied by `os/open-url.ts`'s `openExternalUrl`, which is the **external** opener
 * and not the one the tray uses for the app itself. That distinction is a safety property rather
 * than a tidiness one: the other opener carries a session token in the URL it is handed, so it
 * refuses anything off loopback — and this one refuses anything that is not public https, which is
 * exactly the guard a URL arriving down a wire needs.
 */
export type GraphOpenLink = (url: string) => Promise<boolean>;

/**
 * What a button on a notification does, beyond telling the graph it was pressed.
 *
 * A mirror of `ButtonAction` in `os/desktop-notification.ts`, declared here for the same reason
 * `GraphSocialActions` is: `graphs/` does not import `os/`. The two are held together structurally
 * rather than by a shared import — `app.ts` assigns the real notifier to {@link GraphNotify}, so a
 * vocabulary that drifted apart is a compile error at the composition root.
 */
export type GraphButtonAction = "signal" | "url" | "screen" | "dismiss" | "snooze";

export interface GraphNotification {
  id?: string;
  title: string;
  body: string;
  silent?: boolean;
  tag?: string;
  buttons?: readonly {
    id: string;
    label: string;
    action?: GraphButtonAction;
    argument?: string;
  }[];
  image?: string;
  scenario?: "default" | "reminder" | "alarm" | "incomingCall";
  duration?: "short" | "long";
  expiresInMs?: number;
  click?: { action: GraphButtonAction; argument?: string };
  /** Held beside the toast and handed back on a press. Never shown, never sent to the platform. */
  data?: unknown;
}

/**
 * Raising an OS notification, as the graph runtime needs it.
 *
 * Structurally satisfied by `os/desktop-notification.ts`, which never rejects and answers with
 * whether the toast was actually shown. Both halves of that matter here: a graph must not fail
 * because the machine has notifications switched off, and it is entitled to *know* that nothing
 * appeared rather than being told it worked.
 *
 * `ignored` is the third half. A notification asked for buttons on a machine that cannot draw them
 * still appears, without them — so the node can say which parts of what it was asked for did not
 * survive this platform, instead of reporting a plain success that is only mostly true.
 */
export type GraphNotify = (notification: GraphNotification) => Promise<{
  shown: boolean;
  reason?: string;
  id?: string;
  ignored?: readonly string[];
}>;

export interface ActionDeps {
  readonly bus: EventBus;
  readonly social?: GraphSocialActions | undefined;
  /** Injected so a test can answer without a network. */
  readonly fetch?: GraphFetch;
  /** Injected so a test does not put a real toast on the developer's desktop. */
  readonly notify?: GraphNotify | undefined;
  /** Injected so a test does not open a browser. */
  readonly openLink?: GraphOpenLink | undefined;
  readonly now?: () => number;
}

/** How long an outbound POST may take, and how much of the answer is read back. */
const HTTP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

/**
 * The User-Agent an outbound graph POST carries.
 *
 * Not the VRChat one: that carries the user's contact address because VRChat requires it of an API
 * client, and a graph posting to a Discord webhook has no business putting the user's email in a
 * header on somebody else's server. Same shape as the webhook manager's, and the same reasoning.
 */
const USER_AGENT = `${APP_NAME}/${APP_VERSION} (graph)`;

/* -------------------------------------------------------------------------------------------- */
/* Shared plumbing                                                                                */
/* -------------------------------------------------------------------------------------------- */

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function configText(config: NodeConfigValues, key: string): string {
  const raw = config[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function configNumber(config: NodeConfigValues, key: string, fallback: number): number {
  const raw = config[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * "This is what I would have done."
 *
 * Emitted instead of the side effect while a graph is in dry-run, and as an ordinary `graph.note`
 * so the evidence lives in the feed rather than in a log only this screen knows how to read.
 */
function rehearse(deps: ActionDeps, context: ExecuteContext, what: string): void {
  deps.bus.emit({
    kind: "graph.note",
    accountId: context.accountId,
    ts: (deps.now ?? Date.now)(),
    subjectId: context.graphId,
    payload: { graphId: context.graphId, node: context.nodeId, dryRun: true, note: what },
  });
}

async function postBody(
  deps: ActionDeps,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  // The same URL check registered webhooks get: https only, no private or loopback addresses, no
  // redirects followed. A graph is a place a URL gets typed, so it is a place SSRF starts.
  const safe = validateWebhookUrl(url);
  const controller = new AbortController();
  // Our own timer rather than `AbortSignal.timeout`, so it is one we clear — an uncleared timeout
  // per action is a handle that keeps the process alive at shutdown.
  const timer = setTimeout(() => {
    controller.abort();
  }, HTTP_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(safe, {
      method: "POST",
      headers: { "user-agent": USER_AGENT, ...headers },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const excerpt = await readCapped(response);
    if (!response.ok) {
      throw new Error(
        `${String(response.status)} from ${new URL(safe).host}${excerpt === "" ? "" : `: ${excerpt}`}`,
      );
    }
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

/** How much of a failed response is quoted back in the error. An excerpt, not a copy. */
const EXCERPT_CHARS = 200;

/**
 * The first {@link EXCERPT_CHARS} characters of a response, reading at most
 * {@link MAX_RESPONSE_BYTES} to get them.
 *
 * The cap is on the **read**, which is the only place it does anything. This used to call
 * `response.text()` and slice the result, so the whole body was already buffered in memory by the
 * time either slice ran: a webhook answering with a 200 MB error page was 200 MB of daemon before
 * the 8 KiB limit was consulted. The stream is cancelled as soon as there is enough to quote.
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let excerpt = "";
  let bytes = 0;
  try {
    while (bytes < MAX_RESPONSE_BYTES && excerpt.length < EXCERPT_CHARS) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      excerpt += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return "";
  } finally {
    // Cancelled rather than left to drain: the rest of the body is bytes nobody asked for, and an
    // unread stream holds the connection open.
    await reader.cancel().catch(() => undefined);
  }
  return excerpt.slice(0, EXCERPT_CHARS);
}

/**
 * A URL from a config box, checked the way a registered webhook's is: https only, no private or
 * loopback addresses. Thrown from here it reaches the node's `error` port like any other failure.
 */
function safeUrl(config: NodeConfigValues, key: string): string {
  return validateWebhookUrl(configText(config, key));
}

/* -------------------------------------------------------------------------------------------- */
/* HTTP                                                                                           */
/* -------------------------------------------------------------------------------------------- */

const WEBHOOK: NodeDefinition = {
  id: "webhook",
  kind: "action",
  title: "Send a webhook",
  description: "POSTs JSON to a URL you choose.",
  category: "Send",
  inputs: [
    { id: "body", label: "Body", type: "json" },
    { id: "text", label: "Text", type: "string" },
  ],
  outputs: [{ id: "status", label: "Status", type: "number" }],
  config: [{ kind: "text", id: "url", label: "URL", placeholder: "https://…", required: true }],
  body: [
    { kind: "literal", text: "POST " },
    { kind: "config", field: "url", fallback: "…" },
  ],
};

const DISCORD: NodeDefinition = {
  id: "discord",
  kind: "action",
  title: "Post to Discord",
  description: "Sends a message through a Discord webhook URL.",
  category: "Send",
  inputs: [{ id: "text", label: "Message", type: "string", required: true }],
  outputs: [{ id: "status", label: "Status", type: "number" }],
  config: [
    {
      kind: "text",
      id: "url",
      label: "Webhook URL",
      placeholder: "https://discord.com/api/webhooks/…",
      required: true,
    },
    { kind: "text", id: "username", label: "Post as", description: "Optional." },
  ],
  body: [
    { kind: "literal", text: "Discord: " },
    { kind: "port", port: "text" },
  ],
};

const NTFY: NodeDefinition = {
  id: "ntfy",
  kind: "action",
  title: "Send an ntfy notification",
  description: "Pushes a notification to a phone through ntfy.",
  category: "Send",
  inputs: [{ id: "text", label: "Message", type: "string", required: true }],
  outputs: [{ id: "status", label: "Status", type: "number" }],
  config: [
    { kind: "text", id: "server", label: "Server", default: "https://ntfy.sh" },
    { kind: "text", id: "topic", label: "Topic", required: true },
    { kind: "text", id: "title", label: "Title", description: "Optional." },
    {
      kind: "select",
      id: "priority",
      label: "Priority",
      options: [
        { value: "3", label: "Default" },
        { value: "4", label: "High" },
        { value: "5", label: "Urgent" },
        { value: "2", label: "Low" },
      ],
      default: "3",
    },
  ],
  body: [
    { kind: "literal", text: "ntfy " },
    { kind: "config", field: "topic", fallback: "…" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Overlays                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const OSC: NodeDefinition = {
  id: "osc",
  kind: "action",
  title: "Send OSC",
  description: "Sends one OSC message over UDP. VRChat listens on 9000; so do most overlays.",
  category: "Send",
  inputs: [{ id: "value", label: "Value", type: "json" }],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [
    { kind: "text", id: "host", label: "Host", default: "127.0.0.1" },
    { kind: "number", id: "port", label: "Port", default: 9000, min: 1, max: 65535 },
    {
      kind: "text",
      id: "address",
      label: "Address",
      placeholder: "/avatar/parameters/…",
      required: true,
    },
  ],
  body: [{ kind: "config", field: "address", fallback: "/…" }],
};

const XSOVERLAY: NodeDefinition = {
  id: "xsoverlay",
  kind: "action",
  title: "Notify in VR",
  description: "Shows a notification through XSOverlay. OVR Toolkit users can use the OSC node.",
  category: "Send",
  inputs: [{ id: "text", label: "Message", type: "string", required: true }],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [
    { kind: "text", id: "host", label: "Host", default: "127.0.0.1" },
    { kind: "number", id: "port", label: "Port", default: 42069, min: 1, max: 65535 },
    { kind: "text", id: "title", label: "Title", default: "vrc.zip" },
    { kind: "number", id: "seconds", label: "Seconds", default: 4, min: 1, max: 60 },
  ],
  body: [
    { kind: "literal", text: "VR: " },
    { kind: "port", port: "text" },
  ],
};

/**
 * The desktop toast, and the one beside `Notify in VR` on purpose.
 *
 * The pair is the point: an automation that fires while the headset is on wants the overlay, and one
 * that fires while it is not wants the desktop. Neither is a fallback for the other, so neither
 * tries to be — a node that silently chose would be wrong roughly half the time and never say so.
 *
 * `Shown` is a real answer rather than decoration. A notification can be refused by the OS, switched
 * off in settings, or unavailable entirely (a headless box, a Linux install with no `notify-send`),
 * and the daemon's notifier reports all three as *not shown* instead of throwing. So a graph that
 * genuinely has to reach somebody can wire this into a condition and fall through to Discord.
 */
/** Five, because Windows shows five and drops the whole set when it is handed a sixth. */
const DESKTOP_BUTTONS = 5;

/**
 * Two ports per possible button: what it says, and what it does it with.
 *
 * All ten are declared and only as many as there are buttons are drawn — the same trick
 * `Compose text` uses for its twenty-six slots, and for the same reason: a node's ports are part of
 * its identity, so they cannot depend on an instance's config. See `variadicInputs`, and
 * `variadicInputsStride` for why they are declared as pairs rather than as two runs.
 *
 * They exist because both halves of a button are about *this* notification rather than about the
 * graph. "Accept" is a label; "Accept from Kirac" is an answer to something. And the argument is the
 * half that is almost never a constant: the link a button opens is a link to the person the event
 * was about, the screen it opens is the instance somebody just joined, and typing either into the
 * config means one notification's worth of button, sent every time.
 */
const DESKTOP_BUTTON_PORTS = Array.from({ length: DESKTOP_BUTTONS }, (_, index) => {
  const n = String(index + 1);
  return [
    {
      id: `button${n}`,
      label: `Button ${n} says`,
      type: "string" as const,
      description: "Overrides that button's text for this notification.",
    },
    {
      id: `button${n}arg`,
      label: `Button ${n} uses`,
      type: "string" as const,
      description:
        "Overrides what that button acts on: the link it opens, the vrc.zip screen it opens, or the minutes it waits before showing this again.",
    },
  ];
}).flat();

const DESKTOP: NodeDefinition = {
  id: "desktop-notification",
  kind: "action",
  title: "Notify on this computer",
  description: "Raises an ordinary desktop notification. The VR overlay node is the headset half.",
  category: "Send",
  inputs: [
    { id: "text", label: "Message", type: "string", required: true },
    {
      id: "title",
      label: "Title",
      type: "string",
      description: "Overrides the title below, so it can name whoever this is about.",
    },
    {
      id: "image",
      label: "Picture",
      type: "string",
      description: "A file on this computer, or a VRChat image URL. Windows only.",
    },
    {
      id: "id",
      label: "Called",
      type: "string",
      description: "Names this one notification, so a press trigger can wait for exactly it.",
    },
    {
      id: "data",
      label: "Carries",
      type: "json",
      description:
        "Anything at all, handed back to the press trigger untouched. Not shown to anybody: this is how a press minutes later knows what it was about.",
    },
    {
      id: "silent",
      label: "No sound",
      type: "boolean",
      description:
        "Overrides the switch below. Wire a condition in to keep one notification quiet without the rest of them being.",
    },
    ...DESKTOP_BUTTON_PORTS,
  ],
  // The count comes from the buttons themselves rather than a second number to keep in step with
  // them; the six fixed ports above are never hidden. Each button is worth two ports, which is what
  // the stride says. See `visibleInputCount`.
  variadicInputs: "buttons",
  variadicInputsBase: 6,
  variadicInputsStride: 2,
  outputs: [
    {
      id: "shown",
      label: "Shown",
      type: "boolean",
      description: "False when the system refused it or has notifications switched off.",
    },
    {
      id: "id",
      label: "Notification",
      type: "string",
      description: "Names this notification. The press trigger reports the same value back.",
    },
    {
      id: "dropped",
      label: "Dropped",
      type: "list<string>",
      description: "Anything this computer could not do: buttons and pictures are Windows only.",
    },
  ],
  config: [
    { kind: "text", id: "title", label: "Title", default: "vrc.zip" },
    {
      kind: "text",
      id: "id",
      label: "Called",
      placeholder: "a new one each time",
      description:
        "Names this one notification. The press trigger can wait for exactly this one, and raising it again replaces what was on screen under the same name. A tag names the kind; this names the instance.",
    },
    {
      kind: "text",
      id: "tag",
      label: "Tag",
      placeholder: "friend-online",
      description:
        "Names this kind of notification. A second one with the same tag replaces the first instead of stacking up, and the press trigger can listen for just this tag.",
    },
    {
      kind: "boolean",
      id: "silent",
      label: "No sound",
      default: false,
      description: "It still appears. Windows and Linux only.",
    },
    {
      kind: "buttons",
      id: "buttons",
      label: "Buttons",
      max: DESKTOP_BUTTONS,
      description:
        "Windows only, and at most five. Every press reaches the press trigger; the action is what happens as well.",
      actions: [
        { value: "signal", label: "Tell the graph" },
        {
          value: "url",
          label: "Open a link",
          argumentLabel: "Link",
          placeholder: "https://vrchat.com/home/user/usr_…",
        },
        {
          value: "screen",
          label: "Open vrc.zip",
          argumentLabel: "Screen",
          placeholder: "/friends",
        },
        {
          value: "snooze",
          label: "Show it again later",
          argumentLabel: "Minutes",
          placeholder: "10",
        },
        // The one action that never reaches this process: Windows closes its own toast, so there is
        // no press to report and therefore no name worth asking for.
        { value: "dismiss", label: "Just close it", reportsPress: false },
      ],
    },
    {
      kind: "text",
      id: "image",
      label: "Picture",
      placeholder: "https://api.vrchat.cloud/…",
      description:
        "A file on this computer, or a VRChat image URL that vrc.zip fetches. Shown as the round icon beside the text. Windows only.",
    },
    {
      kind: "select",
      id: "scenario",
      label: "Kind",
      default: "default",
      description: "A reminder or an alarm stays on screen until it is answered. Windows only.",
      options: [
        { value: "default", label: "ordinary" },
        { value: "reminder", label: "a reminder" },
        { value: "alarm", label: "an alarm" },
        { value: "incomingCall", label: "an incoming call" },
      ],
    },
    {
      kind: "select",
      id: "duration",
      label: "On screen for",
      default: "short",
      options: [
        { value: "short", label: "the usual few seconds" },
        { value: "long", label: "longer" },
      ],
    },
    {
      kind: "duration",
      id: "expires",
      label: "Forget it after",
      description:
        "How long it stays in the Action Center once it leaves the screen. Zero leaves it there. Windows only.",
      default: 0,
    },
  ],
  body: [
    { kind: "literal", text: "notify: " },
    { kind: "port", port: "text" },
  ],
};

/**
 * The other end of a button.
 *
 * A trigger rather than an output on the action, and that is the decision worth stating. A press is
 * not the result of raising a notification: it happens minutes later, from the Action Center, on a
 * different day, or never. An action node that waited for one would hold a graph run open for the
 * length of a human being's attention.
 *
 * As a trigger it is also free to be a *different* graph. "Show me a toast when someone comes
 * online" and "invite them when I press Accept" are two automations that share a notification, and
 * this is what lets them be two graphs — or one graph twice, which is the same thing said in the
 * canvas.
 */
const DESKTOP_PRESSED: NodeDefinition = {
  id: "on-notification-press",
  kind: "trigger",
  title: "When a notification is pressed",
  description: "Fires when somebody presses a button on a notification vrc.zip raised.",
  category: "Triggers",
  outputs: [
    {
      id: "button",
      label: "Button",
      type: "string",
      description: "The button's name. Blank when the notification itself was clicked.",
    },
    { id: "label", label: "It said", type: "string" },
    { id: "tag", label: "Tag", type: "string" },
    {
      id: "notification",
      label: "Notification",
      type: "string",
      description: "The value the notify node handed back when it raised this one.",
    },
    { id: "argument", label: "With", type: "string" },
    {
      id: "data",
      label: "Carried",
      type: "json",
      description:
        "Whatever the notify node was given to carry. Empty for a press on a notification that carried nothing.",
    },
    { id: "at", label: "At", type: "number" },
  ],
  config: [
    {
      kind: "text",
      id: "tag",
      label: "Tag",
      placeholder: "any",
      description: "Only notifications carrying this tag. Leave it blank to hear every press.",
    },
    {
      kind: "text",
      id: "notification",
      label: "Called",
      placeholder: "any",
      description:
        "Only the notification with this name, which is what the notify node was told to call it. Narrower than a tag: this is one notification rather than a kind of them.",
    },
    {
      kind: "text",
      id: "button",
      label: "Button",
      placeholder: "any",
      description:
        "Only this button. Leave it blank for any of them, including a click on the notification itself.",
    },
  ],
  body: [
    { kind: "literal", text: "pressed " },
    { kind: "config", field: "button", fallback: "anything" },
  ],
};

/**
 * Opening a link, which is a node because a notification button already was one.
 *
 * The button action came first and made the gap obvious: a graph could open a URL as a *side effect
 * of somebody pressing something*, and had no way to just open one. Now both spellings exist and
 * they share an opener.
 *
 * `Opened` is a real answer for the same reason `Shown` is. The opener refuses anything that is not
 * public https — a graph must not be able to hand the operating system's protocol handler a `file://`
 * URL, or reach a loopback address that trusts its callers — and a headless box has no browser to
 * open anything with. Both come back as false rather than as a thrown run.
 */
const OPEN_LINK: NodeDefinition = {
  id: "open-link",
  kind: "action",
  title: "Open a link",
  description: "Opens a link in the browser on this computer.",
  category: "Send",
  inputs: [{ id: "url", label: "Link", type: "string", required: true }],
  outputs: [
    {
      id: "opened",
      label: "Opened",
      type: "boolean",
      description:
        "False for anything that is not a public https link, and on a machine with no browser.",
    },
  ],
  body: [
    { kind: "literal", text: "open " },
    { kind: "port", port: "url" },
  ],
};

/** XSOverlay's notification API: one JSON object in a UDP datagram on 42069. */
function xsOverlayPacket(title: string, message: string, seconds: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      messageType: 1,
      index: 0,
      timeout: seconds,
      height: 110,
      opacity: 1,
      volume: 0,
      audioPath: "",
      title,
      content: message,
      useBase64Icon: false,
      icon: "",
      sourceApp: "vrc.zip",
    }),
  );
}

/* -------------------------------------------------------------------------------------------- */
/* VRChat, and the feed                                                                           */
/* -------------------------------------------------------------------------------------------- */

const INVITE: NodeDefinition = {
  id: "invite",
  kind: "action",
  title: "Invite someone",
  description: "Sends a VRChat invite to an instance.",
  category: "VRChat",
  inputs: [
    { id: "user", label: "To", type: "user", required: true },
    { id: "instance", label: "Instance id", type: "instance", required: true },
  ],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [
    {
      kind: "account",
      id: "accountId",
      label: "Act as",
      description: "Leave blank to use the graph's account.",
    },
  ],
  body: [
    { kind: "literal", text: "invite " },
    { kind: "port", port: "user" },
  ],
};

/**
 * The other kind of invite, and it is a different act from `Invite someone`.
 *
 * An instance invite is one person asking another to come and stand somewhere for an evening. A
 * group invite is membership, it outlives the run that sent it, and whether it is allowed at all
 * depends on the acting account's **role in that group** rather than on the friendship. So it takes
 * a `group` port beside the `user` one, and its refusal says the thing that is usually true: the
 * problem is your permissions, not theirs.
 *
 * **No override-the-block switch.** VRChat's endpoint takes `confirmOverrideBlock`, and this node
 * never sends it. A graph that can push an invite past a block is a harassment tool with a schedule
 * on it; see `wiring/social-actions.ts`.
 */
const INVITE_TO_GROUP: NodeDefinition = {
  id: "invite-to-group",
  kind: "action",
  title: "Invite someone to a group",
  description: "Invites somebody to join a group. Needs a role in that group that may do it.",
  category: "VRChat",
  inputs: [
    { id: "user", label: "To", type: "user", required: true },
    { id: "group", label: "Group id", type: "group", required: true },
  ],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [
    {
      kind: "account",
      id: "accountId",
      label: "Act as",
      description: "Leave blank to use the graph's account.",
    },
  ],
  body: [
    { kind: "literal", text: "invite " },
    { kind: "port", port: "user" },
    { kind: "literal", text: " to " },
    { kind: "port", port: "group" },
  ],
};

const REQUEST_INVITE: NodeDefinition = {
  id: "request-invite",
  kind: "action",
  title: "Ask for an invite",
  description: "Sends a VRChat invite request.",
  category: "VRChat",
  inputs: [{ id: "user", label: "From", type: "user", required: true }],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [{ kind: "account", id: "accountId", label: "Act as" }],
  body: [
    { kind: "literal", text: "ask " },
    { kind: "port", port: "user" },
  ],
};

const BOOP: NodeDefinition = {
  id: "boop",
  kind: "action",
  title: "Boop",
  description: "Boops someone.",
  category: "VRChat",
  inputs: [{ id: "user", label: "Who", type: "user", required: true }],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [{ kind: "account", id: "accountId", label: "Act as" }],
  body: [
    { kind: "literal", text: "boop " },
    { kind: "port", port: "user" },
  ],
};

const WEAR_AVATAR: NodeDefinition = {
  id: "wear-avatar",
  kind: "action",
  title: "Wear an avatar",
  description: "Switches the account's avatar.",
  // Under **Me** rather than VRChat: the category means "acts on you", and this is the one action
  // in this file that does. It used to say so in its own description instead, which was the same
  // observation with nowhere to put it. See `me.ts`.
  category: ME_CATEGORY,
  inputs: [{ id: "avatar", label: "Avatar id", type: "avatar", required: true }],
  outputs: [{ id: "worn", label: "Worn", type: "boolean" }],
  config: [{ kind: "account", id: "accountId", label: "Act as" }],
  body: [
    { kind: "literal", text: "wear " },
    { kind: "port", port: "avatar" },
  ],
};

const NOTE: NodeDefinition = {
  id: "note",
  kind: "action",
  title: "Write to the feed",
  description: "Records a line in vrc.zip's own feed. The graph talking to you.",
  category: "Send",
  inputs: [{ id: "text", label: "Text", type: "string", required: true }],
  outputs: [{ id: "written", label: "Written", type: "boolean" }],
  body: [
    { kind: "literal", text: "note: " },
    { kind: "port", port: "text" },
  ],
};

/**
 * An instance string back into its two halves.
 *
 * `wrld_x:12345~region(eu)` is what the log and the API both use, and an invite needs the world and
 * the instance separately. A string this cannot parse is an error rather than a guess: sending an
 * invite to the wrong place is worse than not sending one.
 */
export function splitInstance(location: string): GraphInviteTarget | null {
  const colon = location.indexOf(":");
  if (colon <= 0 || colon === location.length - 1) return null;
  return { worldId: location.slice(0, colon), instanceId: location.slice(colon + 1) };
}

function requireAccount(context: ExecuteContext, doing: string): string {
  if (context.accountId === null || context.accountId === "") {
    throw new Error(`No account is set for this graph, so vrc.zip cannot ${doing}.`);
  }
  return context.accountId;
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The buttons this run should carry: the configured rows, with any wired labels put over the top.
 *
 * The wired label wins when there is one, and an empty wire is not one — a `Compose text` that
 * produced nothing must not blank a button the author wrote a label for.
 *
 * Two rules are enforced here rather than in the parser, and both for the same reason: the editor
 * has to be able to hold a half-typed row and `parseButtonRows` has to be able to read one back, so
 * anything about what makes a *usable button* belongs where the button is actually drawn.
 *
 *  - A row with no text is dropped. A button with no label is one nobody can press.
 *  - A row whose name is already taken is dropped, keeping the first. Two buttons answering to one
 *    name is a press the graph cannot attribute — and it shows up as "the wrong branch ran", not as
 *    an error.
 */
function desktopButtons(
  config: NodeConfigValues,
  inputs: PortValues,
): { id: string; label: string; action?: GraphButtonAction; argument?: string }[] {
  return parseButtonRows(config.buttons)
    .slice(0, DESKTOP_BUTTONS)
    .map((row, index) => {
      const n = String(index + 1);
      const wiredLabel = text(inputs[`button${n}`]).trim();
      // Not trimmed away to nothing: a wired argument that arrives blank is a graph that had no
      // value to give, and the configured one is what the author meant to fall back to.
      const wiredArgument = text(inputs[`button${n}arg`]).trim();
      const argument = wiredArgument === "" ? row.argument : wiredArgument;
      return {
        id: row.id,
        label: wiredLabel === "" ? row.label.trim() : wiredLabel,
        ...(isButtonAction(row.action) ? { action: row.action } : {}),
        ...(argument === "" ? {} : { argument }),
      };
    })
    .filter(usableButton());
}

/**
 * The two rules above, as one pass that remembers the names it has already handed out.
 *
 * Both rules used to be one `filter` whose duplicate check ran `findIndex` over the array *before*
 * the labelled ones were kept — so a blank-labelled row and a configured row sharing an id lost
 * both: the first for having no label, the second for not being the first occurrence. The
 * configured button vanished from the notification and nothing said why. Keeping the state here
 * means "first" means the first row that was usable at all.
 */
function usableButton(): (button: { id: string; label: string }) => boolean {
  const taken = new Set<string>();
  return (button) => {
    if (button.label === "" || taken.has(button.id)) return false;
    taken.add(button.id);
    return true;
  };
}

const BUTTON_ACTIONS: readonly GraphButtonAction[] = [
  "signal",
  "url",
  "screen",
  "dismiss",
  "snooze",
];

/** A stored action this build does not know is treated as a plain signal, not as an error. */
function isButtonAction(value: string): value is GraphButtonAction {
  return (BUTTON_ACTIONS as readonly string[]).includes(value);
}

const SCENARIOS = ["default", "reminder", "alarm", "incomingCall"] as const;

function isScenario(value: string): value is (typeof SCENARIOS)[number] {
  return (SCENARIOS as readonly string[]).includes(value);
}

/**
 * A value the toast can hold onto and the bus can carry, or `undefined` for one it cannot.
 *
 * The round trip is the check. Whatever a `json` port hands over goes on the EventBus when the press
 * arrives, and from there into the feed's SQLite row — so a cycle, a function or a `BigInt` reaching
 * the notifier is a write that throws minutes later, from an event, with no run left to attribute it
 * to. Dropped here instead: the notification still appears, and it carries nothing rather than
 * carrying a landmine.
 */
function portableJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : (JSON.parse(encoded) as unknown);
  } catch {
    return undefined;
  }
}

/** What a press event carries. Read defensively: it crosses the bus like anything else. */
function pressOf(event: BusEvent): {
  notificationId: string;
  tag: string;
  button: string;
  label: string;
  argument: string;
  data: unknown;
} | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const notificationId = record.notificationId;
  if (typeof notificationId !== "string") return null;
  const string = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    notificationId,
    tag: string(record.tag),
    // Null is the body being clicked rather than a button, which reads as "" on a string port.
    button: string(record.button),
    label: string(record.label),
    argument: string(record.argument),
    // Whatever the notify node attached, in whatever shape it was. Null rather than undefined so a
    // press that carried nothing reads as an empty port instead of an absent one.
    data: record.data ?? null,
  };
}

export function actionNodes(deps: ActionDeps): BuiltinNode[] {
  const social = deps.social;

  return [
    {
      definition: WEBHOOK,
      execute: async (inputs, config, context) => {
        // Validated *before* the rehearsal, not inside `postBody` afterwards. The rehearsal is the
        // evidence somebody reads at the hold-to-confirm gesture that arms the graph, so it has to
        // be a rehearsal of the request that would actually go out. A dry run of an http:// address
        // on the local network used to report a cheerful "POST to ..." and a status of 0, and the
        // refusal only arrived once the graph was armed and firing.
        const url = safeUrl(config, "url");
        const payload =
          inputs.body === undefined ? { text: text(inputs.text) } : (inputs.body as unknown);
        if (context.dryRun) {
          rehearse(deps, context, `POST to ${url}: ${text(payload).slice(0, 200)}`);
          return { status: 0 };
        }
        return {
          status: await postBody(deps, url, JSON.stringify(payload), {
            "content-type": "application/json",
          }),
        };
      },
    },
    {
      definition: DISCORD,
      execute: async (inputs, config, context) => {
        // Checked ahead of the rehearsal, for the reason spelled out on the webhook node above.
        const url = safeUrl(config, "url");
        const username = configText(config, "username");
        const message = text(inputs.text);
        if (context.dryRun) {
          rehearse(deps, context, `Discord message: ${message.slice(0, 200)}`);
          return { status: 0 };
        }
        // Discord truncates at 2000 characters and rejects an empty body; a graph that composed
        // something longer wanted the message sent, not a 400 back.
        const body = JSON.stringify({
          content: message.slice(0, 2000) || "(empty)",
          ...(username === "" ? {} : { username }),
        });
        return { status: await postBody(deps, url, body, { "content-type": "application/json" }) };
      },
    },
    {
      definition: NTFY,
      execute: async (inputs, config, context) => {
        const server = configText(config, "server") || "https://ntfy.sh";
        const topic = configText(config, "topic");
        const title = configText(config, "title");
        const priority = configText(config, "priority") || "3";
        const message = text(inputs.text);
        // The address is built and checked before the rehearsal, so a self-hosted ntfy the check
        // will refuse is refused while the author is still watching. See the webhook node above.
        const url = validateWebhookUrl(
          `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`,
        );
        if (context.dryRun) {
          rehearse(deps, context, `ntfy ${topic}: ${message.slice(0, 200)}`);
          return { status: 0 };
        }
        return {
          status: await postBody(deps, url, message, {
            "content-type": "text/plain; charset=utf-8",
            ...(title === "" ? {} : { title }),
            priority,
          }),
        };
      },
    },
    {
      definition: OSC,
      execute: async (inputs, config, context) => {
        const host = configText(config, "host") || "127.0.0.1";
        const port = configNumber(config, "port", 9000);
        const address = configText(config, "address");
        const value = inputs.value;
        if (context.dryRun) {
          rehearse(deps, context, `OSC ${address} to ${host}:${String(port)}`);
          return { sent: false };
        }
        const args =
          value === undefined || value === null
            ? []
            : [typeof value === "object" ? text(value) : (value as string | number | boolean)];
        await sendUdp(host, port, encodeOscMessage(address, args));
        // True means "the datagram left", not "something received it". UDP cannot tell us more, and
        // claiming otherwise would make a graph look like it worked when nothing was listening.
        return { sent: true };
      },
    },
    {
      definition: XSOVERLAY,
      execute: async (inputs, config, context) => {
        const host = configText(config, "host") || "127.0.0.1";
        const port = configNumber(config, "port", 42069);
        const title = configText(config, "title") || "vrc.zip";
        const seconds = configNumber(config, "seconds", 4);
        const message = text(inputs.text);
        if (context.dryRun) {
          rehearse(deps, context, `VR notification: ${message.slice(0, 200)}`);
          return { sent: false };
        }
        await sendUdp(host, port, xsOverlayPacket(title, message, seconds));
        return { sent: true };
      },
    },
    {
      definition: DESKTOP,
      execute: async (inputs, config, context) => {
        const title = text(inputs.title) || configText(config, "title") || "vrc.zip";
        const message = text(inputs.text);
        const buttons = desktopButtons(config, inputs);
        if (context.dryRun) {
          const listed = buttons.length === 0 ? "" : ` [${buttons.map((b) => b.label).join(", ")}]`;
          rehearse(deps, context, `desktop notification: ${message.slice(0, 200)}${listed}`);
          return { shown: false, id: "", dropped: [] };
        }
        // A sentence rather than a silent false: "nothing appeared" and "this build cannot notify
        // at all" are different problems, and only one of them is the user's machine.
        if (deps.notify === undefined) {
          throw new Error("This daemon cannot raise desktop notifications.");
        }

        const named = text(inputs.id) || configText(config, "id");
        const tag = configText(config, "tag");
        const image = text(inputs.image) || configText(config, "image");
        const scenario = configText(config, "scenario");
        const expires = configNumber(config, "expires", 0);
        const carried = portableJson(inputs.data);
        // Only a real boolean overrides the switch. A `boolean` port cannot carry anything else —
        // `json` into a typed port is refused at the wire — so anything else is an unwired port.
        const silent = typeof inputs.silent === "boolean" ? inputs.silent : config.silent === true;
        const result = await deps.notify({
          ...(named === "" ? {} : { id: named }),
          title,
          body: message,
          ...(silent ? { silent: true } : {}),
          ...(tag === "" ? {} : { tag }),
          ...(buttons.length === 0 ? {} : { buttons }),
          ...(image === "" ? {} : { image }),
          ...(isScenario(scenario) && scenario !== "default" ? { scenario } : {}),
          ...(configText(config, "duration") === "long" ? { duration: "long" as const } : {}),
          // Zero is "leave it there", which is the absence of an expiry rather than an expiry of
          // none — sending it would remove the notification the instant it was raised.
          ...(expires > 0 ? { expiresInMs: expires } : {}),
          ...(carried === undefined ? {} : { data: carried }),
        });
        return {
          shown: result.shown,
          id: result.id ?? "",
          dropped: [...(result.ignored ?? [])],
        };
      },
    },
    {
      definition: DESKTOP_PRESSED,
      arm: (request) => {
        const wantedTag = configText(request.config, "tag");
        const wantedButton = configText(request.config, "button");
        const wantedNotification = configText(request.config, "notification");

        const subscription = deps.bus.subscribe(
          (event) => {
            const press = pressOf(event);
            if (press === null) return;
            if (wantedTag !== "" && press.tag !== wantedTag) return;
            // Narrower than the tag, and checked the same way: this is one notification rather than
            // a kind of them, which only means anything because the notify node can name one.
            if (wantedNotification !== "" && press.notificationId !== wantedNotification) return;
            // A blank button hears everything, the body click included. A named one hears only
            // itself — which is what makes "when Accept is pressed" one node rather than two.
            if (wantedButton !== "" && press.button !== wantedButton) return;
            request.fire({
              button: press.button,
              label: press.label,
              tag: press.tag,
              notification: press.notificationId,
              argument: press.argument,
              data: press.data,
              at: event.ts,
            });
          },
          { kinds: [DESKTOP_ACTIVATION_KIND] },
        );
        return () => {
          subscription.unsubscribe();
        };
      },
    },
    {
      definition: OPEN_LINK,
      execute: async (inputs, _config, context) => {
        const url = text(inputs.url).trim();
        if (context.dryRun) {
          rehearse(deps, context, `open ${url.slice(0, 200)}`);
          return { opened: false };
        }
        if (deps.openLink === undefined) {
          throw new Error("This daemon cannot open links.");
        }
        return { opened: await deps.openLink(url) };
      },
    },
    {
      definition: INVITE,
      execute: async (inputs, _config, context) => {
        const user = text(inputs.user);
        const target = splitInstance(text(inputs.instance));
        if (target === null) throw new Error(`"${text(inputs.instance)}" is not an instance.`);
        if (context.dryRun) {
          rehearse(deps, context, `invite ${user} to ${text(inputs.instance)}`);
          return { sent: false };
        }
        if (social === undefined) throw new Error("This daemon cannot send invites.");
        await social.invite(requireAccount(context, "send the invite"), user, target);
        return { sent: true };
      },
    },
    {
      definition: INVITE_TO_GROUP,
      execute: async (inputs, _config, context) => {
        const user = text(inputs.user);
        const group = text(inputs.group);
        if (context.dryRun) {
          rehearse(deps, context, `invite ${user} to ${group}`);
          return { sent: false };
        }
        if (social === undefined) throw new Error("This daemon cannot send invites.");
        await social.inviteToGroup(requireAccount(context, "send the group invite"), group, user);
        return { sent: true };
      },
    },
    {
      definition: REQUEST_INVITE,
      execute: async (inputs, _config, context) => {
        const user = text(inputs.user);
        if (context.dryRun) {
          rehearse(deps, context, `ask ${user} for an invite`);
          return { sent: false };
        }
        if (social === undefined) throw new Error("This daemon cannot request invites.");
        await social.requestInvite(requireAccount(context, "ask for the invite"), user);
        return { sent: true };
      },
    },
    {
      definition: BOOP,
      execute: async (inputs, _config, context) => {
        const user = text(inputs.user);
        if (context.dryRun) {
          rehearse(deps, context, `boop ${user}`);
          return { sent: false };
        }
        if (social === undefined) throw new Error("This daemon cannot boop.");
        await social.boop(requireAccount(context, "send the boop"), user);
        return { sent: true };
      },
    },
    {
      definition: WEAR_AVATAR,
      execute: async (inputs, _config, context) => {
        const avatar = text(inputs.avatar);
        if (context.dryRun) {
          rehearse(deps, context, `wear ${avatar}`);
          return { worn: false };
        }
        if (social === undefined) throw new Error("This daemon cannot change avatars.");
        await social.selectAvatar(requireAccount(context, "change the avatar"), avatar);
        return { worn: true };
      },
    },
    {
      definition: NOTE,
      execute: (inputs, _config, context) => {
        // The one action with no dry-run branch, because writing a line in the user's own feed is
        // not something they need protecting from — and a rehearsal that suppressed it would make
        // the dry-run log emptier than the real run it is evidence for.
        deps.bus.emit({
          kind: "graph.note",
          accountId: context.accountId,
          ts: (deps.now ?? Date.now)(),
          subjectId: context.graphId,
          payload: {
            graphId: context.graphId,
            node: context.nodeId,
            dryRun: context.dryRun,
            note: text(inputs.text),
          },
        });
        return { written: true };
      },
    },
  ];
}
