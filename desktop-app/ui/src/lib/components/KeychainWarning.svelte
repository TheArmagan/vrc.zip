<!--
  Shown whenever `status.degradedKeychain` holds. Also non-dismissible: this says that VRChat
  passwords and auth cookies are sitting in a file that anyone with this user account can read,
  and a banner the user can close is a banner they will close once and never think about again.
  It disappears only when the daemon reports the keychain working.

  Built on `Alert`, but overridden into a full-width bar. The shell stacks it above the chrome, so
  it has to span the window and share an edge with the header rather than float as a card.
-->
<script lang="ts">
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { hrefFor } from "$lib/router.ts";
</script>

<Alert.Root
  variant="destructive"
  class="shrink-0 border-x-0 border-t-0 border-destructive/40 bg-destructive/10 px-4 py-3"
>
  <ShieldAlertIcon />
  <Alert.Title>Credentials are not in the system keychain.</Alert.Title>
  <Alert.Description class="text-destructive/90">
    The OS keychain could not be opened, so the master key fell back to a permissions-restricted
    file in the vrc.zip data directory. Credentials are still encrypted, but anyone who can read
    your user profile can attempt to decrypt them. Sign out of accounts you care about until this
    is fixed.
  </Alert.Description>
  <Alert.Action>
    <Button variant="outline" size="sm" href={hrefFor("settings")}>Details</Button>
  </Alert.Action>
</Alert.Root>
