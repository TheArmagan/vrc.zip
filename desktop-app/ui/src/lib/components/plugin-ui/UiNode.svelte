<!--
  The renderer: one plugin `UINode`, drawn with this app's own components.

  This is the whole of PLAN.md §"UI: declarative schema rendered by host components". A plugin never
  gets a DOM node, never gets a script tag in this page, and there is **no escape hatch** — the host
  page holds the session token, so any plugin JS running here could read it and call the API with
  every scope rather than its granted ones.

  ## The shape of the file

  One recursive component with a `{#if}` chain over `node.type`, rather than a component per node
  type. Twenty-odd two-line components would be twenty-odd files whose only content is a wrapper,
  and the recursion has to pass six things down (the panel, the form scope, the node path) which as
  props on every one of them is where the drift starts. The chain is long but it is one place.

  ## Node identity, and why the path is the id

  Every node gets an id built from its position: `notes/children.0/children.2`. That id is what
  `busy` and per-node errors are keyed on, so pressing one button marks *that* button. A plugin's
  own `key` is used when present, which is what makes identity survive a patch — a keyed node keeps
  its id even when its siblings shift.

  ## What the host owns

  Input echo, focus, tab selection, table sort and filter, and optimistic switch state are all local
  and instant. They never round-trip. An intent round-trips to another process, so anything that
  must feel immediate cannot be one — that is the §UI latency note, made concrete.
-->
<script lang="ts">
import type { Intent, UINode } from "@vrcz/plugin-api/ui";
import UserName from "$lib/components/UserName.svelte";
import WorldLink from "$lib/components/WorldLink.svelte";
import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { pluginPanels } from "$lib/state/plugin-panels.svelte.ts";
import PluginTable from "./PluginTable.svelte";
import UiNode from "./UiNode.svelte";

let {
  node,
  pluginId,
  panelId,
  path,
  form,
}: {
  node: UINode;
  pluginId: string;
  panelId: string;
  /** Position in the tree. See the header: this is the node's identity. */
  path: string;
  /**
   * The nearest enclosing `form`'s live values, or null outside one.
   *
   * Passed down rather than looked up, because "the nearest enclosing form" is a fact about the
   * tree and the tree is what this component is walking. A named control writes into it; a submit
   * sends the whole thing.
   */
  form: Record<string, string | number | boolean> | null;
} = $props();

const nodeId = $derived(node.key === undefined ? path : `${panelId}#${node.key}`);
const busy = $derived(pluginPanels.isBusy(nodeId) || node.busy === true);
const error = $derived(pluginPanels.errorFor(nodeId));

/** Children with their paths, so the recursion below stays a one-liner. */
function childrenOf(current: UINode): readonly UINode[] {
  return (current as { children?: readonly UINode[] }).children ?? [];
}

function fire(intent: Intent | undefined): void {
  if (intent === undefined || busy) return;
  void pluginPanels.dispatch(pluginId, panelId, nodeId, intent, form ?? {});
}

/** A named control's current value, falling back to what the plugin drew. */
function valueOf(name: string | undefined, fallback: string | number | boolean): string | number | boolean {
  if (name === undefined || form === null) return fallback;
  return form[name] ?? fallback;
}

function setValue(name: string | undefined, value: string | number | boolean): void {
  if (name === undefined || form === null) return;
  form[name] = value;
}

/**
 * Whether this node's dialog is showing.
 *
 * Bound rather than passed one-way, because bits-ui owns the open state while the dialog is up —
 * Escape and the scrim close it locally, and the plugin learns from the intent rather than being
 * asked for permission. `node.open` is the plugin's word and seeds this on every tree it sends.
 */
let dialogOpen = $state(false);
/** Non-reactive: has this dialog ever actually been shown? See `onOpenChange`. */
let shown = false;

$effect(() => {
  if (node.type !== "dialog") return;
  dialogOpen = node.open;
  if (node.open) shown = true;
});

/**
 * Which tab is showing, when this node is a `tabs`.
 *
 * Host-owned and local: a tab switch must feel instant and an intent round-trips to another
 * process. `null` means "whatever the plugin said", so a plugin can move the tab by patching.
 */
