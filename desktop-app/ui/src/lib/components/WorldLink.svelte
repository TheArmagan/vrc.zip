<!--
  A VRChat world, everywhere one is named.

  The counterpart of `UserName`, and it exists for the same three reasons.

  It **degrades**: a location without a world id — `private`, `traveling`, an empty presence string
  — has nothing to open, so this renders plain text with no underline, no button and no dead click.
  It never invents an id from a name.

  It is a real `<button>` when it is interactive, because a `<span onclick>` is invisible to the
  keyboard and announced as text, and this is about to be the second most repeated control in the
  app.

  And layout stays the caller's business. The base class carries no width and no truncation: these
  sit inside truncating flex rows, so a caller that needs clipping passes `class="min-w-0 truncate"`
  and gets it on the button itself, which is where `text-overflow` can actually apply. A very long
  world name therefore clips at the row's edge and stays readable in full in the tooltip.

  The name itself comes from `worldNames`, which batches: twenty rows naming the same world produce
  one entry in one request, not twenty requests. Until it lands — and permanently, for a world
  VRChat no longer has — the label falls back to the short id, exactly as `LocationLine` always did.
-->
<script lang="ts">
import { untrack } from "svelte";
import { imageUrl } from "$lib/api.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { shortId } from "$lib/format.ts";
import { worldModal } from "$lib/state/world-modal.svelte.ts";
import { worldNames } from "$lib/state/world-names.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  worldId = null,
  name = null,
  location = null,
  accountId = null,
  class: className,
}: {
  worldId?: string | null;
  /**
   * A name the caller already had — in practice the game log's `Entering Room:` line, which is the
   * only source of world names anywhere outside a fetch. It wins over the resolver's: it describes
   * the world this row actually saw, and it is on screen with no request at all.
   */
  name?: string | null;
  /** The full location string, when the caller had one. It is what gives the modal its instance. */
  location?: string | null;
  /** The account this was seen through; it decides whose credentials the lookup spends. */
  accountId?: string | null;
  class?: string;
} = $props();

/*
 * The one place a request starts, and it is an `$effect` rather than a call in the template so that
 * reading the name stays pure. `ensure` is idempotent, deduplicated in flight, and coalesced into a
 * single batched request per tick, so twenty of these mounting together is one lookup.
 */
$effect(() => {
  // The props are the dependencies; `untrack` keeps the cache lookup *inside* `ensure` from
  // becoming one. Without it the effect would re-run every time this world's own entry changed —
  // harmless, since `ensure` returns early once a name is held, but it is pointless work and the
  // kind of loop that stops being harmless the moment someone adds a write to the early path.
  const id = worldId;
  const account = accountId;
  untrack(() => {
    worldNames.ensure(id, account);
  });
});

const summary = $derived(worldNames.get(worldId));
const status = $derived(worldNames.status(worldId));

/** The name if anyone has one, otherwise the short id — never an empty label. */
const label = $derived(name ?? summary?.name ?? shortId(worldId, 14));

const INTERACTIVE =
  "cursor-pointer rounded-xs underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

function open(event: MouseEvent): void {
  if (worldId === null) return;
  // Locations live inside rows that are themselves clickable in places. Opening the world is the
  // whole intent of the click, so it stops here.
  event.stopPropagation();
  worldModal.openWorld(worldId, { location, accountId, name: name ?? summary?.name ?? null });
}
</script>

{#if worldId === null || worldId === ""}
  <span class={className}>{label}</span>
{:else}
  <Tooltip.Provider delayDuration={250}>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class={cn(INTERACTIVE, className)} onclick={open}>
            {label}
          </button>
        {/snippet}
      </Tooltip.Trigger>

      <Tooltip.Content class="max-w-xs flex-col items-stretch gap-2 p-0">
        {#if summary?.thumbnailImageUrl}
          <!--
            Through the image proxy, never a direct `<img src>`: VRChat's image host wants the
            account's auth cookie and a User-Agent the browser may not set, and answers a bare
            request with 401/403. See `imageUrl` in `api.ts`.
          -->
          <img
            src={imageUrl(summary.thumbnailImageUrl)}
            alt=""
            loading="lazy"
            class="h-24 w-full rounded-t-2xl object-cover"
          />
        {/if}

        <div class="space-y-1 px-3 pt-1 pb-2">
          <p class="font-medium">{summary?.name ?? label}</p>

          {#if summary !== null}
            <p class="opacity-80">
              {#if summary.authorName}by {summary.authorName}{/if}
              {#if summary.authorName && summary.capacity !== null}
                <span aria-hidden="true"> · </span>
              {/if}
              {#if summary.capacity !== null}holds {summary.capacity}{/if}
            </p>
          {:else if status === "loading"}
            <p class="opacity-80">Looking this world up…</p>
          {:else if status === "unresolved"}
            <!--
              Two causes, and the tooltip must not pick one: the world is genuinely gone, or no
              account was signed in when the batch ran and the daemon answered from cache alone.
            -->
            <p class="opacity-80">
              No name for this world. It may have been deleted, or no signed-in account was
              available to ask VRChat through.
            </p>
          {:else if status === "failed"}
            <p class="opacity-80">The daemon could not be reached for this world's name.</p>
          {/if}

          <p class="font-mono text-[10px] opacity-60">{worldId}</p>
          <p class="opacity-60">Click for the full world</p>
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
