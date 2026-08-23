/**
 * The plugin-side runtime: `definePlugin`, and the `ctx` every doc page describes.
 *
 * Until now a plugin author wrote envelope frames by hand. Every guide in `docs/` showed
 * `export async function activate(ctx)` and `ctx.vrchat.friends.list()`, and none of it existed —
 * the only thing that turned a `lifecycle` frame into a call on an exported function was a test
 * harness with a header explaining that it was standing in for this file.
 *
 * ## Why this ships in the published package rather than in the prelude
 *
 * The obvious place for a host-supplied client is the prelude, which already owns the wire. It
 * cannot go there, and the reason is a hard number rather than a preference: the prelude is
 * injected as source through `bun -e`, Windows caps a command line at 32767 characters, and
 * `MAX_PRELUDE_SOURCE_BYTES` holds it to 16KB with a test asserting it. A request/response
 * correlator, a subscription registry and a typed façade do not fit in what is left, and the
 * alternative — materialising the prelude on disk — reintroduces exactly the TOCTOU the prelude's
 * own header rejects, on the most valuable file on the machine to win a race against.
 *
 * So this is ordinary library code the plugin bundles. Three consequences, all of them good:
 *
 *  - It is compiled into the plugin's artifact by the install pipeline, which means it is
 *    **deny-scanned and content-addressed like the rest of the plugin's code**. Host-injected code
 *    is neither.
 *  - It is versioned with the protocol major the plugin declares, so a plugin compiled against
 *    protocol 1 keeps a protocol-1 client no matter what the daemon later grows.
 *  - It has no authority of its own. Everything here is a frame the host authorises exactly as it
 *    would authorise a hand-written one — this file is convenience, never a privilege. A plugin
 *    that skips it and writes frames itself gets the same answers.
 *
 * ## The seam
 *
 * `globalThis.__vrczHost` is installed by the prelude before any plugin code runs: `send(frame)`,
 * `onFrame(fn)`, `log(message)`, `pluginId`. There is exactly one `onFrame` slot, so exactly one
 * thing may claim it — which is why this module is a singleton and why calling `definePlugin` twice
 * is an error rather than a second registration.
 */

import type { NodeConfigValues, PortValues } from "./nodes.ts";
import {
  type Deadline,
  type DeliveryPolicy,
  type ErrorPayload,
  type EventFilter,
  MAX_CREDITS,
  type PluginEvent,
} from "./protocol.ts";
import type { StorageRecord, StorageUsage } from "./storage.ts";
import type { UiIntentDispatch } from "./ui.ts";

/** What the prelude installs. Declared structurally so this file imports nothing from the host. */
interface HostSeam {
  readonly pluginId: string;
  readonly protocol: number;
  send(frame: unknown): boolean;
  onFrame(handler: (frame: Record<string, unknown>) => void): void;
  log(message: unknown): void;
}

function seam(): HostSeam {
  const host = (globalThis as { __vrczHost?: HostSeam }).__vrczHost;
  if (host === undefined) {
    throw new Error(
      "@vrcz/plugin-api: no host seam. This module only runs inside a vrc.zip plugin process.",
    );
  }
  return host;
}

/** How long a host call waits before the plugin gives up on it. The host has its own deadline. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** An error carrying the host's own code, so `catch` can branch on it rather than on a message. */
export class PluginCallError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  readonly data: unknown;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = "PluginCallError";
    this.code = payload.code;
    this.retryAfterMs = payload.retryAfterMs;
    this.data = payload.data;
  }
}

/** A live subscription. `close()` unsubscribes; the host stops sending on the next tick. */
export interface Subscription {
  readonly id: string;
  close(): Promise<void>;
}

export interface SubscribeOptions {
  readonly filter?: EventFilter;
  /**
   * Overrides the delivery policy. The default is `{credits: 256, maxBatch: 32, overflow:
   * "drop-oldest"}`.
   *
   * **`overflow: "coalesce"` needs a `keyPath`** and this refuses locally without one. The host
   * does not: a coalesce policy with no key silently behaves as drop-oldest there, which is the
   * shape of default that makes a plugin author believe they asked for something they did not get.
   * `keyPath: "userId"` on `friend.location` is the motivating case — it turns 900 queued moves
   * into each friend's current location.
   */
  readonly delivery?: Partial<DeliveryPolicy>;
  /** Called when the host sheds load. Ignoring it means believing you saw everything. */
  readonly onDropped?: (info: { count: number; reason: string; seq: number }) => void;
}