let activeTab = $state<string | null>(null);

const gapClass: Record<string, string> = {
  none: "gap-0",
  sm: "gap-1",
  md: "gap-2",
  lg: "gap-4",
};

const toneClass: Record<string, string> = {
  neutral: "secondary",
  info: "secondary",
  success: "secondary",
  warn: "outline",
  danger: "destructive",
};
</script>

{#if node.type === "stack"}
  <div
    class="flex {node.direction === 'row' ? 'flex-row' : 'flex-col'} {gapClass[node.gap ?? 'md'] ??
      'gap-2'} {node.wrap === true ? 'flex-wrap' : ''}"
  >
    {#each childrenOf(node) as child, i (child.key ?? i)}
      <UiNode node={child} {pluginId} {panelId} path={`${path}.${i}`} {form} />
    {/each}
  </div>
{:else if node.type === "grid"}
  <div class="grid {gapClass[node.gap ?? 'md'] ?? 'gap-2'}" style="grid-template-columns: repeat({node.columns ?? 2}, minmax(0, 1fr))">
    {#each childrenOf(node) as child, i (child.key ?? i)}
      <UiNode node={child} {pluginId} {panelId} path={`${path}.${i}`} {form} />
    {/each}
  </div>
{:else if node.type === "card"}
  <Card.Root>
    {#if node.title !== undefined || node.description !== undefined}
      <Card.Header>
        {#if node.title !== undefined}<Card.Title>{node.title}</Card.Title>{/if}
        {#if node.description !== undefined}
          <Card.Description>{node.description}</Card.Description>
        {/if}
      </Card.Header>
    {/if}
    <Card.Content class="flex flex-col gap-2">
      {#each childrenOf(node) as child, i (child.key ?? i)}
        <UiNode node={child} {pluginId} {panelId} path={`${path}.${i}`} {form} />
      {/each}
    </Card.Content>
  </Card.Root>
{:else if node.type === "scroll"}
  <ScrollArea class="rounded border border-border" style="max-height: {node.maxHeight ?? 320}px">
    <div class="flex flex-col gap-2 p-2">
      {#each childrenOf(node) as child, i (child.key ?? i)}
        <UiNode node={child} {pluginId} {panelId} path={`${path}.${i}`} {form} />
      {/each}
    </div>
  </ScrollArea>
{:else if node.type === "separator"}
  <Separator orientation={node.orientation === "vertical" ? "vertical" : "horizontal"} />
{:else if node.type === "text"}
  {#if node.variant === "h1"}
    <h2 class="font-semibold text-lg">{node.value}</h2>
  {:else if node.variant === "h2"}
    <h3 class="font-medium text-base">{node.value}</h3>
  {:else if node.variant === "h3"}
    <h4 class="font-medium text-sm">{node.value}</h4>
  {:else if node.variant === "muted"}
    <p class="text-muted-foreground text-sm">{node.value}</p>
  {:else if node.variant === "code"}
    <code class="rounded bg-muted px-1 py-0.5 text-xs">{node.value}</code>
  {:else}
    <p class="text-sm">{node.value}</p>
  {/if}
{:else if node.type === "badge"}
  <Badge variant={(toneClass[node.tone ?? "neutral"] ?? "secondary") as "secondary"}>
    {node.label}
  </Badge>
{:else if node.type === "alert"}
  <Alert variant={node.tone === "danger" ? "destructive" : "default"}>
    {#if node.title !== undefined}<AlertTitle>{node.title}</AlertTitle>{/if}
    {#if node.description !== undefined}
      <AlertDescription>{node.description}</AlertDescription>
    {/if}
  </Alert>
{:else if node.type === "empty"}
  <div class="rounded border border-border border-dashed p-4 text-center">
    <p class="font-medium text-sm">{node.title}</p>
    {#if node.description !== undefined}
      <p class="text-muted-foreground text-xs">{node.description}</p>
    {/if}
  </div>
{:else if node.type === "skeleton"}
  {#each Array.from({ length: node.lines ?? 3 }) as _, i (i)}
    <Skeleton class="h-4 w-full" />
  {/each}
{:else if node.type === "userRef"}
  <!--
    The payoff of the ref vocabulary: a plugin passes an id and gets this app's own user affordance —
    the hover card, the context menu, the trust colour — without holding `friends:read` just to draw
    a name, and without every plugin inventing its own.
  -->
  <UserName userId={node.id} name={node.fallbackLabel ?? null} />
{:else if node.type === "worldRef"}
  <WorldLink worldId={node.id} />
{:else if node.type === "form"}
  <!--
    A form owns a value bag its named controls read and write. `formState` on the intent is this
    object, which is why a submit needs no round trip per keystroke.
  -->
  {@const scope = {}}
  <form
    class="flex flex-col gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      fire(node.onSubmit);
    }}
  >
    {#each childrenOf(node) as child, i (child.key ?? i)}
      <UiNode node={child} {pluginId} {panelId} path={`${path}.${i}`} form={scope} />
    {/each}
    {#if node.submitLabel !== undefined}
      <div>
        <Button type="submit" disabled={busy}>{node.submitLabel}</Button>
      </div>
    {/if}
  </form>
{:else if node.type === "field"}
  <div class="flex flex-col gap-1">
    <Label>
      {node.label}{#if node.required === true}<span class="text-destructive"> *</span>{/if}
    </Label>
    {#if node.description !== undefined}
      <p class="text-muted-foreground text-xs">{node.description}</p>
    {/if}
    <UiNode node={node.control} {pluginId} {panelId} path={`${path}.control`} {form} />
    {#if node.error !== undefined}
      <p class="text-destructive text-xs">{node.error}</p>
    {/if}
  </div>
{:else if node.type === "input"}
  <Input
    type={node.variant === "password" ? "password" : node.variant === "number" ? "number" : "text"}
    placeholder={node.placeholder ?? ""}
    maxlength={node.maxLength}
    disabled={node.disabled === true}
    value={String(valueOf(node.name, node.value ?? ""))}
    oninput={(event) => setValue(node.name, (event.currentTarget as HTMLInputElement).value)}
    onchange={() => fire(node.onChange)}
  />
{:else if node.type === "textarea"}
  <Textarea
    rows={node.rows ?? 3}
    placeholder={node.placeholder ?? ""}
    maxlength={node.maxLength}
    disabled={node.disabled === true}
    value={String(valueOf(node.name, node.value ?? ""))}
    oninput={(event) => setValue(node.name, (event.currentTarget as HTMLTextAreaElement).value)}
    onchange={() => fire(node.onChange)}
  />
{:else if node.type === "select"}
  <!--
    A plain `<select>` rather than the shadcn one: the vocabulary's options are a flat list of
    value/label pairs, and bits-ui's Select wants a trigger, content and item tree to express
    exactly that. The host styling is the same either way.
  -->
  <select
    class="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
    disabled={node.disabled === true}
    value={String(valueOf(node.name, node.value ?? ""))}
    onchange={(event) => {
      setValue(node.name, (event.currentTarget as HTMLSelectElement).value);
      fire(node.onChange);
    }}
  >
    {#each node.options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
{:else if node.type === "switch"}
  <label class="flex items-center gap-2 text-sm">
    <Switch
      checked={valueOf(node.name, node.checked ?? false) === true}
      disabled={node.disabled === true}
      onCheckedChange={(value) => {
        // Optimistic, and local. A switch that waited for a round trip to another process before
        // moving would feel broken, and the plugin's next tree is the authority either way.
        setValue(node.name, value);
        fire(node.onChange);
      }}
    />
    {#if node.label !== undefined}{node.label}{/if}
  </label>
{:else if node.type === "button"}
  <div class="flex flex-col gap-1">
    <Button
      variant={(node.variant ?? "default") as "default"}
      disabled={node.disabled === true || busy}
      type={node.submit === true ? "submit" : "button"}
      onclick={() => fire(node.onClick)}
    >
      {busy ? "…" : node.label}
    </Button>
    {#if error !== null}
      <p class="text-destructive text-xs">{error}</p>
    {/if}
  </div>
{:else if node.type === "dialog"}
  <!--
    A plugin's modal.

    `open` is the plugin's, not the host's: the tree says whether it is showing, so a plugin that
    wants it closed patches the node. The close gesture still works locally — Escape, the scrim, the
    X — and fires `onClose` so the plugin can update its own tree. Leaving it open on screen after a
    user dismissed it, waiting for a round trip, would be a modal that ignores Escape.
  -->
  <Dialog.Root
    bind:open={dialogOpen}
    onOpenChange={(next) => {
      /*
       * Only a *user* close fires the plugin's `onClose`.
       *
       * Measured, not guessed: bits-ui emits `onOpenChange(false)` while it settles, before the
       * dialog has ever been shown. Forwarding that fired the plugin's close intent immediately,
       * the plugin dutifully re-drew the dialog closed, and the modal flickered open and shut with
       * nothing in the console to say why. `shown` is what tells a real dismissal from that.
       */
      if (next) {
        shown = true;
        return;
      }
      if (!shown) return;
      shown = false;
      fire(node.onClose);
    }}
  >
    <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>{node.title}</Dialog.Title>
        {#if node.description !== undefined}
          <Dialog.Description>{node.description}</Dialog.Description>
        {/if}
      </Dialog.Header>
      <div class="flex flex-col gap-2">
        {#each childrenOf(node) as child, i (child.key ?? i)}
          <UiNode node={child} {pluginId} {panelId} path={`${path}.${i}`} {form} />
        {/each}
      </div>
      {#if node.actions !== undefined && node.actions.length > 0}
        <Dialog.Footer>
          {#each node.actions as action, i (action.key ?? i)}
            <UiNode node={action} {pluginId} {panelId} path={`${path}.action.${i}`} {form} />
          {/each}
        </Dialog.Footer>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
{:else if node.type === "tabs"}
  <!--
    Which tab is showing is the *host's* business while the panel is open: switching has to feel
    instant, and an intent round-trips to another process. The plugin's `value` seeds it.
  -->
  {@const items = node.items}
  {#if items.length > 0}
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap gap-1 border-border border-b">
        {#each items as item (item.id)}
          <button
            type="button"
            class="border-b-2 px-3 py-1.5 text-sm {(activeTab ?? items[0]?.id) === item.id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'}"
            onclick={() => {
              activeTab = item.id;
            }}
          >
            {item.label}
          </button>
        {/each}
      </div>
      {#each items as item, i (item.id)}
        {#if (activeTab ?? items[0]?.id) === item.id}
          <UiNode node={item.content} {pluginId} {panelId} path={`${path}.tab.${i}`} {form} />
        {/if}
      {/each}
    </div>
  {/if}
{:else if node.type === "table"}
  <PluginTable {node} {pluginId} {panelId} path={`${path}.table`} />
{:else if node.type === "list"}
  <ul class="flex flex-col divide-y divide-border rounded border border-border">
    {#each node.items as item (item.key)}
      <li class="flex items-center gap-2 px-3 py-2">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm">{item.title}</p>
          {#if item.subtitle !== undefined}
            <p class="truncate text-muted-foreground text-xs">{item.subtitle}</p>
          {/if}
        </div>
        {#if item.badge !== undefined}<Badge variant="secondary">{item.badge}</Badge>{/if}
        {#if item.onSelect !== undefined}
          <Button
            variant="ghost"
            size="sm"
            disabled={pluginPanels.isBusy(`${path}.item.${item.key}`)}
            onclick={() =>
              void pluginPanels.dispatch(
                pluginId,
                panelId,
                `${path}.item.${item.key}`,
                item.onSelect as Intent,
                form ?? {},
              )}
          >
            Open
          </Button>
        {/if}
      </li>
    {:else}
      <li class="px-3 py-2 text-muted-foreground text-sm">{node.empty ?? "Nothing here."}</li>
    {/each}
  </ul>
{:else}
  <!--
    A node type this build does not render.

    Said out loud rather than skipped: a plugin compiled against a newer protocol minor draws
    something, and silence would send its author looking for a bug in their own tree. The validator
    already refused anything that is not in the vocabulary, so this only ever means "newer than me".
  -->
  <p class="text-muted-foreground text-xs italic">
    This build cannot draw a "{node.type}" yet.
  </p>
{/if}
