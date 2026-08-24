<!--
  The "there is a newer vrc.zip" bar.

  Stacked with the UNOFFICIAL marker and the keychain warning, above the chrome and outside the
  scroll container, for the reason those two are: a message about the app itself is not part of any
  screen, and one that scrolls away is one nobody reads.

  Unlike the keychain warning, this one closes. That warning is about credentials sitting somewhere
  they should not be and is not the user's to dismiss; this is news, and news that cannot be put
  away becomes furniture. Closing it is remembered for the tab and not beyond, so the next launch
  says it again rather than losing a release to a click somebody made a week ago.
-->
<script lang="ts">
import DownloadIcon from "@lucide/svelte/icons/download";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import SparklesIcon from "@lucide/svelte/icons/sparkles";
import XIcon from "@lucide/svelte/icons/x";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { updates } from "$lib/state/updates.svelte.ts";

const status = $derived(updates.status);
</script>

{#if updates.visible && status !== null}
  <!--
    `pr-72` overrides the `pr-18` the alert reserves for a single action button. Three of them are
    wider than that, and the action row is absolutely positioned, so without the extra reserve a
    long sentence slides underneath the buttons instead of wrapping before them.
  -->
  <Alert.Root
    class="shrink-0 rounded-none border-x-0 border-t-0 border-primary/40 bg-primary/10 px-4 py-3 pr-72"
  >
    <SparklesIcon />
    <Alert.Title>
      {#if updates.restarting}
        vrc.zip is updating to {status.latest} and restarting.
      {:else}
        vrc.zip {status.latest} is available.
      {/if}
    </Alert.Title>
    <Alert.Description>
      {#if updates.restarting}
        This window is talking to a daemon that is on its way out. vrc.zip opens a new one when it
        is back.
      {:else if updates.failure !== null}
        {updates.failure}
      {:else}
        You are running {status.current}.
        {#if status.canInstall}
          Updating replaces vrc.zip and restarts it.
        {:else}
          This copy cannot replace itself, so get it from the release page.
        {/if}
      {/if}
    </Alert.Description>

    {#if !updates.restarting}
      <Alert.Action class="flex items-center gap-2">
        {#if status.url !== null}
          <Button variant="ghost" size="sm" href={status.url} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            What changed
          </Button>
        {/if}
        {#if status.canInstall}
          <Button size="sm" disabled={updates.busy} onclick={() => void updates.install()}>
            <DownloadIcon />
            {updates.busy ? "Updating…" : "Update and restart"}
          </Button>
        {/if}
        <!--
          A real button rather than a bare icon: this is the control somebody reaches for when they
          are not updating right now, and it has to be as easy to hit as the one that is.
        -->
        <Button
          variant="ghost"
          size="sm"
          aria-label="Dismiss the update notice"
          onclick={() => updates.dismiss()}
        >
          <XIcon />
        </Button>
      </Alert.Action>
    {/if}
  </Alert.Root>
{/if}