export interface PluginContext {
  readonly pluginId: string;
  /** Goes to the daemon's log, prefixed with your plugin id. `console.log` also works. */
  log(message: unknown): void;
  /** Any host method, including ones this façade does not wrap yet. */
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  readonly vrchat: VrchatApi;
  readonly storage: StorageApi;
  /** The named stores, shared with graphs. Needs the `shared-data` capability. */
  readonly data: DataApi;
  /** Signals between automations. Needs the `signals` capability. */
  readonly signals: SignalsApi;
  readonly events: EventsApi;
  readonly ui: UiApi;
  readonly nodes: NodesApi;
}

export interface NodesApi {
  /**
   * Registers one node type. The id must be one your manifest declares in `contributes.nodes`.
   *
   * Registered at activation rather than declared whole in the manifest, because ports, config and
   * the body template are code — but the *id* has to be in the manifest, which is what lets a saved
   * graph name your node while your plugin is stopped instead of showing a hole.
   */
  register(definition: unknown): Promise<void>;
  /** Fires an armed trigger instance. `outputs` are keyed by output port id. */
  fire(instanceId: string, outputs?: Record<string, unknown>): Promise<void>;
}

export interface UiApi {
  /** Draws (or replaces) a panel. The id must be one your manifest declares. */
  setPanel(panelId: string, tree: unknown): Promise<void>;
  /**
   * Replaces one keyed subtree.
   *
   * Cheaper than a whole tree, and it is what keeps focus, scroll position and an open dialog
   * alive across an update — the host only re-creates what actually changed. Give the node you
   * intend to replace a `key` first; a patch naming a key that is not drawn is refused.
   */
  patchPanel(panelId: string, key: string, tree: unknown): Promise<void>;
  closePanel(panelId: string): Promise<void>;
  /** Shows a toast. The host owns how it looks and how long it lasts. */
  toast(
    message: string,
    options?: { description?: string; tone?: "neutral" | "success" | "warn" | "danger" },
  ): Promise<void>;
}

export interface VrchatApi {
  accounts: { list(): Promise<unknown> };
  friends: { list(params?: { accountId?: string }): Promise<unknown> };
  users: { get(params: { id: string; accountId?: string }): Promise<unknown> };
  worlds: { get(params: { id: string; accountId?: string }): Promise<unknown> };
  instances: { get(params: { id: string; accountId?: string }): Promise<unknown> };
  groups: { get(params: { id: string; accountId?: string }): Promise<unknown> };
}

export interface StorageApi {
  kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    keys(prefix?: string, limit?: number): Promise<string[]>;
  };
  records: {
    append(key: string, value: unknown): Promise<{ id: number; ts: number }>;
    query(options?: {
      prefix?: string;
      since?: number;
      until?: number;
      limit?: number;
    }): Promise<StorageRecord[]>;
    delete(options: { prefix?: string; before?: number }): Promise<number>;
  };
  usage(): Promise<StorageUsage>;
}

/**
 * The named stores, shared with the user's graphs.
 *
 * The same rows the `store-*` graph nodes read and write, addressed the same way: a store name (the
 * `default` store when you name none), and a collection name inside it. That is the whole point — a
 * graph writes `welcomed` and your plugin reads `welcomed`, with the name as the only coordination
 * either of you needs.
 *
 * Needs the **`shared-data`** capability, which is dangerous and says so on the consent screen: it
 * is read and write access to what every automation on this machine has stored.
 *
 * There is no `deleteStore`. Removing a store removes what another graph may be mid-run over, so it
 * is a person's gesture from the Stores panel rather than anything a plugin can do.
 */
