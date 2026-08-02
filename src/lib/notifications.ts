// Notifications repository. Two concerns:
//   1. Read/mutate the inbox (list, unread-count, mark-read) for the API routes.
//   2. Build guarded INSERT statements that callers append to THEIR event batch, so a notification
//      is written atomically with — and only if — its triggering order flip / ledger row commits.
//
// Every builder is an INSERT ... SELECT whose FROM/WHERE is the triggering row itself. If that row
// wasn't written (guard failed, cap hit, cron-overlap rollback, double-decide), the SELECT yields
// zero rows and no notification is created — no orphans, no duplicates. The recipient is derived
// inside SQL from the same row (order creator, ledger beneficiary, or the singleton super admin).
//
// EXCEPTION: notifyMaintenanceResetWarning is a plain time-based INSERT with no triggering row,
// guarded only by a UNIQUE index at the DB layer (see its own comment for details).
import type { NotificationContent, NotificationType } from '../domain/notifications/types'
import {
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  maintenanceResetWarningMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../domain/notifications/messages'

// Raw DB row (snake_case).
export interface NotificationRow {
  id: string
  user_id: string
  type: NotificationType
  title: string
  body: string
  order_id: string | null
  ledger_id: string | null
  read_at: string | null
  created_at: string
}

// Public, camelCased shape returned to clients.
export interface Notification {
  id: string
  userId: string
  type: NotificationType
  title: string
  body: string
  orderId: string | null
  ledgerId: string | null
  read: boolean
  readAt: string | null
  createdAt: string
}

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    orderId: row.order_id,
    ledgerId: row.ledger_id,
    read: row.read_at !== null,
    readAt: row.read_at,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Inbox queries (all self-scoped: userId comes from the session, never the client).
// ---------------------------------------------------------------------------

export interface ListNotificationsFilter {
  userId: string
  unreadOnly?: boolean
  page: number
  limit: number
}

export async function listNotifications(
  db: D1Database,
  filter: ListNotificationsFilter,
): Promise<{ rows: NotificationRow[]; total: number }> {
  const where = ['user_id = ?']
  const args: unknown[] = [filter.userId]
  if (filter.unreadOnly) where.push('read_at IS NULL')
  const whereSql = `WHERE ${where.join(' AND ')}`

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM notifications ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>()

  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(`SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...args, filter.limit, offset)
    .all<NotificationRow>()

  return { rows: results, total: totalRow?.n ?? 0 }
}

export async function unreadCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Mark one notification read. Ownership is baked into the WHERE, so a foreign id changes nothing
 *  (the route maps 0 rows → 404). Idempotent: re-marking an already-read row is a no-op. */
export async function markRead(db: D1Database, userId: string, id: string, now: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`)
    .bind(now, id, userId)
    .run()
  if (res.meta.changes === 1) return true
  // Distinguish "already read" (exists, owned) from "not mine / missing": both are success-ish for
  // the client, but the route wants a 404 only when the row truly isn't the caller's.
  const exists = await db
    .prepare(`SELECT 1 AS x FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first()
  return exists !== null
}

/** Mark every unread notification of a user read. Returns how many were flipped. */
export async function markAllRead(db: D1Database, userId: string, now: string): Promise<number> {
  const res = await db
    .prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`)
    .bind(now, userId)
    .run()
  return res.meta.changes
}

// ---------------------------------------------------------------------------
// Guarded INSERT builders — appended to the triggering event's batch.
// ---------------------------------------------------------------------------

// A point-event notification: recipient = the ledger row's beneficiary (user_id); linkage = that
// row's id. Selected by `whereSql` over point_ledger, so it fires iff that row committed.
function ledgerNotif(
  db: D1Database,
  args: { type: NotificationType; content: NotificationContent; whereSql: string; binds: unknown[] },
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, ledger_id, created_at)
       SELECT ?, l.user_id, ?, ?, ?, l.id, ?
       FROM point_ledger l WHERE ${args.whereSql}`,
    )
    .bind(crypto.randomUUID(), args.type, args.content.title, args.content.body, now, ...args.binds)
}

/** REFERRAL_SIGNUP_BONUS → the referrer. Identified by the unique (subject_user_id, type) row for
 *  the new registrant (index R2). Fires only when a referral bonus was actually paid. */
export function notifyReferralSignupBonus(db: D1Database, newUserId: string, now: string): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'REFERRAL_SIGNUP_BONUS',
      content: referralSignupBonusMessage(),
      whereSql: `l.subject_user_id = ? AND l.type = 'REFERRAL_SIGNUP_BONUS'`,
      binds: [newUserId],
    },
    now,
  )
}

/** CUSTOMER_REFERRAL_BONUS → the referrer. Identified by the unique (order_id, type) row (index R1).
 *  Fires only when the +10 leg was paid (i.e. the referrer is a USER). */
export function notifyCustomerReferralBonus(db: D1Database, orderId: string, now: string): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'CUSTOMER_REFERRAL_BONUS',
      content: customerReferralBonusMessage(),
      whereSql: `l.order_id = ? AND l.type = 'CUSTOMER_REFERRAL_BONUS'`,
      binds: [orderId],
    },
    now,
  )
}

/** MAINTENANCE_ACCRUAL / MAINTENANCE_RESET → the user, linked to the specific ledger row by id. */
export function notifyMaintenance(
  db: D1Database,
  ledgerId: string,
  kind: 'MAINTENANCE_ACCRUAL' | 'MAINTENANCE_RESET',
  periodIndex: number,
  now: string,
): D1PreparedStatement {
  const content = kind === 'MAINTENANCE_ACCRUAL' ? maintenanceAccrualMessage(periodIndex) : maintenanceResetMessage(periodIndex)
  return ledgerNotif(db, { type: kind, content, whereSql: `l.id = ?`, binds: [ledgerId] }, now)
}

/** REDEMPTION → the user, linked to the first redemption ledger row (whichever wallet). */
export function notifyRedemption(db: D1Database, firstLedgerId: string, f: number, g: number, now: string): D1PreparedStatement {
  return ledgerNotif(
    db,
    { type: 'REDEMPTION', content: redemptionMessage(f, g), whereSql: `l.id = ?`, binds: [firstLedgerId] },
    now,
  )
}

/** REDEMPTION (custom copy) → the CTV, linked to the redemption row `activateCustomer()`
 *  creates. Reuses the REDEMPTION type deliberately — no new NotificationType needed, and
 *  the CTV's own client already renders REDEMPTION notifications correctly. */
export function notifyCustomerActivated(
  db: D1Database,
  redemptionLedgerId: string,
  fullName: string,
  orderCode: string,
  paidF: number,
  paidG: number,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'REDEMPTION',
      content: customerActivatedMessage(fullName, orderCode, paidF, paidG),
      whereSql: `l.id = ?`,
      binds: [redemptionLedgerId],
    },
    now,
  )
}

/** MAINTENANCE_RESET_WARNING → the user. Unlike every other builder here, there's no triggering
 *  table row to SELECT from — it's a time-based projection the maintenance cron computes, so this
 *  is a plain INSERT. Idempotency (once per user per period) is enforced by the UNIQUE index
 *  uq_notifications_reset_warning; the caller (lib/maintenance.ts) catches that violation. */
export function notifyMaintenanceResetWarning(
  db: D1Database,
  userId: string,
  periodIndex: number,
  now: string,
): D1PreparedStatement {
  const content = maintenanceResetWarningMessage(periodIndex)
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, period_index, created_at)
       VALUES (?, ?, 'MAINTENANCE_RESET_WARNING', ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), userId, content.title, content.body, periodIndex, now)
}
