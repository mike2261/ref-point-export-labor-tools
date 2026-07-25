-- Manual password recovery through the Super Admin. A reset installs a short-lived
-- temporary password and forces the USER to replace it before using the application.
ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_password IN (0, 1));
ALTER TABLE users ADD COLUMN temporary_password_expires_at TEXT;
ALTER TABLE users ADD COLUMN password_reset_by TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN password_reset_at TEXT;

-- A temporary-password expiry exists iff the account is waiting for a mandatory change.
-- SQLite cannot add this table-level CHECK through ALTER TABLE, so application code updates
-- the fields atomically and the audit table preserves every reset operation.
CREATE TABLE password_reset_log (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  phone_snapshot TEXT NOT NULL,
  admin_id       TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE INDEX idx_password_reset_log_user_created
  ON password_reset_log(user_id, created_at);