export interface DataApi {
  /** One value under a name. `null` for a key that is not set. */
  get(key: string, store?: string): Promise<unknown>;
  set(key: string, value: unknown, store?: string): Promise<void>;
  /** True when there was something to remove. */
  delete(key: string, store?: string): Promise<boolean>;
  map: {
    get(name: string, key: string, store?: string): Promise<unknown>;
    set(name: string, key: string, value: unknown, store?: string): Promise<void>;
    delete(name: string, key: string, store?: string): Promise<boolean>;
    entries(name: string, store?: string): Promise<{ key: string; value: unknown }[]>;
    clear(name: string, store?: string): Promise<void>;
  };
  set_: {
    /** True when the member was **new**, which is the half worth branching on. */
    add(name: string, item: unknown, store?: string): Promise<boolean>;
    has(name: string, item: unknown, store?: string): Promise<boolean>;
    delete(name: string, item: unknown, store?: string): Promise<boolean>;
    items(name: string, store?: string): Promise<unknown[]>;
    clear(name: string, store?: string): Promise<void>;
  };
  list: {
    /** Appends, and returns the new length. `max` keeps only the most recent few. */
    add(name: string, item: unknown, options?: { max?: number; store?: string }): Promise<number>;
    items(name: string, store?: string): Promise<unknown[]>;
    /** Removes every copy, and returns how many went. */
    remove(name: string, item: unknown, store?: string): Promise<number>;
    clear(name: string, store?: string): Promise<void>;
  };
}

/** One signal, as a listener receives it. */
export interface SignalMessage {
  readonly name: string;
  /** Whatever the sender attached, or null. */
  readonly value: unknown;
  /** The graph that sent it, or `plugin:<id>` when a plugin did. */
  readonly from: string;
  readonly at: number;
}

/**
 * Signals: a name and a value, between every automation on this machine.
 *
 * Needs the **`signals`** capability. `emit` is always global — `local` means "this graph only" and
 * a plugin is not a graph, so a local signal from here would be heard by nobody.
 *
 * `on` and `once` are the event stream with a filter on it, so each costs a subscription and each
 * returns one you can close. `once` closes itself after the first matching signal.
 */
export interface SignalsApi {
  emit(name: string, value?: unknown): Promise<void>;
  on(name: string, handler: (signal: SignalMessage) => void): Promise<Subscription>;
  once(name: string, handler: (signal: SignalMessage) => void): Promise<Subscription>;
}

export interface EventsApi {
  subscribe(
    handler: (event: PluginEvent) => void,
    options?: SubscribeOptions,
  ): Promise<Subscription>;
}

export interface PluginHooks {
  activate?(ctx: PluginContext): unknown | Promise<unknown>;
  deactivate?(): unknown | Promise<unknown>;
  /**
   * A user acted on one of your panels.
   *
   * The host is *waiting on this frame* with a deadline, so answer promptly and push the resulting
   * tree separately with `ctx.call("ui.setPanel", …)`. Returning only when the redraw is done would
   * make every slow update look like a plugin that stopped responding.
   */
  onIntent?(dispatch: UiIntentDispatch, ctx: PluginContext): unknown | Promise<unknown>;
  /**
   * One of your contributed commands was run from the command palette.
   *
   * Reachable whether or not you are drawing a panel, which is why it is its own hook rather than
   * an intent: a command belongs to the plugin, not to a surface.
   */
  onCommand?(commandId: string, ctx: PluginContext): unknown | Promise<unknown>;
  /**
   * A graph armed one of your trigger node types.
   *
   * A trigger **arms, it does not execute**: hold whatever subscription you need and call
   * `ctx.nodes.fire(instanceId, outputs)` when the world does something. Returning from this hook
   * means "armed", not "fired".
   */
  onNodeArm?(
    instance: { instanceId: string; nodeId: string; config: NodeConfigValues },
    ctx: PluginContext,
  ): unknown | Promise<unknown>;
  /** A graph disarmed a trigger instance. Drop whatever `onNodeArm` set up. */
  onNodeDisarm?(instance: { instanceId: string }, ctx: PluginContext): unknown | Promise<unknown>;
  /**
   * A graph reached one of your action or condition nodes.
   *
   * Return the node's outputs, keyed by output port id. A condition returns its verdict the same
   * way — there is no separate shape for one, because the graph reads an output either way.
   */
  onNodeExecute?(
    call: { nodeId: string; inputs: PortValues; config: NodeConfigValues },
    ctx: PluginContext,
  ): unknown | Promise<unknown>;
}

/** The one `onFrame` slot means one runtime. Tracked so a second `definePlugin` can say so. */
let runtime: Runtime | null = null;

class Runtime {
  readonly #host: HostSeam;
  readonly #hooks: PluginHooks;
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Map<
    string,
    { handler: (event: PluginEvent) => void; onDropped: SubscribeOptions["onDropped"] }
  >();
  #nextId = 1;
  readonly ctx: PluginContext;

