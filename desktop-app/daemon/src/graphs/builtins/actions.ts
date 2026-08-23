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

import type { NodeConfigValues, NodeDefinition } from "@vrcz/plugin-api/nodes";
import { APP_NAME, APP_VERSION } from "@vrcz/shared";
import type { EventBus } from "../../bus/event-bus.ts";
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
  selectAvatar(accountId: string, avatarId: string): Promise<void>;
}

/**
 * The injectable fetch seam. Narrower than `typeof fetch` so a test double is a two-line function —
 * the same shape and the same reason as `webhooks/delivery.ts`.
 */
export type GraphFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Raising an OS notification, as the graph runtime needs it.
 *
 * Structurally satisfied by `os/desktop-notification.ts`, which never rejects and answers with
 * whether the toast was actually shown. Both halves of that matter here: a graph must not fail
 * because the machine has notifications switched off, and it is entitled to *know* that nothing
 * appeared rather than being told it worked.
 */
export type GraphNotify = (notification: {
  title: string;
  body: string;
}) => Promise<{ shown: boolean; reason?: string }>;

export interface ActionDeps {
  readonly bus: EventBus;
  readonly social?: GraphSocialActions | undefined;
  /** Injected so a test can answer without a network. */
  readonly fetch?: GraphFetch;
  /** Injected so a test does not put a real toast on the developer's desktop. */
  readonly notify?: GraphNotify | undefined;
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

/** Reads at most {@link MAX_RESPONSE_BYTES}, because an error message is not a place to store data. */
async function readCapped(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, MAX_RESPONSE_BYTES).slice(0, 200);
  } catch {
    return "";
  }
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
const DESKTOP: NodeDefinition = {
  id: "desktop-notification",
  kind: "action",
  title: "Notify on this computer",
  description: "Raises an ordinary desktop notification. The VR overlay node is the headset half.",
  category: "Send",
  inputs: [{ id: "text", label: "Message", type: "string", required: true }],
  outputs: [
    {
      id: "shown",
      label: "Shown",
      type: "boolean",
      description: "False when the system refused it or has notifications switched off.",
    },
  ],
  config: [{ kind: "text", id: "title", label: "Title", default: "vrc.zip" }],
  body: [
    { kind: "literal", text: "notify: " },
    { kind: "port", port: "text" },
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
    { id: "instance", label: "Instance", type: "instance", required: true },
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
  inputs: [{ id: "avatar", label: "Avatar", type: "avatar", required: true }],
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

export function actionNodes(deps: ActionDeps): BuiltinNode[] {
  const social = deps.social;

  return [
    {
      definition: WEBHOOK,
      execute: async (inputs, config, context) => {
        const url = configText(config, "url");
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
        const url = configText(config, "url");
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
        if (context.dryRun) {
          rehearse(deps, context, `ntfy ${topic}: ${message.slice(0, 200)}`);
          return { status: 0 };
        }
        const url = `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
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
        const title = configText(config, "title") || "vrc.zip";
        const message = text(inputs.text);
        if (context.dryRun) {
          rehearse(deps, context, `desktop notification: ${message.slice(0, 200)}`);
          return { shown: false };
        }
        // A sentence rather than a silent false: "nothing appeared" and "this build cannot notify
        // at all" are different problems, and only one of them is the user's machine.
        if (deps.notify === undefined) {
          throw new Error("This daemon cannot raise desktop notifications.");
        }
        const result = await deps.notify({ title, body: message });
        return { shown: result.shown };
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
