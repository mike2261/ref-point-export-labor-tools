-- Add manual Super Admin credits to wallet G. D1 cannot alter CHECK constraints in place,
-- and notifications references point_ledger, so both tables are rebuilt together.

CREATE TABLE point_ledger_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wallet          TEXT NOT NULL CHECK (wallet IN ('F', 'G')),
  type            TEXT NOT NULL CHECK (type IN (
                    'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
                    'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET',
                    'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS',
                    'ADMIN_BONUS', 'REDEMPTION')),
  points          INTEGER NOT NULL CHECK (points <> 0),
  order_id        TEXT REFERENCES orders(id),
  subject_user_id TEXT REFERENCES users(id),
  period_index    INTEGER CHECK (period_index >= 1),
  idempotency_key TEXT,
  note            TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,

  CHECK ((points > 0) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
         'MAINTENANCE_ACCRUAL', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'ADMIN_BONUS'))),
  CHECK (CASE
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS') THEN wallet = 'G'
    WHEN type = 'REDEMPTION' THEN 1
    ELSE wallet = 'F' END),
  CHECK ((order_id        IS NOT NULL) = (type IN ('CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK ((subject_user_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS'))),
  CHECK ((period_index    IS NOT NULL) = (type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET'))),
  CHECK ((idempotency_key IS NOT NULL) = (type IN ('REDEMPTION', 'ADMIN_BONUS'))),
  CHECK (type != 'ADMIN_BONUS' OR (note IS NOT NULL AND created_by IS NOT NULL))
);

INSERT INTO point_ledger_new
  (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at)
SELECT
  id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at
FROM point_ledger;

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
  ledger_id  TEXT REFERENCES point_ledger_new(id),
  read_at    TEXT,
  created_at TEXT NOT NULL,

  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION')))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, read_at, created_at
FROM notifications;

DROP TABLE notifications;
DROP TABLE point_ledger;
ALTER TABLE point_ledger_new RENAME TO point_ledger;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE UNIQUE INDEX uq_ledger_order_type
  ON point_ledger(order_id, type) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_subject_type
  ON point_ledger(subject_user_id, type) WHERE subject_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_user_period_type
  ON point_ledger(user_id, period_index, type) WHERE period_index IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_idem
  ON point_ledger(idempotency_key, wallet) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_ledger_user_wallet_points ON point_ledger(user_id, wallet, points);
CREATE INDEX idx_ledger_user_created ON point_ledger(user_id, created_at, id);

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
