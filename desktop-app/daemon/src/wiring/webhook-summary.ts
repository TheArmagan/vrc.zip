/**
 * One `webhooks` row as the wire describes it.
 *
 * Shared between the two surfaces that list webhooks — `/app/webhooks`, where an app sees its own,
 * and `/api/webhooks`, where the user sees all of them — because they show the *same* record and a
 * mapper written twice is a mapper that will one day disagree with itself. The difference between
 * the two is which rows they are handed, and that belongs in the callers.
 *
 * The signing secret is not here and cannot be: the store holds only a hash of it, and the plaintext
 * exists exactly once, in the answer to the registration that minted it.
 */

import type { WebhookSummary } from "@vrcz/shared";
import type { Store } from "../store/index.ts";
import type { WebhookRow } from "../store/types.ts";

export function webhookSummary(row: WebhookRow, store: Store): WebhookSummary {
  return {
    id: row.id,
    grantId: row.grant_id,
    // Resolved from the grant rather than copied onto the webhook at registration: a stored copy
    // would keep the old name after the app changed its User-Agent, and the name is the only thing
    // on this row a person can recognise.
    appName: row.grant_id === null ? null : (store.getGrant(row.grant_id)?.app_name ?? null),
    url: row.url,
    kinds: parseKinds(row.kinds),
    accountId: row.account_id,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
    deliveredCount: row.delivered_count,
    deadCount: row.dead_count,
    lastDeliveryAt: row.last_delivery_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    // The number that distinguishes "your endpoint is down and vrc.zip is still trying" from
    // "vrc.zip gave up", which `deadCount` alone cannot say.
    pending: store.countPendingWebhookDeliveries(row.id),
  };
}

function parseKinds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((kind) => typeof kind === "string") : [];
  } catch {
    // A row nobody can read still describes a webhook the user may want to delete, so it lists with
    // no kinds rather than vanishing out of the very list that offers the delete button.
    return [];
  }
}
