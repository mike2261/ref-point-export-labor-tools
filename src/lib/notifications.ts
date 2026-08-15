// Notifications repository. Two concerns:
//   1. Read/mutate the inbox (list, unread-count, mark-read) for the API routes.
//   2. Build guarded INSERT statements that callers append to THEIR event batch, so a notification
//      is written atomically with — and only if — its triggering order flip / ledger row commits.
//
// Every builder is an INSERT ... SELECT whose FROM/WHERE is the triggering row itself. If that row
// wasn't written (guard failed, cap hit, cron-overlap rollback, double-decide), the SELECT yields
// zero rows and no notification is created — no orphans, no duplicates. The recipient is derived
// inside SQL from the same row (order creator, ledger beneficiary, or the singleton super admin).
import type { NotificationContent, NotificationType } from '../domain/notifications/types'
import {
  registrationBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
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

/** REGISTRATION_BONUS → the new registrant themselves. Recipient IS the ledger row's user_id,
 *  identified by the unique (user_id, type) row every new USER gets on creation. */
export function notifyRegistrationBonus(db: D1Database, newUserId: string, now: string): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'REGISTRATION_BONUS',
      content: registrationBonusMessage(),
      whereSql: `l.user_id = ? AND l.type = 'REGISTRATION_BONUS'`,
      binds: [newUserId],
    },
    now,
  )
}

/** CUSTOMER_REFERRAL_BONUS → the referrer. Identified by the unique (order_id, type) row (index R1).
 *  Fires only when the +100 leg was paid (i.e. the referrer is a USER). `ctvFullName` is the name
 *  of the referred CTV who actually closed the customer, so the copy can say who earned it. */
export function notifyCustomerReferralBonus(
  db: D1Database,
  orderId: string,
  ctvFullName: string,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'CUSTOMER_REFERRAL_BONUS',
      content: customerReferralBonusMessage(ctvFullName),
      whereSql: `l.order_id = ? AND l.type = 'CUSTOMER_REFERRAL_BONUS'`,
      binds: [orderId],
    },
    now,
  )
}

/** ADMIN_BONUS → the user, linked to the specific ledger row by id. */
export function notifyAdminBonus(
  db: D1Database,
  ledgerId: string,
  amount: number,
  content: string,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    { type: 'ADMIN_BONUS', content: adminBonusMessage(amount, content), whereSql: `l.id = ?`, binds: [ledgerId] },
    now,
  )
}

/** REDEMPTION → the user, linked to the first redemption ledger row (whichever wallet). */
export function notifyRedemption(
  db: D1Database,
  firstLedgerId: string,
  a: number,
  b: number,
  c: number,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    { type: 'REDEMPTION', content: redemptionMessage(a, b, c), whereSql: `l.id = ?`, binds: [firstLedgerId] },
    now,
  )
}

/** Báo cho CTV khi admin kích hoạt một khách hàng của họ, gắn vào chính dòng cộng +500 của lần
 *  kích hoạt đó. Từ 15/08/2026 lần kích hoạt chỉ CỘNG tiền (không còn tất toán ví), nên nội dung
 *  chỉ nói về khoản được cộng. Vẫn mượn type 'REDEMPTION' — không cần thêm NotificationType mới,
 *  và client của CTV đã render loại này sẵn. */
export function notifyCustomerActivated(
  db: D1Database,
  rewardLedgerId: string,
  fullName: string,
  orderCode: string,
  credited: number,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'REDEMPTION',
      content: customerActivatedMessage(fullName, orderCode, credited),
      whereSql: `l.id = ?`,
      binds: [rewardLedgerId],
    },
    now,
  )
}
