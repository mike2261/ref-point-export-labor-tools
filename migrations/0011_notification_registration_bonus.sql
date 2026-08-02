-- Add REGISTRATION_BONUS to the notification taxonomy: notify a new USER of their own +100 F
-- signup bonus (previously silent — only the referrer's REFERRAL_SIGNUP_BONUS was notified).
-- Recipient = subject: the ledger row's user_id IS the new registrant, so this reuses the plain
-- ledgerNotif() shape (no subject_user_id indirection needed, unlike REFERRAL_SIGNUP_BONUS).
--
-- CHECK constraints can't be altered in place, so this is a table rebuild, same technique as 0006/0009.

CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
                 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'MAINTENANCE_RESET_WARNING',
                 'REDEMPTION')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  order_id     TEXT REFERENCES orders(id),
  ledger_id    TEXT REFERENCES point_ledger(id),
  period_index INTEGER CHECK (period_index >= 1),
  read_at      TEXT,
  created_at   TEXT NOT NULL,

  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION'))),
  CHECK ((period_index IS NOT NULL) = (type = 'MAINTENANCE_RESET_WARNING'))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE UNIQUE INDEX uq_notifications_reset_warning ON notifications(user_id, period_index)
  WHERE type = 'MAINTENANCE_RESET_WARNING';
