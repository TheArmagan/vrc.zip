<!--
  Retention — the one control on Settings that deletes things.

  Two decisions shape this screen. First, **nothing is written until Save**: every edit re-runs a
  dry run against the daemon and the answer is rendered as a row count, because a retention window
  is an abstraction right up until it is "4,182 events go away". Second, the **inherited windows are
  visible**, tagged with where they came from, so a number nobody set is never mistaken for a number
  somebody set — otherwise the first thing a user does is edit the wrong row.

  Only `events` are ever pruned. Notes, friend history, the avatar log and the user cache are
  excluded in the daemon (`NEVER_DELETED_TABLES`) and this screen says so rather than leaving
  someone to wonder whether their notes are on a timer.
-->
<script lang="ts">
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from "@vrcz/shared";
import { toast } from "svelte-sonner";
import {
  api,
  describeError,
  type RetentionSettings,
  type RetentionSource,
  type RetentionUpdate,
} from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { eventLabel, timeAgo } from "$lib/format.ts";
import { clock } from "$lib/state/clock.svelte.ts";

let loaded = $state<RetentionSettings | null>(null);
/** The dry run for the edits in hand, or null while nothing is edited. */
let preview = $state<RetentionSettings | null>(null);
let error = $state<string | null>(null);
let busy = $state(false);
let trimming = $state(false);

/** Edits in hand, keyed the same way the daemon keys rules. `null` in `rules` means "delete". */
let draftDefault = $state<number | null>(null);
const draftRules = $state<Record<string, number | null>>({});

/** What the screen renders: the preview when there is one, otherwise what is stored. */
const shown = $derived(preview ?? loaded);

const dirty = $derived(draftDefault !== null || Object.keys(draftRules).length > 0);

const SOURCE_LABEL: Record<RetentionSource, string> = {
  exact: "set for this kind",
  prefix: "from a family rule",
  default: "the default",
  fallback: "built-in fallback",
};

async function load(): Promise<void> {
  error = null;
  try {
    loaded = await api.retention.get();
  } catch (cause) {
    error = describeError(cause);
  }
}

$effect(() => {
  void load();
});

/**
 * The patch as it currently stands. Built fresh from the drafts rather than accumulated, so
 * clearing a field really does drop it out of the request rather than leaving a stale entry behind.
 */
function patch(): RetentionUpdate {
  return {
    ...(draftDefault !== null ? { defaultRetainDays: draftDefault } : {}),
    ...(Object.keys(draftRules).length > 0 ? { rules: { ...draftRules } } : {}),
  };
}

/*
 * The dry run, debounced.
 *
 * Debounced rather than run per keystroke because typing "365" passes through 3 and 36, and 3 is a
 * number that would flash "12,904 events go away" at someone mid-type. 400ms is long enough that
 * the count only appears once the number has stopped moving.
 */
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePreview(): void {
  if (previewTimer !== null) clearTimeout(previewTimer);
  if (!dirty) {
    preview = null;
    return;
  }
  previewTimer = setTimeout(() => {
    void runPreview();
  }, 400);
}

async function runPreview(): Promise<void> {
  try {
    preview = await api.retention.update({ ...patch(), dryRun: true });
    error = null;
  } catch (cause) {
    error = describeError(cause);
  }
}

function editDefault(value: string): void {
  const parsed = Number.parseInt(value, 10);
  draftDefault =
    Number.isSafeInteger(parsed) && parsed >= RETENTION_MIN_DAYS && parsed <= RETENTION_MAX_DAYS
      ? parsed
      : null;
  schedulePreview();
}

function editRule(kind: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed === "") {
    // An emptied field means "stop overriding this kind", which is a delete rather than a zero.
    draftRules[kind] = null;
  } else {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < RETENTION_MIN_DAYS || parsed > RETENTION_MAX_DAYS)
      return;
    draftRules[kind] = parsed;
  }
  schedulePreview();
}

function discard(): void {
  draftDefault = null;
  for (const key of Object.keys(draftRules)) delete draftRules[key];
  preview = null;
  error = null;
}

async function apply(): Promise<void> {
  if (!dirty || busy) return;
  busy = true;
  error = null;
  try {
    loaded = await api.retention.update(patch());
    discard();
    toast.success("Retention saved", {
      description: "The next nightly pass uses these windows.",
    });
  } catch (cause) {
    error = describeError(cause);
  } finally {
    busy = false;
  }
}

