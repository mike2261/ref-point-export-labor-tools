-- Add MAINTENANCE_RESET_WARNING to the notification taxonomy (docs/superpowers/specs/
-- 2026-07-28-maintenance-reset-warning-design.md): a heads-up sent once a CTV's G-wallet window
-- is 2/3 elapsed with no APPROVED order yet, ~1 month before MAINTENANCE_RESET would fire.
--
-- Unlike every other notification type, this one isn't the side effect of another table's row
-- (no order_id, no ledger_id) — it's a time-based projection computed by the daily maintenance
-- cron. Idempotency (send at most once per user per period) is enforced by a UNIQUE index on
-- (user_id, period_index), so it needs its own nullable period_index column.
--
-- CHECK constraints can't be altered in place, so this is a table rebuild, same technique as 0006.

CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
                 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'MAINTENANCE_RESET_WARNING',
                 'REDEMPTION')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  order_id     TEXT REFERENCES orders(id),
  ledger_id    TEXT REFERENCES point_ledger(id),
  period_index INTEGER CHECK (period_index >= 1),      -- MAINTENANCE_RESET_WARNING rows only
  read_at      TEXT,
  created_at   TEXT NOT NULL,

  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION'))),
  CHECK ((period_index IS NOT NULL) = (type = 'MAINTENANCE_RESET_WARNING'))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

-- Idempotency guard for MAINTENANCE_RESET_WARNING: at most one row per (user, period).
CREATE UNIQUE INDEX uq_notifications_reset_warning ON notifications(user_id, period_index)
  WHERE type = 'MAINTENANCE_RESET_WARNING';
