<!--
  Why a modal, or one tab of one, has nothing to show — and what to do about it.

  This existed four times over: once for a profile, once for its Groups tab, once for its Mutual
  friends tab, and once for a world. Every copy had the same three parts and the same lookup with
  the same fallback, and the fourth copy was written by copying the third.

  What is *not* here is the wording. Each caller passes its own `titles` and `bodies`, because the
  sentences are the whole value of this component and they are specific: "no account is online"
  means something different in front of a profile ("a profile can only be read through somebody's
  credentials") than in front of a world ("a world vrc.zip has already seen is served from cache").
  Collapsing those into one generic sentence would be the opposite of the point. What is shared is
  the *shape*: a title, a sentence, and a retry.

  The fallback rule is the part worth stating once instead of four times. A caller maps a failure
  it has words for to those words, and maps `other` to `""` — the empty string means "I have
  nothing better to say than what the daemon said", so the raw `message` is used. That keeps a
  genuine fault legible instead of hiding it behind a reassuring sentence about credentials.
-->
<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";

let {
  failure,
  titles,
  bodies,
  message = null,
  onRetry,
  retryLabel = "Try again",
}: {
  /** The caller's failure discriminant. Unknown values fall through to the `other` entry. */
  failure: string;
  titles: Readonly<Record<string, string>>;
  /** A `""` entry means "use `message`" — see the note above. */
  bodies: Readonly<Record<string, string>>;
  /** The daemon's own words, for the failures the caller has no better sentence for. */
  message?: string | null;
  /** Omitted where there is nothing to retry — a closed instance is not going to reopen. */
  onRetry?: () => void;
  retryLabel?: string;
} = $props();

const title = $derived(titles[failure] ?? titles.other ?? "Something went wrong");
const body = $derived.by(() => {
  const known = bodies[failure];
  if (known === undefined || known === "") return message ?? bodies.other ?? "";
  return known;
});
</script>

<div class="space-y-2 border border-border bg-muted/40 px-3 py-3">
  <p class="text-sm font-medium">{title}</p>
  {#if body !== ""}
    <p class="text-xs text-muted-foreground">{body}</p>
  {/if}
  {#if onRetry !== undefined}
    <Button variant="outline" size="sm" onclick={onRetry}>{retryLabel}</Button>
  {/if}
</div>
