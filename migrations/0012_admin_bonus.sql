-- Admin-triggered point bonus (design: docs/superpowers/specs/2026-08-03-admin-point-bonus-design.md).
-- Replaces the monthly maintenance cron entirely: the admin now grants G-wallet points on demand,
-- to every CTV at once or to one CTV by phone, with a message explaining why. Points no longer
-- expire or reset — MAINTENANCE_ACCRUAL/MAINTENANCE_RESET stay valid for existing history, but
-- nothing writes them anymore.
--
-- bonus_grants is the audit/idempotency record for one admin action (one broadcast or one
-- individual grant); point_ledger.bonus_grant_id links each resulting ADMIN_BONUS row back to it,
-- the same way order_id/subject_user_id/period_index link other row kinds to their trigger.
--
-- CHECK constraints can't be altered in place, so point_ledger and notifications are rebuilt, same
-- technique as migrations 0005/0006/0009/0011. bonus_grants only references users(id), which isn't
-- being rebuilt, so it's created first, plain.

CREATE TABLE bonus_grants (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('ALL', 'PHONE')),
  target_user_id  TEXT REFERENCES users(id),   -- set iff scope = 'PHONE'
  amount          INTEGER NOT NULL CHECK (amount > 0),
  content         TEXT NOT NULL,               -- admin-authored message, shown to recipients
  recipient_count INTEGER NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,

  CHECK ((target_user_id IS NOT NULL) = (scope = 'PHONE'))
);

CREATE UNIQUE INDEX uq_bonus_grants_idem ON bonus_grants(idempotency_key);
CREATE INDEX idx_bonus_grants_created ON bonus_grants(created_at, id);

-- point_ledger rebuild: add ADMIN_BONUS (credit, G-only, requires bonus_grant_id) alongside the
-- existing types. order_id still references the live `orders` table (untouched by this migration).
CREATE TABLE point_ledger_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wallet          TEXT NOT NULL CHECK (wallet IN ('F', 'G')),
  type            TEXT NOT NULL CHECK (type IN (
                    'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
                    'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS',
                    'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION')),
  points          INTEGER NOT NULL CHECK (points <> 0),
  order_id        TEXT REFERENCES orders(id),
  subject_user_id TEXT REFERENCES users(id),
  period_index    INTEGER CHECK (period_index >= 1),
  bonus_grant_id  TEXT REFERENCES bonus_grants(id),
  idempotency_key TEXT,
  note            TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,

  CHECK ((points > 0) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
         'MAINTENANCE_ACCRUAL', 'ADMIN_BONUS', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK (CASE
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS') THEN wallet = 'G'
    WHEN type = 'REDEMPTION' THEN 1
    ELSE wallet = 'F' END),
  CHECK ((order_id        IS NOT NULL) = (type IN ('CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK ((subject_user_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS'))),
  CHECK ((period_index    IS NOT NULL) = (type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET'))),
  CHECK ((bonus_grant_id  IS NOT NULL) = (type = 'ADMIN_BONUS')),
  CHECK ((idempotency_key IS NOT NULL) = (type = 'REDEMPTION'))
);

INSERT INTO point_ledger_new
  (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at)
SELECT
  id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at
FROM point_ledger;

-- notifications rebuild: add ADMIN_BONUS, always ledger-linked like MAINTENANCE_ACCRUAL. Must
-- reference point_ledger_new (not yet renamed) — same forward-reference technique as 0005.
CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
                 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'MAINTENANCE_RESET_WARNING',
                 'ADMIN_BONUS', 'REDEMPTION')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  order_id     TEXT REFERENCES orders(id),
  ledger_id    TEXT REFERENCES point_ledger_new(id),
  period_index INTEGER CHECK (period_index >= 1),
  read_at      TEXT,
  created_at   TEXT NOT NULL,

  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS', 'REDEMPTION'))),
  CHECK ((period_index IS NOT NULL) = (type = 'MAINTENANCE_RESET_WARNING'))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at
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
CREATE INDEX idx_ledger_bonus_grant ON point_ledger(bonus_grant_id) WHERE bonus_grant_id IS NOT NULL;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX uq_notifications_reset_warning ON notifications(user_id, period_index)
  WHERE type = 'MAINTENANCE_RESET_WARNING';
