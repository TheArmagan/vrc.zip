<!--
  A button that has to be held down.

  PLAN.md §Phase 3 asks for a hold-to-confirm on the sentence "this plugin can do anything your
  computer can do". With signing cut (correction 5), every plugin is unsigned and there is no tier
  to distinguish, so the hold applies to **every** install rather than to a lesser class of them.
  It is not a penalty on untrusted plugins; it is the accurate statement about all of them.

  Why a hold rather than the two-click arm the Connected apps page uses: an arm is undone by a
  second click in the same place, which a person who is clicking through a flow will produce
  without reading. A hold cannot be produced by momentum. It is the only affordance here whose cost
  is *attention* rather than *aim*.

  ## Keyboard

  A pointer-only hold is a control keyboard users cannot operate, so Space and Enter hold it too:
  keydown starts the timer, keyup cancels it, and the browser's key repeat is ignored so a held key
  does not restart the countdown on every repeat. `role="button"` semantics come from the real
  `<button>` element underneath.

  ## Why it is not a `<progress>`

  The fill is decorative — the same information is in the label, which counts down — and a progress
  element announces percentage changes to a screen reader continuously while held. `aria-live` on
  the label would do the same. So the fill is a plain div and the accessible name changes once, at
  the point the action fires.
-->
<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";

let {
  label,
  holdingLabel = "Keep holding…",
  durationMs = 1200,
  disabled = false,
  variant = "destructive",
  onconfirm,
}: {
  label: string;
  /** Shown while the hold is in progress. Says what to do, not what is happening. */
  holdingLabel?: string;
  durationMs?: number;
  disabled?: boolean;
  variant?: "default" | "destructive" | "secondary" | "outline" | "ghost";
  onconfirm: () => void;
} = $props();

/** 0 to 1. Drives the fill and nothing else. */
let progress = $state(0);
let holding = $state(false);

let frame: number | null = null;
let startedAt = 0;

function tick(now: number): void {
  const elapsed = now - startedAt;
  progress = Math.min(elapsed / durationMs, 1);
  if (progress >= 1) {
    // Read the callback *before* releasing, so a handler that re-renders this component cannot
    // land while the timer is still armed.
    release();
    onconfirm();
    return;
  }
  frame = requestAnimationFrame(tick);
}

function start(): void {
  if (disabled || holding) return;
  holding = true;
  startedAt = performance.now();
  progress = 0;
  frame = requestAnimationFrame(tick);
}

function release(): void {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  holding = false;
  progress = 0;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== " " && event.key !== "Enter") return;
  // A held key repeats. Without this the countdown restarts on every repeat and never completes,
  // which reads as a button that does nothing.
  if (event.repeat) return;
  event.preventDefault();
  start();
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key !== " " && event.key !== "Enter") return;
  release();
}
</script>

<Button
  {variant}
  {disabled}
  class="relative overflow-hidden"
  onpointerdown={start}
  onpointerup={release}
  onpointerleave={release}
  onpointercancel={release}
  onkeydown={onKeyDown}
  onkeyup={onKeyUp}
  onblur={release}
>
  <!--
    The fill sits behind the label and is inert to hit-testing, so it cannot eat the pointerup that
    cancels the hold.
  -->
  <span
    aria-hidden="true"
    class="pointer-events-none absolute inset-y-0 left-0 bg-foreground/20 transition-none"
    style="width: {progress * 100}%"
  ></span>
  <span class="relative">{holding ? holdingLabel : label}</span>
</Button>
