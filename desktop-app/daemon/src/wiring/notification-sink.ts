import type { BusEvent, EventBus, Subscription } from "../bus/event-bus.ts";
import type { Store } from "../store/index.ts";
import type { NotificationRow } from "../store/types.ts";

/**
 * Persists notifications from the pipeline into the `notifications` table.
 *
 * Notifications are the one event class that is genuinely *state*, not history: an invite is
 * pending until it is answered, and the UI has to show the current set on a cold start rather than
 * replaying a feed. So unlike presence, this one is a table.
 *
 * The awkward part is that VRChat has two generations of notification events live at once, and the
 * lifecycle ones carry a bare id rather than an object — see `decode.ts`. Both are handled here so
 * nothing downstream has to know which generation a notification came from.
 */

export interface NotificationPayload {
  id?: unknown;
  type?: unknown;
  /** v2 calls it `category`. */
  category?: unknown;
  senderUserId?: unknown;
  senderUsername?: unknown;
  message?: unknown;
  /** v2 only; used when `message` is empty. */
  title?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  seen?: unknown;
  data?: unknown;
  /** v1 REST only, and a JSON-encoded string rather than an object. See `toNotificationRow`. */
  details?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The lifecycle events carry the id as the whole payload, not as a field on an object. */
function idFromPayload(payload: unknown): string | null {
  if (typeof payload === "string") return payload === "" ? null : payload;
  if (typeof payload === "object" && payload !== null) {
    return str((payload as NotificationPayload).id);
  }
  return null;
}

export class NotificationSink {
  #subscription: Subscription | null = null;

  constructor(private readonly store: Store) {}

  attach(bus: EventBus): void {
    this.#subscription = bus.subscribe((event) => this.#handle(event), {
      kinds: ["notification.*"],
    });
  }

  detach(): void {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
  }

  #handle(event: BusEvent): void {
    // Notifications belong to an account by definition — an unlinked game session cannot receive
    // one — so a null account here means a bug upstream, not a state to accommodate.
    if (!event.accountId) return;

    try {
      switch (event.kind) {
        case "notification.received":
        case "notification.received_v2":
        case "notification.updated":
          this.#upsert(event);
          break;

        case "notification.seen":
          this.#markSeen(event);
          break;

        case "notification.deleted":
        case "notification.hidden":
        case "notification.cleared":
          // Deliberately not deleted from the table. `clear-notification` in particular arrives
          // with no content at all, so acting on it destructively would mean guessing which rows it
          // meant. Marking seen is the recoverable interpretation.
          this.#markSeen(event);
          break;

        default:
          break;
      }
    } catch (error) {
      console.error(`[notifications] failed to persist ${event.kind}:`, error);
    }
  }

  #upsert(event: BusEvent): void {
    if (!event.accountId) return;
    const row = toNotificationRow(event.payload, event.accountId, event.ts);
    if (row !== null) this.store.putNotification(row);
  }

  #markSeen(event: BusEvent): void {
    const id = idFromPayload(event.payload);
    if (id) this.store.markNotificationSeen(id);
  }
}

/**
 * One VRChat notification — from the socket **or** from the REST backfill — as a store row.
 *
 * Exported and shared on purpose: the pipeline and the REST poll deliver the same notifications in
 * subtly different shapes, and two mappings would drift into two different sets of bugs. The
 * differences this has to absorb:
 *
 *  - **`details` is a JSON-encoded *string* over REST and a real object over the socket.** The
 *    generated types say so explicitly. Storing the raw string would put an escaped blob in the
 *    `data` column for exactly half of all notifications.
 *  - **`created_at` (v1) vs `createdAt` (v2)**, both ISO strings, while every column here is
 *    integer ms.
 *  - **`type` (v1) vs `category` (v2)**.
 *  - **`senderUsername` is deprecated and VRChat no longer returns it**, so a backfilled row's
 *    display name is usually null. That is not a failure: the id is what matters, and the UI
 *    resolves names from the user endpoint.
 *
 * Returns null when the payload carries no usable id, which is the only genuinely unusable case.
 */
export function toNotificationRow(
  payload: unknown,
  accountId: string,
  receivedAt: number,
): NotificationRow | null {
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as NotificationPayload;
  const id = str(record.id);
  if (id === null) return null;

  const created = record.created_at ?? record.createdAt;
  const createdAt = typeof created === "string" ? Date.parse(created) : Number.NaN;

  return {
    id,
    account_id: accountId,
    // Fall back to when we received it rather than to 0, which would sort the row to the
    // beginning of time and bury it under every notification the user has ever had.
    ts: Number.isFinite(createdAt) ? createdAt : receivedAt,
    type: str(record.type) ?? str(record.category) ?? "unknown",
    sender_user_id: str(record.senderUserId),
    sender_display_name: str(record.senderUsername),
    message: str(record.message) ?? str(record.title),
    seen: record.seen === true ? 1 : 0,
    data: encodeData(record),
  };
}

/** `data` (v2, object), `details` (v1, a JSON *string*), or nothing. */
function encodeData(record: NotificationPayload): string | null {
  if (record.data !== undefined && record.data !== null) return JSON.stringify(record.data);

  const details = record.details;
  if (typeof details === "string") {
    if (details === "") return null;
    try {
      // Re-encode rather than pass through, so the column holds one shape: a JSON object, never a
      // JSON string containing JSON.
      return JSON.stringify(JSON.parse(details));
    } catch {
      // VRChat has shipped malformed `details` before. Keep it as a string rather than losing it.
      return JSON.stringify(details);
    }
  }
  if (details !== undefined && details !== null) return JSON.stringify(details);
  return null;
}
