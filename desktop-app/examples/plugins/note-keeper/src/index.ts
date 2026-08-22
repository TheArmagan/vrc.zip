/**
 * Storage: a private SQLite file that is yours alone.
 *
 * ## Two halves, and they are not interchangeable
 *
 *  - **KV** is last-write-wins by key. Settings, cursors, "what did I last see".
 *  - **`records`** is an append-only log of `(key, ts, value)`. Observations, history — anything
 *    where the second write must not replace the first.
 *
 * ## The query is deliberately narrow
 *
 * Key prefix, time window, limit. There is no filtering on fields inside your JSON, because one
 * index covers every legal query and no call shape can degrade into a table scan the *user*
 * experiences. Structure your keys the way you would structure a path — `note/usr_abc` — and the
 * prefix is your index.
 *
 * ## You prune, not the host
 *
 * The host cannot know which of your records mattered. `E_QUOTA` is non-retryable for that reason:
 * waiting does not help, deleting does.
 */

import { definePlugin, PluginCallError } from "@vrcz/plugin-api/runtime";

const NOTE_PREFIX = "note/";

async function panel(ctx: PluginCtx) {
  const notes = await ctx.storage.records.query({ prefix: NOTE_PREFIX, limit: 100 });
  const usage = await ctx.storage.usage();
  const draft = (await ctx.storage.kv.get("draft")) ?? "";

  return {
    type: "card",
    title: "Notes",
    description: `${Math.round(usage.bytes / 1024)} KB of ${Math.round(usage.quotaBytes / 1_048_576)} MB used`,
    children: [
      {
        type: "form",
        submitLabel: "Add note",
        onSubmit: { name: "add" },
        children: [
          {
            type: "field",
            label: "Note",
            control: { type: "input", name: "text", value: String(draft), placeholder: "Anything" },
          },
        ],
      },
      notes.length === 0
        ? { type: "empty", key: "list", title: "No notes yet" }
        : {
            type: "table",
            key: "list",
            rowKey: "id",
            columns: [
              { id: "ts", header: "When", cell: "timestamp", sortable: true },
              { id: "text", header: "Note" },
            ],
            rows: notes.map((note) => ({
              id: String(note.id),
              ts: note.ts,
              text: String(note.value),
            })),
          },
    ],
  };
}

interface PluginCtx {
  storage: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
    };
    records: {
      append(key: string, value: unknown): Promise<{ id: number; ts: number }>;
      query(options: { prefix?: string; limit?: number }): Promise<
        { id: number; ts: number; value: unknown }[]
      >;
      delete(options: { prefix?: string; before?: number }): Promise<number>;
    };
    usage(): Promise<{ bytes: number; quotaBytes: number }>;
  };
  ui: {
    setPanel(id: string, tree: unknown): Promise<void>;
    toast(message: string, options?: { tone?: string; description?: string }): Promise<void>;
  };
}

definePlugin({
  async activate(ctx) {
    await ctx.ui.setPanel("notes", await panel(ctx as unknown as PluginCtx));
  },

  async onIntent(dispatch, ctx) {
    const typed = ctx as unknown as PluginCtx;
    if (dispatch.intent.name !== "add") return;

    // `formState` carries every named control in the enclosing form, so a submit needs no round
    // trip per keystroke.
    const text = String(dispatch.formState.text ?? "").trim();
    if (text === "") {
      await typed.ui.toast("Nothing to add", { tone: "warn" });
      return;
    }

    try {
      await typed.storage.records.append(`${NOTE_PREFIX}${Date.now()}`, text);
      // The draft is a *setting*, not history: last write wins, so it goes in KV.
      await typed.storage.kv.set("draft", "");
    } catch (error) {
      // The one error worth handling by name here. Deleting is the fix; retrying is not.
      if (error instanceof PluginCallError && error.code === "E_QUOTA") {
        await typed.ui.toast("Out of space", {
          tone: "danger",
          description: "Delete some notes — waiting will not help.",
        });
        return;
      }
      throw error;
    }
    await typed.ui.setPanel("notes", await panel(typed));
  },

  async onCommand(commandId, ctx) {
    const typed = ctx as unknown as PluginCtx;
    if (commandId !== "clear") return;
    // A delete with no bounds at all is refused, so "everything" is spelled out rather than
    // implied by an omission.
    const deleted = await typed.storage.records.delete({ prefix: NOTE_PREFIX });
    await typed.ui.toast(`Deleted ${String(deleted)} notes`);
    await typed.ui.setPanel("notes", await panel(typed));
  },
});
