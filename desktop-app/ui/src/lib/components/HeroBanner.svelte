<!--
  The band across the top of a card — a user's profile banner, a world's hero image.

  It is a fixed-height plate that is *always* drawn, and that is the whole design. Plenty of VRChat
  users have never set a banner and plenty of worlds have no usable image, so "no image" is a
  first-class case, not an edge case — a band that only appears when an image exists would mean the
  title and every row under it sat at two different heights depending on which record you opened,
  and the common case would read as the broken one. Instead the plate is a deliberate surface on
  its own, and an image is something that lands *on* it.

  Shared between the user modal and the world modal deliberately. Both had their own version, and
  the world one had exactly the bugs this component exists to prevent: a taller box when an image
  existed and a shorter one when it did not, no fade, and nothing at all for a failed load.
  Callers set the height with `class`.

  That also disposes of the two states a remote image always has. A slow load fades in over the
  plate rather than over a hole; a failed one — the VRChat file host 403s often enough — leaves the
  plate exactly as it was, with no broken-image glyph and no reflow. Nothing below ever moves.

  Aspect ratio is not our problem either: `object-cover` centre-crops, so a 2000x200 letterbox and a
  square avatar-shaped upload both fill the band without stretching.

  The image is decorative. It is `alt=""` and `aria-hidden` because everything it depicts — whose
  profile this is, which world this is — is written in words directly beneath it.
-->
<script lang="ts">
import { imageUrl } from "$lib/api.ts";
import { cn } from "$lib/utils.js";

let {
  url = null,
  class: className,
}: {
  /** The absolute VRChat URL, or null. Proxied here; never handed to the browser directly. */
  url?: string | null;
  class?: string;
} = $props();

const src = $derived(imageUrl(url));

let loaded = $state(false);
let failed = $state(false);

/*
 * The modal is re-targeted at a new subject without unmounting, so the load flags belong to the URL
 * rather than to the component. Without this reset, the second banner would inherit the first
 * one's `failed` and never be drawn at all.
 */
$effect(() => {
  void src;
  loaded = false;
  failed = false;
});
</script>

<div
  class={cn(
    "relative h-28 w-full overflow-hidden rounded-t-4xl bg-gradient-to-br from-muted via-muted/50 to-popover",
    className,
  )}
>
  {#if src !== undefined && !failed}
    <img
      {src}
      alt=""
      aria-hidden="true"
      decoding="async"
      class={cn(
        "absolute inset-0 size-full object-cover object-center transition-opacity duration-500",
        loaded ? "opacity-100" : "opacity-0",
      )}
      onload={() => {
        loaded = true;
      }}
      onerror={() => {
        failed = true;
      }}
    />
  {/if}

  <!--
    The scrim. The avatar, the title and the dialog's close button all overlap the bottom of this
    band, and a user-supplied image can be any colour at all, so the fade to the popover surface is
    what keeps them legible without dimming the whole picture.

    It stays a gentle fade on purpose. An earlier pass made the bottom two-fifths near-opaque to
    stop the header text being cut apart — which worked, and cost most of a world's hero image to
    do it. The cutting was never an opacity problem: this element is `absolute` and the header is
    static, so the scrim painted *over* the text no matter what colour it was. `EntityModal` gives
    the header a stacking position instead, and the image gets to be an image again.
  -->
  <div
    class="absolute inset-0 bg-gradient-to-t from-popover via-popover/50 to-transparent"
    aria-hidden="true"
  ></div>
</div>
