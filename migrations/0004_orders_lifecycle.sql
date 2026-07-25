-- Order lifecycle rebuild (design: docs/superpowers/specs/2026-07-25-order-lifecycle-design.md).
-- One order = one real person going abroad for labor export (no separate customer entity —
-- there's nothing to reuse across orders). order_code/activation_code are typed in by the CTV,
-- not system-generated; the admin cross-checks their validity against records outside this
-- system before approve/reject. Tests always start from a fresh, fully-migrated DB
-- (test/apply-migrations.ts calls reset() first), so this is a clean rebuild, not a data migration.

DROP TABLE orders;
CREATE TABLE orders (
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

CREATE INDEX idx_orders_user_created   ON orders(user_id, created_at);    -- user's own list
CREATE INDEX idx_orders_status_created ON orders(status, created_at);     -- admin queue
-- rolling-window lookups: "APPROVED orders of user X decided in [a, b)"
CREATE INDEX idx_orders_user_approved  ON orders(user_id, decided_at) WHERE status = 'APPROVED';

-- Append-only history of state transitions (not edits) — who approved/rejected/requested a fix,
-- and why, distinct from the mutable orders row itself.
CREATE TABLE order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  type       TEXT NOT NULL CHECK (type IN ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED')),
  actor_id   TEXT NOT NULL REFERENCES users(id),
  reason     TEXT,                                      -- REVISION_REQUESTED only
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
