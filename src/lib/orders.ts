// Orders repository: creation (with the PENDING cap), lookups, listing, and the approve/reject
// batches that atomically flip status and emit F-wallet bonuses (tech-spec §6.1).
import { MAX_PENDING_ORDERS, POINTS } from '../domain/points/constants'
import type { OrderStatus } from '../domain/points/types'
import { notifyOrderApproved, notifyOrderCreated, notifyCustomerReferralBonus, notifyOrderRejected } from './notifications'

export interface OrderRow {
  id: string
  user_id: string
  note: string | null
  status: OrderStatus
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

export interface Order {
  id: string
  userId: string
  note: string | null
  status: OrderStatus
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
}

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    userId: row.user_id,
    note: row.note,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  }
}

export function findOrderById(db: D1Database, id: string): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>()
}

/** Ownership baked into SQL: a foreign id returns null → the route maps to 404 (no leak, §10). */
export function findOrderByIdForUser(db: D1Database, id: string, userId: string): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(id, userId).first<OrderRow>()
}

export type CreateOrderResult = { ok: true; order: Order } | { ok: false; error: 'PENDING_LIMIT' }

/** Create a PENDING order, guarded so a user never exceeds MAX_PENDING_ORDERS concurrent ones (A9). */
export async function createOrder(
  db: D1Database,
  userId: string,
  note: string | null,
  now: string,
): Promise<CreateOrderResult> {
  const id = crypto.randomUUID()
  // One batch: the guarded order INSERT + the admin's ORDER_CREATED notification. The notification
  // is an INSERT-SELECT over the order just written, so if the pending-cap guard rejected the order
  // (0 rows) the notification also writes nothing — no orphan alert for an order that never existed.
  const [orderRes] = await db.batch([
    db
      .prepare(
        `INSERT INTO orders (id, user_id, note, status, created_at)
         SELECT ?, ?, ?, 'PENDING', ?
         WHERE (SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'PENDING') < ?`,
      )
      .bind(id, userId, note, now, userId, MAX_PENDING_ORDERS),
    notifyOrderCreated(db, id, note, now),
  ])

  if (orderRes.meta.changes === 0) return { ok: false, error: 'PENDING_LIMIT' }
  return {
    ok: true,
    order: { id, userId, note, status: 'PENDING', decidedBy: null, decidedAt: null, createdAt: now },
  }
}

export interface OrderFilter {
  userId?: string // admin filter; omitted = all users
  status?: OrderStatus
  page: number
  limit: number
}

export async function listOrders(db: D1Database, filter: OrderFilter): Promise<{ rows: OrderRow[]; total: number }> {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.userId) {
    where.push('user_id = ?')
    args.push(filter.userId)
  }
  if (filter.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>()

  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(`SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...args, filter.limit, offset)
    .all<OrderRow>()

  return { rows: results, total: totalRow?.n ?? 0 }
}

export type DecideResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'ALREADY_DECIDED'; status: OrderStatus }

/**
 * Reject: flip PENDING→REJECTED, no ledger rows. One guarded UPDATE; changes===0 means the order
 * is gone or already decided.
 */
export async function rejectOrder(db: D1Database, orderId: string, adminId: string, now: string): Promise<DecideResult> {
  // Read the note upfront for the notification copy; the SQL guard below (status = 'PENDING') stays
  // the authority against races. A missing order short-circuits before we build a batch.
  const existing = await findOrderById(db, orderId)
  if (!existing) return { ok: false, error: 'NOT_FOUND' }

  const [flip] = await db.batch([
    db
      .prepare(`UPDATE orders SET status = 'REJECTED', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'`)
      .bind(adminId, now, orderId),
    // Chained on our own flip (status = 'REJECTED' AND decided_at = ?now): a double-reject writes 0.
    notifyOrderRejected(db, orderId, existing.note, now),
  ])
  return finishDecision(db, orderId, flip.meta.changes)
}

/**
 * Approve: one batch that flips status and pays +50 (creator) / +10 (referrer, if any). S2/S3 are
 * conditional inserts guarded on THIS batch's own flip (decided_at = our ?now), so a double-approve
 * writes zero rows and every point row is chained to exactly one real flip (tech-spec §6.1).
 */
export async function approveOrder(db: D1Database, orderId: string, adminId: string, now: string): Promise<DecideResult> {
  // Note for the notification copy; SQL guards remain the authority. Short-circuit a missing order.
  const existing = await findOrderById(db, orderId)
  if (!existing) return { ok: false, error: 'NOT_FOUND' }

  const results = await db.batch([
    // S1: flip status, guarded on PENDING
    db
      .prepare(`UPDATE orders SET status = 'APPROVED', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'`)
      .bind(adminId, now, orderId),
    // S2: +50 to the creator
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         SELECT ?, o.user_id, 'F', 'CUSTOMER_REWARD', ?, o.id, ?
         FROM orders o WHERE o.id = ? AND o.status = 'APPROVED' AND o.decided_at = ?`,
      )
      .bind(crypto.randomUUID(), POINTS.CUSTOMER_REWARD, now, orderId, now),
    // S3: +10 to the direct referrer — only when the creator has one AND that referrer is a USER.
    // A SUPER_ADMIN referrer records the link but earns no points (A2); the JOIN to r also excludes
    // a null referrer_id. Deactivated USER referrers still earn (A3), so is_active is not filtered.
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         SELECT ?, r.id, 'F', 'CUSTOMER_REFERRAL_BONUS', ?, o.id, ?
         FROM orders o
         JOIN users u ON u.id = o.user_id
         JOIN users r ON r.id = u.referrer_id
         WHERE o.id = ? AND o.status = 'APPROVED' AND o.decided_at = ? AND r.role = 'USER'`,
      )
      .bind(crypto.randomUUID(), POINTS.CUSTOMER_REFERRAL, now, orderId, now),
    // N1: ORDER_APPROVED → creator, chained on our flip (writes 0 on a double-approve).
    notifyOrderApproved(db, orderId, existing.note, now),
    // N2: CUSTOMER_REFERRAL_BONUS → referrer, chained on S3's ledger row (fires iff the +10 was paid).
    notifyCustomerReferralBonus(db, orderId, now),
  ])
  return finishDecision(db, orderId, results[0].meta.changes)
}

// Shared tail: on a successful flip re-read the row; otherwise classify NOT_FOUND vs ALREADY_DECIDED.
async function finishDecision(db: D1Database, orderId: string, flipped: number): Promise<DecideResult> {
  const row = await findOrderById(db, orderId)
  if (!row) return { ok: false, error: 'NOT_FOUND' }
  if (flipped === 1) return { ok: true, order: toOrder(row) }
  return { ok: false, error: 'ALREADY_DECIDED', status: row.status }
}
