<script lang="ts">
/**
 * An invisible element that reports when it scrolls into view, so a list can fetch its next page.
 *
 * An `IntersectionObserver` rather than a scroll handler: a scroll handler runs on every frame of
 * every scroll and has to measure the document to decide anything, which is the classic way to make
 * a long list feel heavy. The observer fires only at the boundary and costs nothing in between.
 *
 * `rootMargin` is what makes the paging invisible. Firing when the sentinel is already on screen
 * means the reader watches a spinner; firing a screenful early means the next page is usually there
 * before they arrive. The observer walks up to the nearest scrollable ancestor by default, which is
 * the modal body in one of this component's two homes and the page in the other, and both are
 * correct without being told which.
 */
interface Props {
  /** Called when the sentinel comes into view. Must be safe to call more than once. */
  onVisible: () => void;
  /** How far ahead of the viewport to fire. One screenful is a good default. */
  rootMargin?: string;
  /** Set false to stop observing — an exhausted list should not keep asking. */
  enabled?: boolean;
}

const { onVisible, rootMargin = "600px", enabled = true }: Props = $props();

let sentinel = $state<HTMLDivElement | null>(null);

$effect(() => {
  const element = sentinel;
  if (element === null || !enabled) return;

  const observer = new IntersectionObserver(
    (entries) => {
      // `onVisible` is expected to guard its own re-entry (see `PagedList.loadMore`), because the
      // observer legitimately fires again on resize, on a re-render, and on a fast scroll that
      // crosses the boundary before the previous response lands.
      for (const entry of entries) if (entry.isIntersecting) onVisible();
    },
    { rootMargin },
  );
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
});
</script>

<!--
  `aria-hidden` because it is a scroll tripwire, not content. A screen reader announcing an empty
  element at the end of every list is noise, and the list's own busy state is what actually needs
  announcing.
-->
<div bind:this={sentinel} aria-hidden="true" class="h-px w-full shrink-0"></div>