async function trimNow(): Promise<void> {
  if (trimming) return;
  trimming = true;
  error = null;
  try {
    const result = await api.retention.run();
    loaded = result.settings;
    discard();
    toast.success(
      result.totalDeleted === 0
        ? "Nothing to trim"
        : `Trimmed ${result.totalDeleted.toLocaleString()} events`,
      { description: "Daily counts were kept; the individual rows were not." },
    );
  } catch (cause) {
    error = describeError(cause);
  } finally {
    trimming = false;
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * What the field for one kind shows.
 *
 * Empty when nothing is set for that kind specifically — the placeholder then carries the inherited
 * window, so the field reads "you have not set this, and here is what it would be" rather than
 * pre-filling a number the user never chose and would then be editing by accident. An unsaved edit
 * wins over both, and an unsaved *deletion* (`null`) empties the field again.
 */
function fieldValue(stat: { kind: string; retainDays: number; source: RetentionSource }): string {
  const draft = draftRules[stat.kind];
  if (draft !== undefined) return draft === null ? "" : String(draft);
  return stat.source === "exact" ? String(stat.retainDays) : "";
}
</script>

<section class="space-y-3">
  <div>
    <h2 class="text-base font-semibold">History</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      How long the daemon keeps each kind of event. Expiring events are folded into daily counts
      first, so the shape of your history survives even when the individual rows do not. Notes,
      friend history, the avatar log and the user cache are never deleted.
    </p>
  </div>

  {#if error}
    <ErrorNote message={error} />
  {/if}

  {#if shown === null}
    <p class="text-sm text-muted-foreground">Reading retention settings…</p>
  {:else}
    <div class="space-y-4 border border-border p-4">
      <div class="flex flex-wrap items-end gap-4">
        <div class="space-y-1.5">
          <Label for="retention-default">Default window</Label>
          <div class="flex items-center gap-2">
            <Input
              id="retention-default"
              type="number"
              min={RETENTION_MIN_DAYS}
              max={RETENTION_MAX_DAYS}
              class="w-28 tabular"
              value={draftDefault ?? shown.defaultRetainDays}
              oninput={(event) => editDefault(event.currentTarget.value)}
            />
            <span class="text-sm text-muted-foreground">days</span>
          </div>
        </div>

        <dl class="flex flex-wrap gap-6 text-sm">
          <div>
            <dt class="text-muted-foreground">Database</dt>
            <dd class="tabular">{megabytes(shown.dbSizeBytes)}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Last pass</dt>
            <dd class="tabular">
              {shown.lastRunAt === null ? "never" : timeAgo(shown.lastRunAt, clock.now)}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Next pass</dt>
            <dd class="tabular">
              {shown.nextRunAt === null ? "not scheduled" : timeAgo(shown.nextRunAt, clock.now)}
            </dd>
          </div>
        </dl>
      </div>

      {#if shown.kinds.length === 0}
        <p class="text-sm text-muted-foreground">
          Nothing is stored yet, so there is nothing to age out. Windows above still apply once
          events start arriving.
        </p>
      {:else}
        <!--
          Scrolls inside its own box rather than growing the page: this list is one row per event
          kind the daemon has ever recorded, which on a busy install is dozens.
        -->
        <div class="max-h-96 overflow-y-auto border border-border">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-background">
              <tr class="border-b border-border text-left text-xs text-muted-foreground">
                <th class="px-3 py-2 font-medium">Event</th>
                <th class="px-3 py-2 font-medium">Keep for</th>
                <th class="px-3 py-2 text-right font-medium">Stored</th>
                <th class="px-3 py-2 text-right font-medium">Expiring</th>
              </tr>
            </thead>
            <tbody>
              {#each shown.kinds as stat (stat.kind)}
                <tr class="border-b border-border last:border-0">
                  <td class="px-3 py-2">
                    <div>{eventLabel(stat.kind)}</div>
                    <div class="font-mono text-xs text-muted-foreground">{stat.kind}</div>
                  </td>
                  <td class="px-3 py-2">
                    <div class="flex items-center gap-2">
                      <Input
                        type="number"
                        min={RETENTION_MIN_DAYS}
                        max={RETENTION_MAX_DAYS}
                        class="w-24 tabular"
                        placeholder={String(stat.retainDays)}
                        value={fieldValue(stat)}
                        oninput={(event) => editRule(stat.kind, event.currentTarget.value)}
                      />
                      <Badge variant="secondary" class="whitespace-nowrap"
                        >{SOURCE_LABEL[stat.source]}</Badge
                      >
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right tabular">{stat.rows.toLocaleString()}</td>
                  <td
                    class="px-3 py-2 text-right tabular {stat.expiring > 0
                      ? 'text-warning'
                      : 'text-muted-foreground'}"
                  >
                    {stat.expiring.toLocaleString()}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <Alert.Root variant={shown.totalExpiring > 0 ? "destructive" : "default"}>
        <Alert.Description>
          {#if shown.preview}
            With these windows, the next pass would delete
            <strong class="tabular">{shown.totalExpiring.toLocaleString()}</strong> events. Nothing
            has been saved yet.
          {:else if shown.totalExpiring > 0}
            The next pass will delete
            <strong class="tabular">{shown.totalExpiring.toLocaleString()}</strong> events.
          {:else}
            Nothing is old enough to expire under the current windows.
          {/if}
        </Alert.Description>
      </Alert.Root>

      <div class="flex flex-wrap items-center gap-2">
        <Button onclick={apply} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save windows"}
        </Button>
        <Button variant="ghost" onclick={discard} disabled={!dirty || busy}>Discard</Button>
        <Button variant="outline" class="ml-auto" onclick={trimNow} disabled={trimming || dirty}>
          {trimming ? "Trimming…" : "Trim now"}
        </Button>
      </div>
      {#if dirty}
        <p class="text-xs text-muted-foreground">
          Save or discard before trimming, so the pass runs against windows you have seen the effect
          of.
        </p>
      {/if}
    </div>
  {/if}
</section>
