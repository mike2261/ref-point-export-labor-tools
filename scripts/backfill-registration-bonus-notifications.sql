-- One-off backfill: notifyRegistrationBonus() only started firing once wired into createUser()
-- (2026-08), so every USER created before that already holds a REGISTRATION_BONUS point_ledger
-- row but never got the notification. This inserts one now for each such row.
--
-- Safe to re-run: skipped when a REGISTRATION_BONUS notification already exists for that ledger
-- row (covers both a prior backfill run and users who registered normally after the feature
-- shipped, whose notification was already written atomically by createUser()).
--
-- created_at is set to "now" (not the original registration time) so the backfilled notice
-- surfaces as a fresh, unread item at the top of the user's inbox instead of being buried under
-- months of later activity.
--
--   npx wrangler d1 execute xkld-db --local  --file=scripts/backfill-registration-bonus-notifications.sql
--   npx wrangler d1 execute xkld-db --remote --file=scripts/backfill-registration-bonus-notifications.sql

INSERT INTO notifications (id, user_id, type, title, body, ledger_id, created_at)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
  ),
  l.user_id,
  'REGISTRATION_BONUS',
  'Bạn nhận điểm đăng ký',
  'Chào mừng bạn đến với hệ thống. Bạn được cộng 100 điểm cá nhân.',
  l.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM point_ledger l
WHERE l.type = 'REGISTRATION_BONUS'
  AND NOT EXISTS (
    SELECT 1 FROM notifications n WHERE n.ledger_id = l.id AND n.type = 'REGISTRATION_BONUS'
  );