  constructor(host: HostSeam, hooks: PluginHooks) {
    this.#host = host;
    this.#hooks = hooks;
    this.ctx = this.#buildContext();
    host.onFrame((frame) => {
      this.#handle(frame);
    });
  }

  #id(prefix: string): string {
    const id = `${prefix}${this.#nextId}`;
    this.#nextId += 1;
    return id;
  }

  #deadline(timeoutMs: number): Deadline {
    return Date.now() + timeoutMs;
  }

  /**
   * Sends a frame that expects an answer on the same id.
   *
   * The local timer is not the authority — the host enforces its own deadline and will answer
   * `E_TIMEOUT` — it is what stops a promise hanging forever if the host goes away mid-call, which
   * is a thing that happens when the daemon shuts down while a plugin is mid-await.
   */
  #request(frame: Record<string, unknown>, id: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#host.send(frame)) {
        reject(new Error("The host refused the frame. It may be too large."));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new PluginCallError({
            code: "E_TIMEOUT",
            message: "The host did not answer before the deadline.",
          }),
        );
      }, timeoutMs);
      // Node and Bun both allow a pending timer to hold the process open. A plugin waiting on the
      // host should not be the reason its own process refuses to exit.
      (timer as { unref?: () => void }).unref?.();
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  #settle(id: string, ok: boolean, value: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return; // A late answer to a call we already gave up on.
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(value);
    else pending.reject(new PluginCallError(value as ErrorPayload));
  }

  #handle(frame: Record<string, unknown>): void {
    switch (frame.t) {
      case "res":
        this.#settle(String(frame.id), true, frame.result);
        return;
      case "err":
        this.#settle(String(frame.id), false, frame.error);
        return;
      case "event":
        this.#deliver(frame);
        return;
      case "dropped": {
        const entry = this.#subscriptions.get(String(frame.sub));
        entry?.onDropped?.({
          count: Number(frame.count),
          reason: String(frame.reason),
          seq: Number(frame.seq),
        });
        return;
      }
      case "lifecycle":
        void this.#lifecycle(frame);
        return;
      case "req":
        // The host calling *us*. `req` is bidirectional in the protocol, and without this branch
        // every `ui.intent` would sit unanswered until its deadline — which reads to the host as a
        // plugin that has stopped responding rather than one that never learned to listen.
        void this.#hostCall(frame);
        return;
      default:
        // A frame this protocol major does not know is ignored rather than fatal: the host is
        // entitled to grow tags, and a plugin that dies on an unfamiliar one would make every such
        // addition a breaking change.
        return;
    }
  }

  /**
   * Delivers a batch, then returns credit for exactly what was delivered.
   *
   * Credit is returned **after** the handlers run rather than on arrival. That is what makes the
   * host's credit window mean "events this plugin has actually processed" instead of "events it
   * received", which is the difference between backpressure and a counter.
   *
   * A handler that throws does not cost the batch: the remaining events are still delivered and the
   * credit is still returned. A plugin whose handler throws on every event would otherwise stall
   * its own subscription and look like a host bug.
   */
  #deliver(frame: Record<string, unknown>): void {
    const sub = String(frame.sub);
    const entry = this.#subscriptions.get(sub);
    const events = Array.isArray(frame.events) ? (frame.events as PluginEvent[]) : [];
    if (entry === undefined || events.length === 0) return;

    for (const event of events) {
      try {
        entry.handler(event);
      } catch (error) {
        this.#host.log(`an event handler threw: ${String(error)}`);
      }
    }
    this.#host.send({ t: "credit", sub, credits: Math.min(events.length, MAX_CREDITS) });
  }

  /**
   * Answers a call the host made on this plugin.
   *
   * One method today. An unknown one is answered `E_UNKNOWN_METHOD` rather than ignored, because
   * silence and refusal are the same observation to a caller with a deadline, and only one of them
   * tells the host that this plugin is a version that does not speak it.
   */
  async #hostCall(frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id);
    if (frame.method === "ui.command") {
      const commandId = String((frame.params as { commandId?: unknown })?.commandId ?? "");
      await this.#answer(id, this.#hooks.onCommand, (hook) =>
        hook.call(this.#hooks, commandId, this.ctx),
      );
      return;
    }
    if (frame.method === "nodes.arm") {
      await this.#answer(id, this.#hooks.onNodeArm, (hook) =>
        hook.call(this.#hooks, frame.params as never, this.ctx),
      );
      return;
    }
    if (frame.method === "nodes.disarm") {
      await this.#answer(id, this.#hooks.onNodeDisarm, (hook) =>
        hook.call(this.#hooks, frame.params as never, this.ctx),
      );
      return;
    }
    if (frame.method === "nodes.execute") {
      await this.#answer(id, this.#hooks.onNodeExecute, (hook) =>
        hook.call(this.#hooks, frame.params as never, this.ctx),
      );
      return;
    }
    if (frame.method !== "ui.intent") {
      this.#host.send({
        t: "err",
        id,
        error: {
          code: "E_UNKNOWN_METHOD",
          message: `This plugin does not answer ${String(frame.method)}.`,
        },
      });
      return;
    }
    await this.#answer(id, this.#hooks.onIntent, (hook) =>
      hook.call(this.#hooks, frame.params as unknown as UiIntentDispatch, this.ctx),
    );
  }

  /**
   * Runs one hook and answers the frame, whatever happens.
   *
   * Shared between the two host-called hooks because the *answering* is the part that matters: a
   * missing hook and a throwing hook are both answered as errors, since silence and refusal are the
   * same observation to a caller with a deadline and only one of them is diagnosable.
   */
  async #answer<Hook>(
    id: string,
    hook: Hook | undefined,
    run: (hook: Hook) => unknown,
  ): Promise<void> {
    if (hook === undefined) {
      this.#host.send({
        t: "err",
        id,
        error: {
          code: "E_UNKNOWN_METHOD",
          message: "This plugin does not define a hook for that.",
        },
      });
      return;
    }
    try {
      const result = await run(hook);
      this.#host.send({ t: "res", id, result: result === undefined ? null : result });
    } catch (error) {
      this.#host.send({
        t: "err",
        id,
        error: { code: "E_INTERNAL", message: String((error as Error)?.message ?? error) },
      });
    }
  }

  async #lifecycle(frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id);
    const hook = frame.phase === "activate" ? this.#hooks.activate : this.#hooks.deactivate;
    try {
      const result = hook === undefined ? null : await hook.call(this.#hooks, this.ctx);
      this.#host.send({ t: "res", id, result: result === undefined ? null : result });
    } catch (error) {
      // The host is waiting on this id with an activation deadline. An error answered as an error
      // is a plugin that failed to start; an error swallowed here is a plugin that hangs, and the
      // supervisor cannot tell the second from a spin loop.
      this.#host.send({
        t: "err",
        id,
        error: { code: "E_INTERNAL", message: String((error as Error)?.message ?? error) },
      });
    }
  }

  #call(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const id = this.#id("c");
    return this.#request(
      {
        t: "req",
        id,
        method,
        deadline: this.#deadline(timeoutMs),
        ...(params === undefined ? {} : { params }),
      },
      id,
      timeoutMs,
    );
  }

  #buildContext(): PluginContext {
    const call = (method: string, params?: unknown, timeoutMs?: number): Promise<unknown> =>
      this.#call(method, params, timeoutMs);

    /** Convenience over `ui.*`, so a plugin never hand-writes a frame for its own surface. */
    const ui: UiApi = {
      setPanel: async (panelId, tree) => {
        await call("ui.setPanel", { panelId, tree });
      },
      patchPanel: async (panelId, key, tree) => {
        await call("ui.patchPanel", { panelId, key, tree });
      },
      closePanel: async (panelId) => {
        await call("ui.closePanel", { panelId });
      },
      toast: async (message, options = {}) => {
        await call("ui.toast", {
          message,
          ...(options.description === undefined ? {} : { description: options.description }),
          tone: options.tone ?? "neutral",
        });
      },
    };

    const nodes: NodesApi = {
      register: async (definition) => {
        await call("nodes.register", { definition });
      },
      fire: async (instanceId, outputs = {}) => {
        await call("nodes.fire", { instanceId, outputs });
      },
    };

    const storage: StorageApi = {
      kv: {
        get: (key) => call("storage.kv.get", { key }),
        set: async (key, value) => {
          await call("storage.kv.set", { key, value });
        },
        delete: async (key) =>
          ((await call("storage.kv.delete", { key })) as { deleted: boolean }).deleted,
        keys: async (prefix = "", limit) =>
          (await call("storage.kv.keys", {
            prefix,
            ...(limit === undefined ? {} : { limit }),
          })) as string[],
      },
      records: {
        append: async (key, value) =>
          (await call("storage.records.append", { key, value })) as { id: number; ts: number },
        query: async (options = {}) =>
          (await call("storage.records.query", options)) as StorageRecord[],
        delete: async (options) =>
          ((await call("storage.records.delete", options)) as { deleted: number }).deleted,
      },
      usage: async () => (await call("storage.usage")) as StorageUsage,
    };

    const vrchat: VrchatApi = {
      accounts: { list: () => call("vrchat.accounts.list") },
      friends: { list: (params = {}) => call("vrchat.friends.list", params) },
      users: { get: (params) => call("vrchat.users.get", params) },
      worlds: { get: (params) => call("vrchat.worlds.get", params) },
      instances: { get: (params) => call("vrchat.instances.get", params) },
      groups: { get: (params) => call("vrchat.groups.get", params) },
    };

    /** `{store}` is omitted rather than sent empty, so the host's own default applies. */
    const at = (store: string | undefined): { store?: string } =>
      store === undefined || store === "" ? {} : { store };

    const data: DataApi = {
      get: (key, store) => call("data.get", { key, ...at(store) }),
      set: async (key, value, store) => {
        await call("data.set", { key, value, ...at(store) });
      },
      delete: async (key, store) => (await call("data.delete", { key, ...at(store) })) === true,
      map: {
        get: (name, key, store) => call("data.map.get", { name, key, ...at(store) }),
        set: async (name, key, value, store) => {
          await call("data.map.set", { name, key, value, ...at(store) });
        },
        delete: async (name, key, store) =>
          (await call("data.map.delete", { name, key, ...at(store) })) === true,
        entries: async (name, store) =>
          (await call("data.map.entries", { name, ...at(store) })) as {
            key: string;
            value: unknown;
          }[],
        clear: async (name, store) => {
          await call("data.clear", { kind: "map", name, ...at(store) });
        },
      },
      /*
       * `set_`, with the underscore, because `set` is already this object's own method for writing a
       * plain value — `data.set("k", v)` and `data.set.add(…)` cannot both be one property. The
       * alternative was renaming the plain write, which would make the common case the odd one out.
       */
      set_: {
        add: async (name, item, store) =>
          (await call("data.set.add", { name, item, ...at(store) })) === true,
        has: async (name, item, store) =>
          (await call("data.set.has", { name, item, ...at(store) })) === true,
        delete: async (name, item, store) =>
          (await call("data.set.delete", { name, item, ...at(store) })) === true,
        items: async (name, store) =>
          (await call("data.set.items", { name, ...at(store) })) as unknown[],
        clear: async (name, store) => {
          await call("data.clear", { kind: "set", name, ...at(store) });
        },
      },
      list: {
        add: async (name, item, options = {}) =>
          (await call("data.list.add", {
            name,
            item,
            ...(options.max === undefined ? {} : { max: options.max }),
            ...at(options.store),
          })) as number,
        items: async (name, store) =>
          (await call("data.list.items", { name, ...at(store) })) as unknown[],
        remove: async (name, item, store) =>
          (await call("data.list.remove", { name, item, ...at(store) })) as number,
        clear: async (name, store) => {
          await call("data.clear", { kind: "list", name, ...at(store) });
        },
      },
    };

    /** A `graph.signal` event as the shape a listener asked for. Null when it is not one. */
    const readSignal = (event: PluginEvent): SignalMessage | null => {
      const payload = event.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
      const record = payload as Record<string, unknown>;
      const name = record.name;
      if (typeof name !== "string") return null;
      return {
        name,
        value: record.value ?? null,
        from: typeof record.graphId === "string" ? record.graphId : "",
        at: event.ts,
      };
    };

    const events: EventsApi = {
      subscribe: async (handler, options = {}) => {
        const overflow = options.delivery?.overflow ?? "drop-oldest";
        const keyPath = options.delivery?.keyPath;
        // Refused here rather than sent, because the host accepts it and quietly behaves as
        // drop-oldest — an author would get working code that does not do what they asked.
        if (overflow === "coalesce" && keyPath === undefined) {
          throw new Error(
            'overflow: "coalesce" needs a keyPath naming what an event is about, such as "userId". Without one there is nothing to coalesce on.',
          );
        }
        const delivery: DeliveryPolicy = {
          credits: options.delivery?.credits ?? 256,
          maxBatch: options.delivery?.maxBatch ?? 32,
          overflow,
          ...(keyPath === undefined ? {} : { keyPath }),
        };

        const sub = this.#id("s");
        const id = this.#id("c");
        this.#subscriptions.set(sub, { handler, onDropped: options.onDropped });
        try {
          await this.#request(
            {
              t: "subscribe",
              id,
              deadline: this.#deadline(DEFAULT_CALL_TIMEOUT_MS),
              sub,
              filter: options.filter ?? {},
              delivery,
            },
            id,
            DEFAULT_CALL_TIMEOUT_MS,
          );
        } catch (error) {
          // Registered before sending so no event can arrive before the map has a handler; removed
          // again if the host refused, so a failed subscribe leaves nothing behind.
          this.#subscriptions.delete(sub);
          throw error;
        }
        return {
          id: sub,
          close: async () => {
            this.#subscriptions.delete(sub);
            const closeId = this.#id("c");
            await this.#request(
              {
                t: "unsubscribe",
                id: closeId,
                deadline: this.#deadline(DEFAULT_CALL_TIMEOUT_MS),
                sub,
              },
              closeId,
              DEFAULT_CALL_TIMEOUT_MS,
            );
          },
        };
      },
    };

    const signals: SignalsApi = {
      emit: async (name, value = null) => {
        await call("signals.emit", { name, value });
      },
      on: async (name, handler) =>
        await events.subscribe(
          (event) => {
            const signal = readSignal(event);
            // The name is matched here rather than in the filter: the filter is a *kind* pattern and
            // every signal shares one kind, so filtering by name there would mean one bus
            // subscription per name for no gain.
            if (signal !== null && signal.name === name) handler(signal);
          },
          { filter: { kinds: ["graph.signal"] } },
        ),
      once: async (name, handler) => {
        let taken = false;
        /*
         * The subscription closes itself, and the two variables are why this is not one line.
         *
         * A signal can arrive *before* `subscribe` resolves — the handler is registered before the
         * frame is sent, precisely so nothing is missed in that window — so the handler cannot
         * assume `subscription` is assigned yet. `armed` records "close as soon as there is
         * something to close", and the line after the await honours it.
         */
        let subscription: Subscription | null = null;
        let armed = false;
        const closeOnce = (): void => {
          if (subscription === null) armed = true;
          else void subscription.close();
        };
        subscription = await events.subscribe(
          (event) => {
            const signal = readSignal(event);
            if (signal === null || signal.name !== name || taken) return;
            taken = true;
            closeOnce();
            handler(signal);
          },
          { filter: { kinds: ["graph.signal"] } },
        );
        if (armed) await subscription.close();
        return subscription;
      },
    };

    return {
      pluginId: this.#host.pluginId,
      log: (message) => {
        this.#host.log(message);
      },
      call,
      vrchat,
      storage,
      data,
      signals,
      events,
      ui,
      nodes,
    };
  }
}

