-- 005_webhooks — outbound webhooks and their durable delivery queue.
--
-- See PLAN.md §"Control API — :7775": webhooks ship with the enriched event stream, and they are
-- specified as "a real outbound-HTTP subsystem — retries, backoff, dead-letter". Two tables, and
-- the split between them is the whole design: `webhooks` is a *subscription*, `webhook_deliveries`
-- is one *attempted send*. Collapsing them into a table of "pending events" would lose the health
-- history the moment a row is delivered and deleted, which is exactly when the user asks why their
-- endpoint stopped working.
--
-- **The queue is a table, not an array in memory.** An event that matched a webhook is a promise the
-- daemon made to another program; a restart mid-backoff must not silently drop it. That is also why
-- the rendered body is stored rather than the bus event: a retry has to re-send the *same bytes*, or
-- its HMAC covers a different document than the first attempt did and a receiver that deduplicates
-- on content sees two distinct events.
--
-- `secret_hash` is the HMAC key, and it is deliberately *not* the value handed to the user. The
-- plaintext `whsec_…` is returned exactly once at registration and never stored, the same posture
-- `grants` takes with its tokens; what the table holds is `sha256(secret)`, which is what signing
-- actually uses. Being honest about what that buys: an attacker who can read this table can forge
-- signatures, and no scheme can prevent that while the daemon still has to *produce* signatures. It
-- buys the two things that are real — the stored value is not the string the user pasted into their
-- receiving app (and may have reused elsewhere), and it is not a bearer credential for this daemon.
--
-- `grant_id` and `account_id` are both nullable and neither is a foreign key to `grants`. A webhook
-- the user added in the vrc.zip UI has no grant behind it, and a webhook that wants *every* account
-- has no account to point at. Not a foreign key for the same reason `audit_log.grant_id` is not:
-- revoking a grant must not take the webhook's delivery history with it.

-- ---------------------------------------------------------------------------
-- webhooks — one subscription
-- ---------------------------------------------------------------------------

CREATE TABLE webhooks (
  id                   TEXT PRIMARY KEY,
  -- The grant this was registered under, when an app registered it. Null for a user-made webhook.
  grant_id             TEXT,
  -- Validated at registration: https, or http only to loopback, and never an IP literal that points
  -- into the user's own network. See `webhooks/url.ts` — this column is the SSRF boundary's output,
  -- so it is stored already normalised by `URL` rather than as the caller typed it.
  url                  TEXT    NOT NULL,
  secret_hash          TEXT    NOT NULL,

  -- JSON array of kind patterns: an exact `friend.online`, a `friend.*` prefix, or `*` for
  -- everything. Stored as registered and never re-derived, for the same reason `grants.scopes` is:
  -- a later change to the shared kind vocabulary must not silently widen a subscription.
  kinds                TEXT    NOT NULL,
  -- Null means every account, including the null-account events a game client signed into an
  -- unmanaged account produces. See PLAN.md §1.7.
  account_id           TEXT REFERENCES accounts (id) ON DELETE CASCADE,

  created_at           INTEGER NOT NULL,
  -- Set when the user removes it, or when the auto-disable trips. Kept rather than deleted so
  -- "why did this stop firing" has an answer, and so `disabled_reason` can hold that answer.
  disabled_at          INTEGER,
  disabled_reason      TEXT,

  -- Delivery health. Counters rather than a derived COUNT(*) over `webhook_deliveries`, because
  -- retention will eventually trim that table and the health of an endpoint outlives the individual
  -- sends that measured it.
  --
  -- `consecutive_dead` counts *dead-lettered deliveries in a row* — not failed attempts, which are
  -- expected and already paid for by the backoff. It resets on the first success, exactly like
  -- `RateLimiter`'s 429 counter, and for the same reason: a decay would keep a healthy endpoint
  -- near the auto-disable threshold forever after one bad afternoon.
  consecutive_dead     INTEGER NOT NULL DEFAULT 0,
  delivered_count      INTEGER NOT NULL DEFAULT 0,
  dead_count           INTEGER NOT NULL DEFAULT 0,
  last_delivery_at     INTEGER,
  last_status          INTEGER,
  last_error           TEXT
) STRICT;

-- The scanner reads this on every enqueue, so it is an index rather than a filter in JS.
CREATE INDEX ix_webhooks_live ON webhooks (created_at) WHERE disabled_at IS NULL;
CREATE INDEX ix_webhooks_account ON webhooks (account_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- webhook_deliveries — one event, on its way to one webhook
-- ---------------------------------------------------------------------------
--
-- One row per (event, webhook) pair: two webhooks subscribed to the same kind get two rows, two
-- delivery ids, and two independent retry schedules. A shared row would mean one dead endpoint
-- holding up a healthy one.
--
-- `id` is a uuid because it is published — it goes out in the delivery header and is what a receiver
-- deduplicates on. `event_id` is the *event's* identity, shared across every webhook that matched
-- it, so a receiver subscribed twice can tell "the same thing twice" from "two things".
--
-- A row is in exactly one of four states, and all four are readable from the nullable timestamps:
-- pending (`delivered_at` and `dead_at` both null), delivered, dead-lettered, and — the state that
-- makes the queue durable — pending with `next_attempt_at` in the future, which is a row mid-backoff
-- that a restart picks up rather than loses.

CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT    NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,

  event_id        TEXT    NOT NULL,
  event_kind      TEXT    NOT NULL,
  -- The rendered JSON body, not the bus event. Retries re-send these exact bytes; see the header.
  payload         TEXT    NOT NULL,

  attempts        INTEGER NOT NULL DEFAULT 0,
  -- Due time, unix ms. Set to "now" at enqueue so a fresh row is immediately due, then pushed out by
  -- the jittered exponential backoff after each failure.
  next_attempt_at INTEGER NOT NULL,
  last_status     INTEGER,
  last_error      TEXT,

  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER,
  dead_at         INTEGER
) STRICT;

-- The due-delivery scan. Partial on the pending predicate so the index holds only the working set:
-- delivered rows are the overwhelming majority of this table and must not be paged through to find
-- the handful that are due.
--
-- No explicit tiebreak column, because SQLite already appends the rowid to every index entry — so
-- this index is (next_attempt_at, rowid) in practice, which is exactly the order the queries want.
-- The queries order by `rowid` and not `created_at`: rowid is genuine insertion order, and two
-- events landing in the same millisecond is normal on an instance transition, so the per-webhook
-- ordering guarantee needs a total order rather than an approximate one.
CREATE INDEX ix_webhook_deliveries_due
  ON webhook_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL AND dead_at IS NULL;

-- The per-webhook head-of-line lookup, and "show me this webhook's recent deliveries" for the UI.
CREATE INDEX ix_webhook_deliveries_webhook ON webhook_deliveries (webhook_id);
