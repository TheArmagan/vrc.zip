<!--
  Shown whenever `status.degradedKeychain` holds. Also non-dismissible: this says that VRChat
  passwords and auth cookies are sitting in a file that anyone with this user account can read,
  and a banner the user can close is a banner they will close once and never think about again.
  It disappears only when the daemon reports the keychain working.
-->
<script lang="ts">
import { SecurityValidationIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import { hrefFor } from "$lib/router.ts";
</script>

<div
  role="alert"
  class="flex items-start gap-3 border-b border-destructive/40 bg-destructive/12 px-4 py-2.5
         text-sm text-destructive"
>
  <HugeiconsIcon icon={SecurityValidationIcon} size={17} class="mt-0.5 shrink-0" />
  <div class="min-w-0 flex-1 space-y-0.5">
    <p class="font-semibold">Credentials are not in the system keychain.</p>
    <p class="text-destructive/85">
      The OS keychain could not be opened, so the master key fell back to a permissions-restricted
      file in the vrc.zip data directory. Credentials are still encrypted, but anyone who can read
      your user profile can attempt to decrypt them. Sign out of accounts you care about until this
      is fixed.
    </p>
  </div>
  <a
    href={hrefFor("settings")}
    class="shrink-0 border border-destructive/50 px-2 py-1 text-xs font-medium
           hover:bg-destructive/15"
  >
    Details
  </a>
</div>
