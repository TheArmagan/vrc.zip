<!--
  The right-click menu on the canvas.

  A plain positioned `<div>` rather than a shadcn `DropdownMenu`, and the reason is what opens it:
  a dropdown is anchored to a trigger element, and there is no trigger here — the anchor is wherever
  the pointer was over an SVG edge or a node. Bending a dropdown into that shape means a hidden
  zero-size trigger that has to be moved before it opens, which is more machinery than a `left`
  and a `top`.

  **It closes on the next pointer-down anywhere, and on Escape.** Both are captured on the window,
  because the thing most likely to be clicked next is the canvas itself, which is not a child of
  this element and does not bubble through it.

  It clamps itself into the viewport after it is drawn: opened near the right edge, a menu that
  overflowed would put its items off-screen with no scrollbar to reach them.
-->
<script lang="ts">
import { onMount } from "svelte";

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  /** Renders in the destructive colour. For anything that removes something. */
  readonly danger?: boolean;
}

let {
  x,
  y,
  items,
  onclose,
}: {
  x: number;
  y: number;
  items: readonly MenuItem[];
  onclose: () => void;
} = $props();

let element = $state<HTMLDivElement | null>(null);
/*
 * Seeded from where the pointer was and clamped by the effect below once there is a box to measure.
 * The initial read is deliberate — this is a menu opened at a point, not one that follows it — which
 * is what the `state_referenced_locally` warning is about.
 */
// svelte-ignore state_referenced_locally
let left = $state(x);
// svelte-ignore state_referenced_locally
let top = $state(y);

onMount(() => {
  const onPointerDown = (event: PointerEvent): void => {
    // A click *inside* the menu is a selection, and the button's own handler runs after this. The
    // containment check is what stops the menu closing before the item it was opened for fires.
    if (element !== null && event.target instanceof Node && element.contains(event.target)) return;
    onclose();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") onclose();
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKey);
  };
});

$effect(() => {
  if (element === null) return;
  const box = element.getBoundingClientRect();
  left = Math.min(x, window.innerWidth - box.width - 8);
  top = Math.min(y, window.innerHeight - box.height - 8);
});
</script>

<div
  bind:this={element}
  role="menu"
  tabindex="-1"
  class="fixed z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
  style="left: {left}px; top: {top}px;"
>
  {#each items as item, index (index)}
    <button
      role="menuitem"
      class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent {item.danger === true
        ? 'text-destructive'
        : ''}"
      onclick={() => {
        item.onSelect();
        onclose();
      }}
    >
      {item.label}
    </button>
  {/each}
</div>
