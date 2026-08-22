<!--
  The command palette (Ctrl+Shift+P), rendered over the registry in `commands.svelte.ts`.

  Written by hand rather than on top of `bits-ui`'s Command, for one reason: the registry
  deliberately *shows* unavailable commands greyed out instead of filtering them away, and a
  filtering combobox has no notion of "listed but not runnable". A command that vanishes is
  indistinguishable from one that never existed, and the user has no way to learn why.
-->
<script lang="ts">
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import SearchIcon from "@lucide/svelte/icons/search";
import {
  type CommandMatch,
  execute,
  formatBinding,
  isCommandEnabled,
  type RegisteredCommand,
  searchCommands,
} from "$lib/commands.svelte.ts";
import * as Dialog from "$lib/components/ui/dialog/index.js";

let { open = $bindable(false) }: { open?: boolean } = $props();

let query = $state("");
let cursor = $state(0);
let input = $state<HTMLInputElement | null>(null);
let listBox = $state<HTMLElement | null>(null);

/*
 * The second half of the palette: a command that needs an argument does not run on Enter, it
 * *becomes* the palette. The list is replaced by one input under the command's own title, and the
 * second Enter runs it with what was typed.
 *
 * A separate mode rather than a second dialog, because the two are one gesture — the reader has
 * not left the palette, they have gone one level into it — and because Escape has to mean "back to
 * the list" here and "close" everywhere else, which two dialogs cannot agree on.
 */
let prompting = $state<RegisteredCommand | null>(null);
let argument = $state("");
/** Set while `initial()` is in flight, so the clipboard read cannot land in a later prompt. */
let promptGeneration = 0;

const argumentError = $derived(
  prompting?.argument?.validate?.(argument) ?? null,
);

const matches = $derived<CommandMatch[]>(searchCommands(query));

/** Groups keep their registry order; the palette does not re-rank whole sections. */
const grouped = $derived.by(() => {
  const buckets = new Map<string, CommandMatch[]>();
  for (const match of matches) {
    const bucket = buckets.get(match.command.group);
    if (bucket === undefined) buckets.set(match.command.group, [match]);
    else bucket.push(match);
  }
  return [...buckets.entries()];
});

/** Flat order, so Up/Down crosses group boundaries the way the eye expects. */
const flat = $derived(grouped.flatMap(([, entries]) => entries));

$effect(() => {
  // Reading `matches` keeps the cursor inside the list as the query narrows it.
  const size = flat.length;
  if (cursor >= size) cursor = Math.max(0, size - 1);
});

$effect(() => {
  if (open) {
    query = "";
    cursor = 0;
    prompting = null;
    argument = "";
    promptGeneration += 1;
    // The dialog mounts its content asynchronously; focus on the next frame or it lands nowhere.
    requestAnimationFrame(() => input?.focus());
  }
});

/**
 * Enters argument mode.
 *
 * `initial()` is usually a clipboard read, which is async and can therefore resolve after the
 * reader has gone back to the list or moved on to a different prompt — hence the generation check.
 * Anything already typed wins over a late prefill; the reader's own keystrokes are never overwritten.
 */
async function prompt(command: RegisteredCommand): Promise<void> {
  const generation = (promptGeneration += 1);
  prompting = command;
  // A query that already parses is the likeliest argument there is: the reader pasted it here.
  argument = command.argument?.validate?.(query.trim()) === null ? query.trim() : "";
  requestAnimationFrame(() => input?.focus());
  const initial = command.argument?.initial;
  if (initial === undefined || argument !== "") return;
  const prefill = await initial();
  if (generation !== promptGeneration || argument !== "") return;
  argument = prefill;
  requestAnimationFrame(() => input?.select());
}

function leavePrompt(): void {
  promptGeneration += 1;
  prompting = null;
  argument = "";
  requestAnimationFrame(() => input?.focus());
}

async function submitArgument(): Promise<void> {
  const command = prompting;
  if (command === null || argumentError !== null) return;
  const value = argument;
  open = false;
  await execute(command, value);
}

function scrollCursorIntoView(): void {
  requestAnimationFrame(() => {
    listBox?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  });
}

function move(delta: number): void {
  if (flat.length === 0) return;
  cursor = (cursor + delta + flat.length) % flat.length;
  scrollCursorIntoView();
}

async function activate(command: RegisteredCommand): Promise<void> {
  if (!isCommandEnabled(command)) return;
  if (command.argument !== undefined) {
    await prompt(command);
    return;
  }
  open = false;
  await execute(command);
}

function onKeydown(event: KeyboardEvent): void {
  if (prompting !== null) {
    // Enter runs it; Escape and a Backspace on an empty box are both "back to the list", which is
    // what makes this feel like one level of a palette rather than a dialog on top of one.
    if (event.key === "Enter") {
      event.preventDefault();
      void submitArgument();
    } else if (event.key === "Escape" || (event.key === "Backspace" && argument === "")) {
      event.preventDefault();
      event.stopPropagation();
      leavePrompt();
    }
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      move(-1);
      break;
    case "Home":
      event.preventDefault();
      cursor = 0;
      scrollCursorIntoView();
      break;
    case "End":
      event.preventDefault();
      cursor = Math.max(0, flat.length - 1);
      scrollCursorIntoView();
      break;
    case "Enter": {
      event.preventDefault();
      const target = flat[cursor]?.command;
      if (target !== undefined) void activate(target);
      break;
    }
    default:
      break;
  }
}