/**
 * Registers a plugin's lifecycle hooks and returns nothing.
 *
 * Call it at module scope. The host sends `lifecycle: activate` once the process is up, and
 * whatever `activate` returns is answered on that frame — so a plugin that throws from `activate`
 * is reported as a failed activation rather than as a hang.
 *
 * ```ts
 * import { definePlugin } from "@vrcz/plugin-api/runtime";
 *
 * definePlugin({
 *   async activate(ctx) {
 *     const seen = await ctx.storage.kv.get("last-seen");
 *     await ctx.events.subscribe((event) => ctx.log(event.kind), {
 *       filter: { kinds: ["friend.online"] },
 *     });
 *   },
 * });
 * ```
 */
export function definePlugin(hooks: PluginHooks): void {
  if (runtime !== null) {
    throw new Error(
      "definePlugin was called twice. A plugin has one set of lifecycle hooks, because the host seam has one frame handler.",
    );
  }
  runtime = new Runtime(seam(), hooks);
}

/**
 * The context outside a lifecycle hook, for module-scope code that needs it.
 *
 * `activate(ctx)` is the ordinary way to get one. This exists for the plugin that wants to build
 * something at module scope, and it throws before `definePlugin` because there is no host
 * connection to hand out until then.
 */
export function getContext(): PluginContext {
  if (runtime === null) {
    throw new Error("getContext() was called before definePlugin().");
  }
  return runtime.ctx;
}

/** Test seam: forgets the singleton. Never call this from a plugin. */
export function __resetRuntimeForTests(): void {
  runtime = null;
}
