-- Order lifecycle rebuild (design: docs/superpowers/specs/2026-07-25-order-lifecycle-design.md).
-- One order = one real person going abroad for labor export (no separate customer entity —
-- there's nothing to reuse across orders). order_code/activation_code are typed in by the CTV,
-- not system-generated; the admin cross-checks their validity against records outside this
-- system before approve/reject.
--
-- D1 enforces foreign keys unconditionally — `PRAGMA foreign_keys = OFF` is silently ignored
-- (confirmed: `PRAGMA foreign_keys` still reads back 1 after setting it), so the textbook SQLite
-- "12-step" table rebuild (which relies on disabling FK checks around a drop+rename) does not
-- work here. A bare `DROP TABLE orders` fails the moment any point_ledger row exists, since
-- point_ledger.order_id references it. Instead, point_ledger is rebuilt alongside orders so that
-- at the moment each old table is dropped, nothing live still points at it:
--   1. build orders_new + point_ledger_new (the latter pointed at orders_new)
--   2. drop point_ledger (nothing references point_ledger — always safe)
--   3. drop orders (point_ledger, its only referrer, is already gone — now safe)
--   4. rename both new tables into place (SQLite auto-rewrites point_ledger_new's
--      REFERENCES orders_new(id) to REFERENCES orders(id) when orders_new is renamed to orders)

CREATE TABLE orders_new (
  id              TEXT PRIMARY KEY,                    -- UUID
  user_id         TEXT NOT NULL REFERENCES users(id),  -- creator (CTV), unchanged
  full_name       TEXT NOT NULL,                        -- the person going abroad
  phone           TEXT NOT NULL,
  order_code      TEXT NOT NULL,                        -- typed by the CTV; not unique/generated
  activation_code TEXT NOT NULL,                        -- typed by the CTV; not unique/generated
  note            TEXT,                                 -- optional, <= 500 chars (API-enforced)
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'PENDING', 'NEEDS_REVISION', 'APPROVED', 'REJECTED')),
  revision_reason TEXT,                                 -- admin's reason, set iff NEEDS_REVISION
  decided_by      TEXT REFERENCES users(id),            -- the super admin who approved/rejected
  decided_at      TEXT,                                 -- ISO 8601 UTC
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- decision fields are set iff the order reached a terminal decided state
  CHECK ((status IN ('APPROVED', 'REJECTED')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- revision_reason is set iff the order is currently kicked back for a fix
  CHECK ((status = 'NEEDS_REVISION') = (revision_reason IS NOT NULL))
);

-- Carry over pre-lifecycle rows. They had no name/phone/codes — backfilled with an unmistakable
-- placeholder rather than silently dropped; their status/decision fields map straight across
-- (old statuses PENDING/APPROVED/REJECTED are a subset of the new set).
INSERT INTO orders_new
  (id, user_id, full_name, phone, order_code, activation_code, note, status, decided_by, decided_at, created_at, updated_at)
SELECT
  id, user_id,
  '(chưa có dữ liệu — đơn tạo trước bản cập nhật này)',
  '',
  'LEGACY-' || substr(id, 1, 8),
  'LEGACY-' || substr(id, 1, 8),
  note, status, decided_by, decided_at, created_at, created_at
FROM orders;

-- Verbatim copy of point_ledger's schema (migrations/0003_create_point_ledger.sql) — only
-- order_id's REFERENCES target changes, to orders_new. Every CHECK/column must match exactly;
-- this is not a redesign, just a forced rebuild to satisfy D1's unconditional FK enforcement.
CREATE TABLE point_ledger_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wallet          TEXT NOT NULL CHECK (wallet IN ('F', 'G')),
  type            TEXT NOT NULL CHECK (type IN (
                    'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
                    'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET',
                    'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION')),
  points          INTEGER NOT NULL CHECK (points <> 0),
  order_id        TEXT REFERENCES orders_new(id),
  subject_user_id TEXT REFERENCES users(id),
  period_index    INTEGER CHECK (period_index >= 1),
  idempotency_key TEXT,
  note            TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,

  CHECK ((points > 0) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
         'MAINTENANCE_ACCRUAL', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK (CASE
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET') THEN wallet = 'G'
    WHEN type = 'REDEMPTION' THEN 1
    ELSE wallet = 'F' END),
  CHECK ((order_id        IS NOT NULL) = (type IN ('CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK ((subject_user_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS'))),
  CHECK ((period_index    IS NOT NULL) = (type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET'))),
  CHECK ((idempotency_key IS NOT NULL) = (type = 'REDEMPTION'))
);

INSERT INTO point_ledger_new
  (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at)
SELECT
  id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at
FROM point_ledger;

DROP TABLE point_ledger;
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
ALTER TABLE point_ledger_new RENAME TO point_ledger;

CREATE INDEX idx_orders_user_created   ON orders(user_id, created_at);    -- user's own list
CREATE INDEX idx_orders_status_created ON orders(status, created_at);     -- admin queue
-- rolling-window lookups: "APPROVED orders of user X decided in [a, b)"
CREATE INDEX idx_orders_user_approved  ON orders(user_id, decided_at) WHERE status = 'APPROVED';

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

-- Append-only history of order state transitions (not edits) — who approved/rejected/requested a
-- fix, and why, distinct from the mutable orders row itself.
CREATE TABLE order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  type       TEXT NOT NULL CHECK (type IN ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED')),
  actor_id   TEXT NOT NULL REFERENCES users(id),
  reason     TEXT,                                      -- REVISION_REQUESTED only
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
