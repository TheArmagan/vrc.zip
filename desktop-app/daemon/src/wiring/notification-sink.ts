import type { BusEvent, EventBus, Subscription } from "../bus/event-bus.ts";
import type { Store } from "../store/index.ts";

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

interface NotificationPayload {
  id?: unknown;
  type?: unknown;
  senderUserId?: unknown;
  senderUsername?: unknown;
  message?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  data?: unknown;
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
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) return;

    const record = payload as NotificationPayload;
    const id = str(record.id);
    if (!id || !event.accountId) return;

    const created = record.created_at ?? record.createdAt;
    const createdAt = typeof created === "string" ? Date.parse(created) : Number.NaN;

    this.store.putNotification({
      id,
      account_id: event.accountId,
      // VRChat's `created_at` is an ISO string; we store integer ms everywhere. Fall back to when
      // we received it rather than to 0, which would sort the row to the beginning of time.
      ts: Number.isFinite(createdAt) ? createdAt : event.ts,
      type: str(record.type) ?? "unknown",
      sender_user_id: str(record.senderUserId),
      sender_display_name: str(record.senderUsername),
      message: str(record.message),
      seen: 0,
      data: record.data === undefined ? null : JSON.stringify(record.data),
    });
  }

  #markSeen(event: BusEvent): void {
    const id = idFromPayload(event.payload);
    if (id) this.store.markNotificationSeen(id);
  }
}