/** Splits a title into matched/unmatched runs so the fuzzy hits can be emphasised. */
function segments(title: string, hits: readonly number[]): { text: string; hit: boolean }[] {
  if (hits.length === 0) return [{ text: title, hit: false }];
  const marked = new Set(hits);
  const out: { text: string; hit: boolean }[] = [];
  for (const [index, char] of [...title].entries()) {
    const hit = marked.has(index);
    const last = out.at(-1);
    if (last !== undefined && last.hit === hit) last.text += char;
    else out.push({ text: char, hit });
  }
  return out;
}

function indexOfCommand(command: RegisteredCommand): number {
  return flat.findIndex((entry) => entry.command.id === command.id);
}
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="top-[12vh] max-w-2xl translate-y-0 gap-0 overflow-hidden p-0"
    showCloseButton={false}
  >
    <Dialog.Header class="sr-only">
      <Dialog.Title>Command palette</Dialog.Title>
      <Dialog.Description>Search every action in vrc.zip and run it.</Dialog.Description>
    </Dialog.Header>

    {#if prompting !== null}
      <!--
        Argument mode. The command's title stays on screen as a heading rather than being replaced
        by its own placeholder: it is the only thing saying what this box is for, and a reader who
        arrived here from a clipboard prefill has typed nothing at all to remind them.
      -->
      <div class="flex items-center gap-2 border-b border-border px-4 py-2">
        <button
          type="button"
          onclick={leavePrompt}
          class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon class="size-4" />
          Commands
        </button>
        <span class="truncate text-xs text-muted-foreground">/ {prompting.title}</span>
      </div>
      <div class="flex items-center gap-3 px-4">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={input}
          bind:value={argument}
          onkeydown={onKeydown}
          type="text"
          aria-label={prompting.title}
          aria-invalid={argumentError !== null}
          placeholder={prompting.argument?.placeholder ?? ""}
          autocomplete="off"
          spellcheck="false"
          class="h-12 w-full bg-transparent font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
        <kbd class="shrink-0 border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
          Enter
        </kbd>
      </div>
      <div class="border-t border-border px-4 py-3 text-xs">
        {#if argumentError !== null}
          <p class="text-destructive">{argumentError}</p>
        {:else if prompting.argument?.hint}
          <p class="text-muted-foreground">{prompting.argument.hint}</p>
        {:else}
          <p class="text-muted-foreground">Enter runs it. Escape goes back to the list.</p>
        {/if}
      </div>
    {:else}
    <div class="flex items-center gap-3 border-b border-border px-4">
      <SearchIcon class="size-4 shrink-0 text-muted-foreground" />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKeydown}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-autocomplete="list"
        placeholder="Run a command, or paste an id or a link…"
        autocomplete="off"
        spellcheck="false"
        class="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <kbd class="shrink-0 border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
        Esc
      </kbd>
    </div>

    <div
      bind:this={listBox}
      id="command-palette-list"
      role="listbox"
      aria-label="Commands"
      class="max-h-[52vh] overflow-y-auto p-2"
    >
      {#if flat.length === 0}
        <p class="px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing matches "{query}". Commands appear here as screens register them.
        </p>
      {:else}
        {#each grouped as [group, entries] (group)}
          <div class="px-2 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group}
          </div>
          {#each entries as match (match.command.id)}
            {@const enabled = isCommandEnabled(match.command)}
            {@const active = indexOfCommand(match.command) === cursor}
            <button
              type="button"
              role="option"
              aria-selected={active}
              aria-disabled={!enabled}
              data-active={active}
              onclick={() => void activate(match.command)}
              onmousemove={() => {
                cursor = indexOfCommand(match.command);
              }}
              class="flex w-full items-center gap-3 px-2 py-2 text-left text-sm
                     {active ? 'bg-muted' : ''} {enabled
                ? 'text-foreground'
                : 'cursor-not-allowed text-muted-foreground/60'}"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate">
                  {#each segments(match.command.title, match.hits) as part, index (index)}
                    {#if part.hit}<span class="font-semibold text-foreground">{part.text}</span
                      >{:else}{part.text}{/if}
                  {/each}
                </span>
                {#if match.command.subtitle}
                  <span class="block truncate text-xs text-muted-foreground">
                    {match.command.subtitle}
                  </span>
                {/if}
              </span>

              {#if !enabled}
                <span class="shrink-0 text-xs text-muted-foreground">Unavailable</span>
              {:else if match.command.argument}
                <!-- Enter opens a box rather than acting, and the row has to say so before it is pressed. -->
                <span class="shrink-0 text-xs text-muted-foreground">Needs an id</span>
              {:else if match.command.keybinding}
                <span class="flex shrink-0 items-center gap-1">
                  {#each formatBinding(match.command.keybinding) as key (key)}
                    <kbd class="border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                      {key}
                    </kbd>
                  {/each}
                </span>
              {/if}
            </button>
          {/each}
        {/each}
      {/if}
    </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
