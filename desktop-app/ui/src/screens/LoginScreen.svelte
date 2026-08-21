<!--
  Sign in to VRChat.

  The three two-factor flows are drawn as three different things, never as one "code" box with a
  changing label. They are three different user situations: open an app on your phone, go read your
  email, or find the piece of paper you wrote your recovery codes on. Collapsing them into one
  input is how people end up typing an email code into an authenticator prompt and being told they
  are wrong, with nothing to tell them why.
-->
<script lang="ts">
import {
  Key01Icon,
  Mail01Icon,
  SecurityValidationIcon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/svelte";
import { toast } from "svelte-sonner";
import { api, describeError, isSetupRequired, type TwoFactorMethod } from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { twoFactorLabel } from "$lib/format.ts";
import { hrefFor, navigate } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";

let { accountId = null }: { accountId?: string | null } = $props();

interface MethodStyle {
  readonly icon: IconSvgElement;
  /** What the user has to physically do. Not a restatement of the method name. */
  readonly instruction: string;
  readonly placeholder: string;
  readonly inputMode: "numeric" | "text";
  readonly maxLength: number;
  readonly pattern: RegExp;
  /** Border and tint, so the three panels are told apart before any text is read. */
  readonly accent: string;
  readonly field: string;
}

const STYLES: Record<TwoFactorMethod, MethodStyle> = {
  totp: {
    icon: SmartPhone01Icon,
    instruction:
      "Open the authenticator app you paired with VRChat and read the six digits. They change every 30 seconds, so type the current one.",
    placeholder: "000000",
    inputMode: "numeric",
    maxLength: 6,
    pattern: /[^0-9]/g,
    accent: "border-status-join-me/50 bg-status-join-me/5",
    field: "tabular text-center font-mono text-2xl tracking-[0.5em]",
  },
  emailOtp: {
    icon: Mail01Icon,
    instruction:
      "VRChat emailed a code to the address on the account. It can take a minute, and it lands in spam more often than it should.",
    placeholder: "000000",
    inputMode: "numeric",
    maxLength: 6,
    pattern: /[^0-9]/g,
    accent: "border-status-ask-me/50 bg-status-ask-me/5",
    field: "tabular text-center font-mono text-2xl tracking-[0.5em]",
  },
  otp: {
    icon: Key01Icon,
    instruction:
      "Use one of the one-time recovery codes you saved when you turned on two-factor. Each code works once, so cross it off after this.",
    placeholder: "xxxx-xxxx",
    inputMode: "text",
    maxLength: 24,
    pattern: /[^A-Za-z0-9-]/g,
    accent: "border-warning/50 bg-warning/5",
    field: "text-center font-mono text-lg tracking-[0.25em]",
  },
};

/** The order the panels are offered in, best first. An app code beats waiting on an email. */
const METHOD_ORDER: readonly TwoFactorMethod[] = ["totp", "emailOtp", "otp"];

let username = $state("");
let password = $state("");
let submitting = $state(false);
let error = $state<string | null>(null);

let challengeAccountId = $state<string | null>(null);
let methods = $state<readonly TwoFactorMethod[]>([]);
let chosen = $state<TwoFactorMethod | null>(null);
let code = $state("");

// Arriving at `#/login/<id>` resumes an account the daemon says is waiting on a code. The daemon
// does not report which methods that account was offered, so all three are shown.
$effect(() => {
  if (accountId === null || challengeAccountId === accountId) return;
  const pending = app.accounts.find((account) => account.id === accountId);
  if (pending?.connection !== "needs-2fa") return;
  challengeAccountId = accountId;
  methods = METHOD_ORDER;
  chosen = "totp";
});

const orderedMethods = $derived(METHOD_ORDER.filter((method) => methods.includes(method)));
const style = $derived(chosen === null ? null : STYLES[chosen]);
const codeReady = $derived(
  style !== null && code.length >= (chosen === "otp" ? 4 : style.maxLength),
);

function resetChallenge(): void {
  challengeAccountId = null;
  methods = [];
  chosen = null;
  code = "";
}

async function submitCredentials(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (submitting || username === "" || password === "") return;
  submitting = true;
  error = null;
  try {
    const result = await api.accounts.login(username, password);
    if (result.status === "requires-2fa") {
      challengeAccountId = result.accountId;
      methods = result.methods.length === 0 ? METHOD_ORDER : result.methods;
      chosen = METHOD_ORDER.find((method) => methods.includes(method)) ?? "totp";
      password = "";
      return;
    }
    toast.success(`Signed in as ${result.account.displayName}`);
    password = "";
    username = "";
    await app.refresh();
    navigate("accounts");
  } catch (cause) {
    if (isSetupRequired(cause)) {
      error =
        "VRChat requires a contact address in the User-Agent before vrc.zip may make any request. Set one in Settings, then sign in.";
      return;
    }
    error = describeError(cause);
  } finally {
    submitting = false;
  }
}

async function submitCode(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (submitting || challengeAccountId === null || chosen === null || code === "") return;
  submitting = true;
  error = null;
  try {
    const result = await api.accounts.verifyTwoFactor(challengeAccountId, chosen, code);
    toast.success(`Signed in as ${result.account.displayName}`);
    resetChallenge();
    username = "";
    await app.refresh();
    navigate("accounts");
  } catch (cause) {
    // A rejected code is not the end of the attempt. The daemon keeps the account retryable, so
    // the panel stays open and only the field is cleared.
    error = describeError(cause);
    code = "";
  } finally {
    submitting = false;
  }
}

function sanitize(value: string): string {
  if (style === null) return value;
  return value.replace(style.pattern, "").slice(0, style.maxLength);
}
</script>

<SectionHeader
  title={challengeAccountId === null ? "Add an account" : "Two-factor verification"}
  description={challengeAccountId === null
    ? "Your password is encrypted and stored on this machine only"
    : "VRChat wants a second factor before it hands over a session"}
/>

<div class="min-h-0 flex-1 overflow-y-auto">
  <div class="mx-auto w-full max-w-lg px-5 py-8">
    {#if challengeAccountId === null}
      {#if app.needsFirstRun}
        <div class="mb-6 border border-warning/50 bg-warning/10 p-4">
          <p class="text-sm font-medium">Set a contact address first</p>
          <p class="mt-1 text-xs text-muted-foreground">
            VRChat requires every API client to identify itself with a working contact address, and
            the daemon refuses to send a single request without one. Signing in will fail with
            <code class="bg-muted px-1 font-mono">setup_required</code> until it is set.
          </p>
          <Button size="sm" href={hrefFor("settings")} class="mt-3 h-7 text-xs">
            Open settings
          </Button>
        </div>
      {/if}

      <form class="space-y-4" onsubmit={(event) => void submitCredentials(event)}>
        <div class="space-y-1.5">
          <Label for="vrchat-username">VRChat username or email</Label>
          <Input
            id="vrchat-username"
            bind:value={username}
            autocomplete="username"
            autocapitalize="none"
            spellcheck={false}
            required
            disabled={submitting}
          />
        </div>

        <div class="space-y-1.5">
          <Label for="vrchat-password">Password</Label>
          <Input
            id="vrchat-password"
            type="password"
            bind:value={password}
            autocomplete="current-password"
            required
            disabled={submitting}
          />
        </div>

        {#if error}
          <ErrorNote message={error} />
        {/if}

        <div class="flex items-center gap-3">
          <Button type="submit" disabled={submitting || app.needsFirstRun}>
            {submitting ? "Signing in" : "Sign in"}
          </Button>
          <Button variant="ghost" href={hrefFor("accounts")} disabled={submitting}>Cancel</Button>
        </div>
      </form>

      <div class="mt-8 flex gap-3 border border-border bg-card p-4">
        <HugeiconsIcon
          icon={SecurityValidationIcon}
          size={16}
          class="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div class="space-y-1 text-xs text-muted-foreground">
          <p class="font-medium text-foreground">Where this password goes</p>
          <p>
            Straight to VRChat over HTTPS, through the daemon running on this machine. It is then
            encrypted with a key from your OS keychain and written to disk so vrc.zip can sign back
            in after a restart. It is never sent to vrc.zip, because there is no vrc.zip server.
          </p>
        </div>
      </div>
    {:else}
      <div class="space-y-5">
        <p class="text-sm text-muted-foreground">
          Pick the method you actually have to hand. Codes from one method are not accepted by
          another.
        </p>

        <div class="grid gap-2 sm:grid-cols-3">
          {#each orderedMethods as method (method)}
            {@const active = chosen === method}
            <button
              type="button"
              onclick={() => {
                chosen = method;
                code = "";
                error = null;
              }}
              class="flex flex-col items-start gap-1.5 border p-3 text-left transition-colors
                     {active
                ? STYLES[method].accent
                : 'border-border hover:bg-muted/50'}"
              aria-pressed={active}
            >
              <HugeiconsIcon
                icon={STYLES[method].icon}
                size={18}
                class={active ? "text-foreground" : "text-muted-foreground"}
              />
              <span class="text-xs font-medium">{twoFactorLabel(method)}</span>
            </button>
          {/each}
        </div>

        {#if style !== null && chosen !== null}
          <form class="space-y-4 border p-4 {style.accent}" onsubmit={(event) => void submitCode(event)}>
            <div class="flex items-start gap-3">
              <HugeiconsIcon icon={style.icon} size={20} class="mt-0.5 shrink-0" />
              <div class="min-w-0">
                <p class="text-sm font-medium">{twoFactorLabel(chosen)}</p>
                <p class="mt-0.5 text-xs text-muted-foreground">{style.instruction}</p>
              </div>
            </div>

            <div class="space-y-1.5">
              <Label for="two-factor-code" class="sr-only">{twoFactorLabel(chosen)}</Label>
              <!-- svelte-ignore a11y_autofocus -->
              <input
                id="two-factor-code"
                value={code}
                oninput={(event) => {
                  code = sanitize(event.currentTarget.value);
                }}
                inputmode={style.inputMode}
                maxlength={style.maxLength}
                placeholder={style.placeholder}
                autocomplete="one-time-code"
                autocapitalize="none"
                spellcheck="false"
                autofocus
                disabled={submitting}
                class="h-14 w-full border border-border bg-background px-3 outline-none
                       focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50
                       disabled:opacity-50 {style.field}"
              />
            </div>

            {#if error}
              <ErrorNote message={error} />
            {/if}

            <div class="flex items-center gap-3">
              <Button type="submit" disabled={submitting || !codeReady}>
                {submitting ? "Checking" : "Verify"}
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={submitting}
                onclick={() => {
                  resetChallenge();
                  error = null;
                }}
              >
                Start over
              </Button>
            </div>
          </form>
        {/if}

        <p class="text-xs text-muted-foreground">
          A rejected code costs nothing. The account stays on this challenge and you can try again,
          or switch to another method above.
        </p>
      </div>
    {/if}
  </div>
</div>
