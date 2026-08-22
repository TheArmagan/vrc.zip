-- 008_notifications_ts — one index, so the inbox can be paged across every account at once.
--
-- `GET /api/notifications` used to fan out over the accounts, take fifty rows each and sort the
-- result in JS, which is a fixed window rather than a page: the fifty-first notification on a busy
-- account was unreachable, and there was no cursor to ask for it with.
--
-- Paging it properly means `ORDER BY ts DESC LIMIT ?` with no `account_id` predicate, and
-- `ix_notifications_acct_ts` cannot serve that — its leading column is the account. This is the
-- same shape as the events table, where `listAllEvents` is the selector that sees every account
-- (and rows belonging to none).

CREATE INDEX ix_notifications_ts ON notifications (ts DESC);
