-- Add ORDER_NEEDS_REVISION to the notification taxonomy (gap flagged in
-- docs/superpowers/specs/2026-07-25-order-lifecycle-design.md: the revision loop had no
-- notification, so a CTV only learned their order was kicked back by refreshing the page).
--
-- CHECK constraints can't be altered in place, so this is a table rebuild — but unlike the
-- orders/point_ledger rebuild in 0005, nothing holds a live FK reference INTO notifications
-- (it's a leaf table), so this one needs no multi-table dance: build the new table, copy rows,
-- drop the old one, rename into place.

CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL CHECK (type IN (
               'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
               'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
               'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  order_id   TEXT REFERENCES orders(id),
  ledger_id  TEXT REFERENCES point_ledger(id),
  read_at    TEXT,
  created_at TEXT NOT NULL,

  -- ORDER_NEEDS_REVISION carries an order_id, same as the other ORDER_* types.
  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION')))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
