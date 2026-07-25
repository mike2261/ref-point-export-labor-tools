-- Notifications: one row per delivered message (PRD §6.3). Stores recipient, title/body, type,
-- the related object (an order OR a ledger row), read state, and time. Rows are written ONLY inside
-- the same D1 batch as the event that triggers them (order flip / ledger insert), so a notification
-- can never outlive a rolled-back or no-op mutation, and vice versa (mirrors the point-ledger design).
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,                       -- UUID
  user_id    TEXT NOT NULL REFERENCES users(id),     -- recipient (người nhận)
  type       TEXT NOT NULL CHECK (type IN (
               'ORDER_CREATED',            -- → admin: a new order awaits verification
               'ORDER_APPROVED',           -- → CTV: their order was approved
               'ORDER_REJECTED',           -- → CTV: their order was rejected
               'REFERRAL_SIGNUP_BONUS',    -- → referrer CTV: +2 F, someone they referred registered
               'CUSTOMER_REFERRAL_BONUS',  -- → referrer CTV: +10 F, their referee's order approved
               'MAINTENANCE_ACCRUAL',      -- → CTV: monthly +10 G (the G-wallet cycle reminder)
               'MAINTENANCE_RESET',        -- → CTV: G wallet reset to 0
               'REDEMPTION')),             -- → CTV: admin deducted points
  title      TEXT NOT NULL,                           -- tiêu đề
  body       TEXT NOT NULL,                           -- nội dung
  order_id   TEXT REFERENCES orders(id),              -- related object for ORDER_* types
  ledger_id  TEXT REFERENCES point_ledger(id),        -- related object for point-event types
  read_at    TEXT,                                    -- NULL = unread; ISO 8601 UTC when read
  created_at TEXT NOT NULL,                           -- thời gian (ISO 8601 UTC)

  -- linkage discipline: ORDER_* rows carry an order_id; every point-event row carries a ledger_id.
  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION')))
);

-- Inbox pagination: newest first, (created_at DESC, id DESC) with id as the stable tiebreak.
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
-- Unread badge: a partial index keeps the unread-count query off the full table.
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
