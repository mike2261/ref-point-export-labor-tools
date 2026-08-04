-- Wallet A/B/C split (design: docs/superpowers/specs/2026-08-05-wallet-abc-split-design.md).
-- Replaces the F/G wallet pair with three:
--   A — referral commission (CUSTOMER_REFERRAL_BONUS): never auto-drains, admin settles it
--       out-of-band.
--   B — own registration + own customer reward (REGISTRATION_BONUS, CUSTOMER_REWARD): auto-drains
--       to 0 the moment the CTV activates their own customer (unchanged "settle on activation"
--       behavior, just renamed from F).
--   C — admin bonus (ADMIN_BONUS) and the dead MAINTENANCE_ACCRUAL/MAINTENANCE_RESET types: same
--       auto-drain behavior, renamed from G.
-- REFERRAL_SIGNUP_BONUS (earning points just for referring someone who registers, before they
-- land a customer) is removed entirely — "mồi CTV" no longer earns anything on its own.
--
-- Precondition: point_ledger and notifications are EMPTY when this runs (all app data is wiped,
-- locally and in production, before/alongside this migration — see the design doc). The
-- INSERT...SELECT below is kept for parity with the table-rebuild technique used elsewhere
-- (0006/0009/0011/0012) and doubles as a safety net: if this is ever run against non-empty tables
-- still holding old F/G rows, the new CHECK constraints reject them and the migration fails loudly
-- instead of silently mis-migrating money.
--
-- CHECK constraints can't be altered in place, so point_ledger and notifications are rebuilt.

CREATE TABLE point_ledger_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wallet          TEXT NOT NULL CHECK (wallet IN ('A', 'B', 'C')),
  type            TEXT NOT NULL CHECK (type IN (
                    'REGISTRATION_BONUS',
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

  CHECK ((points > 0) = (type IN ('REGISTRATION_BONUS',
         'MAINTENANCE_ACCRUAL', 'ADMIN_BONUS', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK (CASE
    WHEN type = 'CUSTOMER_REFERRAL_BONUS' THEN wallet = 'A'
    WHEN type IN ('REGISTRATION_BONUS', 'CUSTOMER_REWARD') THEN wallet = 'B'
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS') THEN wallet = 'C'
    WHEN type = 'REDEMPTION' THEN 1
    END),
  CHECK ((order_id        IS NOT NULL) = (type IN ('CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK ((subject_user_id IS NOT NULL) = (type = 'REGISTRATION_BONUS')),
  CHECK ((period_index    IS NOT NULL) = (type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET'))),
  CHECK ((bonus_grant_id  IS NOT NULL) = (type = 'ADMIN_BONUS')),
  CHECK ((idempotency_key IS NOT NULL) = (type = 'REDEMPTION'))
);

INSERT INTO point_ledger_new
  (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, bonus_grant_id, idempotency_key, note, created_by, created_at)
SELECT
  id, user_id, wallet, type, points, order_id, subject_user_id, period_index, bonus_grant_id, idempotency_key, note, created_by, created_at
FROM point_ledger;

CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REGISTRATION_BONUS', 'CUSTOMER_REFERRAL_BONUS',
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
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'CUSTOMER_REFERRAL_BONUS',
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
