-- Order lifecycle rebuild (design: docs/superpowers/specs/2026-07-25-order-lifecycle-design.md).
-- Adds customers + order_events, and gives orders a real state machine, a human-readable order
-- code, and a per-order activation code. Tests always start from a fresh, fully-migrated DB
-- (test/apply-migrations.ts calls reset() first), so this is a clean rebuild, not a data migration.

-- Customers: CTV-scoped ("who did this CTV refer"), found-or-created by (ctv_id, phone) so a
-- retried submission for the same person reuses one row (design decision #3).
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,                     -- UUID
  ctv_id        TEXT NOT NULL REFERENCES users(id),
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL,
  date_of_birth TEXT,                                  -- ISO date, optional
  market        TEXT,                                  -- thị trường/ngành nghề, optional free text
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_customers_ctv_phone ON customers(ctv_id, phone);
CREATE INDEX idx_customers_ctv ON customers(ctv_id, created_at);

-- Orders: rebuilt from the 0002 version. New columns: customer_id, order_code,
-- activation_code, revision_reason, updated_at. Status gains DRAFT and NEEDS_REVISION
-- (design's state machine).
DROP TABLE orders;
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,                    -- UUID
  user_id         TEXT NOT NULL REFERENCES users(id),  -- creator = beneficiary (PRD §6.3)
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  order_code      TEXT NOT NULL UNIQUE,                 -- XKLD-<YYYYMM>-<6-digit seq>
  activation_code TEXT NOT NULL UNIQUE,                 -- opaque token; "used" iff APPROVED
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

CREATE INDEX idx_orders_user_created    ON orders(user_id, created_at);    -- user's own list
CREATE INDEX idx_orders_status_created  ON orders(status, created_at);     -- admin queue
CREATE INDEX idx_orders_customer        ON orders(customer_id, created_at);
-- rolling-window lookups: "APPROVED orders of user X decided in [a, b)"
CREATE INDEX idx_orders_user_approved   ON orders(user_id, decided_at) WHERE status = 'APPROVED';
-- one real payout per customer, ever (design: "One approved order per customer")
CREATE UNIQUE INDEX uq_orders_customer_approved ON orders(customer_id) WHERE status = 'APPROVED';

-- Append-only history of state transitions (not edits) — the audit trail the report requires.
CREATE TABLE order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  type       TEXT NOT NULL CHECK (type IN ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED')),
  actor_id   TEXT NOT NULL REFERENCES users(id),
  reason     TEXT,                                      -- REVISION_REQUESTED only
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
