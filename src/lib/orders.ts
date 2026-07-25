// Orders repository: the DRAFT→PENDING→NEEDS_REVISION→PENDING→APPROVED/REJECTED lifecycle
// (design: docs/superpowers/specs/2026-07-25-order-lifecycle-design.md). One order = one real
// person going abroad — fullName/phone/orderCode/activationCode are typed in by the CTV and
// re-checked by the admin against records outside this system; the app does not generate or
// dedupe them. Every transition is logged to order_events; approve additionally emits the
// F-wallet bonuses (tech-spec §6.1, unchanged).
import { MAX_PENDING_ORDERS, POINTS } from '../domain/points/constants'
import type { OrderStatus } from '../domain/points/types'
import { orderCreatedMessage } from '../domain/notifications/messages'
import { notifyCustomerReferralBonus, notifyOrderApproved, notifyOrderRejected } from './notifications'

export interface OrderRow {
  id: string
  user_id: string
  full_name: string
  phone: string
  order_code: string
  activation_code: string
  note: string | null
  status: OrderStatus
  revision_reason: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
  updated_at: string
}

export interface Order {
  id: string
  userId: string
  fullName: string
  phone: string
  orderCode: string
  activationCode: string
  note: string | null
  status: OrderStatus
  revisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    phone: row.phone,
    orderCode: row.order_code,
    activationCode: row.activation_code,
    note: row.note,
    status: row.status,
    revisionReason: row.revision_reason,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function findOrderById(db: D1Database, id: string): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>()
}

/** Ownership baked into SQL: a foreign id returns null → the route maps to 404 (no leak, §10). */
export function findOrderByIdForUser(db: D1Database, id: string, userId: string): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(id, userId).first<OrderRow>()
}

async function logEvent(
  db: D1Database,
  orderId: string,
  type: 'SUBMITTED' | 'REVISION_REQUESTED' | 'APPROVED' | 'REJECTED',
  actorId: string,
  reason: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare(`INSERT INTO order_events (id, order_id, type, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), orderId, type, actorId, reason, now)
    .run()
}

export interface CreateDraftInput {
  fullName: string
  phone: string
  orderCode: string
  activationCode: string
  note?: string | null
}

/** Create a DRAFT order. Not capped by MAX_PENDING_ORDERS — drafts aren't in anyone's queue yet;
 * the cap is enforced at submit time instead. */
export async function createDraftOrder(db: D1Database, userId: string, input: CreateDraftInput, now: string): Promise<Order> {
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO orders (id, user_id, full_name, phone, order_code, activation_code, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
    )
    .bind(id, userId, input.fullName, input.phone, input.orderCode, input.activationCode, input.note ?? null, now, now)
    .run()
  return toOrder((await findOrderById(db, id))!)
}

export interface UpdateOrderInput {
  fullName?: string
  phone?: string
  orderCode?: string
  activationCode?: string
  note?: string | null
}

export type UpdateResult = { ok: true; order: Order } | { ok: false; error: 'NOT_FOUND' | 'LOCKED' }

/** Edit any typed-in field. Only while DRAFT or NEEDS_REVISION — locked otherwise. */
export async function updateOrder(
  db: D1Database,
  orderId: string,
  userId: string,
  input: UpdateOrderInput,
  now: string,
): Promise<UpdateResult> {
  const row = await findOrderByIdForUser(db, orderId, userId)
  if (!row) return { ok: false, error: 'NOT_FOUND' }
  if (row.status !== 'DRAFT' && row.status !== 'NEEDS_REVISION') return { ok: false, error: 'LOCKED' }

  await db
    .prepare(`UPDATE orders SET full_name = ?, phone = ?, order_code = ?, activation_code = ?, note = ?, updated_at = ? WHERE id = ?`)
    .bind(
      input.fullName ?? row.full_name,
      input.phone ?? row.phone,
      input.orderCode ?? row.order_code,
      input.activationCode ?? row.activation_code,
      input.note !== undefined ? input.note : row.note,
      now,
      orderId,
    )
    .run()

  return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
}

export type SubmitResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'NOT_EDITABLE'; status: OrderStatus }
  | { ok: false; error: 'PENDING_LIMIT' }

/**
 * DRAFT|NEEDS_REVISION → PENDING, guarded by the same MAX_PENDING_ORDERS cap as before.
 * Fires ORDER_CREATED → the admin (same type/copy as the pre-lifecycle "order created" event;
 * "a new order awaits verification" is equally true for a first submit or a post-revision
 * resubmit). Unlike notifications.ts's own `notifyOrderCreated` — whose guard is just "the order
 * exists", correct for its original call site where the row is freshly INSERTed in the same
 * batch — the order here already exists beforehand, so the notification must instead be chained
 * on THIS batch's own flip (status = 'PENDING' AND updated_at = our ?now), or a blocked submit
 * (cap hit, race) would still fire a false "new order" alert.
 */
export async function submitOrder(db: D1Database, orderId: string, userId: string, now: string): Promise<SubmitResult> {
  const before = await findOrderByIdForUser(db, orderId, userId)
  if (!before) return { ok: false, error: 'NOT_FOUND' }
  if (before.status !== 'DRAFT' && before.status !== 'NEEDS_REVISION') {
    return { ok: false, error: 'NOT_EDITABLE', status: before.status }
  }

  const content = orderCreatedMessage(before.note)
  const [flip] = await db.batch([
    db
      .prepare(
        `UPDATE orders SET status = 'PENDING', revision_reason = NULL, updated_at = ?
         WHERE id = ? AND status IN ('DRAFT', 'NEEDS_REVISION')
           AND (SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'PENDING') < ?`,
      )
      .bind(now, orderId, userId, MAX_PENDING_ORDERS),
    db
      .prepare(
        `INSERT INTO notifications (id, user_id, type, title, body, order_id, created_at)
         SELECT ?, (SELECT id FROM users WHERE role = 'SUPER_ADMIN'), 'ORDER_CREATED', ?, ?, o.id, ?
         FROM orders o WHERE o.id = ? AND o.status = 'PENDING' AND o.updated_at = ?`,
      )
      .bind(crypto.randomUUID(), content.title, content.body, now, orderId, now),
  ])

  if (flip.meta.changes === 0) {
    const after = await findOrderByIdForUser(db, orderId, userId)
    if (!after) return { ok: false, error: 'NOT_FOUND' }
    if (after.status !== 'DRAFT' && after.status !== 'NEEDS_REVISION') {
      return { ok: false, error: 'NOT_EDITABLE', status: after.status }
    }
    return { ok: false, error: 'PENDING_LIMIT' }
  }

  await logEvent(db, orderId, 'SUBMITTED', userId, null, now)
  return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
}

export interface OrderFilter {
  userId?: string // admin filter; omitted = all users
  status?: OrderStatus
  // Substring match against fullName/phone/orderCode/activationCode — lets a CTV or admin find
  // an order without knowing its exact status/page.
  q?: string
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
  if (filter.q) {
    where.push('(full_name LIKE ? OR phone LIKE ? OR order_code LIKE ? OR activation_code LIKE ?)')
    args.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`)
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
  | { ok: false; error: 'NOT_PENDING'; status: OrderStatus }

// Shared tail for reject/request-revision/approve: on a successful flip re-read the row;
// otherwise classify why nothing flipped (truly decided vs. never-submitted-yet/needs-revision).
async function classifyNonFlip(db: D1Database, orderId: string): Promise<DecideResult> {
  const row = await findOrderById(db, orderId)
  if (!row) return { ok: false, error: 'NOT_FOUND' }
  if (row.status === 'APPROVED' || row.status === 'REJECTED') {
    return { ok: false, error: 'ALREADY_DECIDED', status: row.status }
  }
  return { ok: false, error: 'NOT_PENDING', status: row.status }
}

/**
 * Reject: flip PENDING→REJECTED, no ledger rows. Terminal — a rejected order is never reopened;
 * retrying means the CTV creates a brand new order. Fires ORDER_REJECTED → the creator, chained
 * on this batch's own flip (decided_at = our ?now) exactly like notifications.ts's own guard, so
 * reusing `notifyOrderRejected` unchanged is safe.
 */
export async function rejectOrder(db: D1Database, orderId: string, adminId: string, now: string): Promise<DecideResult> {
  const existing = await findOrderById(db, orderId)
  if (!existing) return { ok: false, error: 'NOT_FOUND' }

  const [flip] = await db.batch([
    db
      .prepare(`UPDATE orders SET status = 'REJECTED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`)
      .bind(adminId, now, now, orderId),
    notifyOrderRejected(db, orderId, existing.note, now),
  ])
  if (flip.meta.changes === 1) {
    await logEvent(db, orderId, 'REJECTED', adminId, null, now)
    return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
  }
  return classifyNonFlip(db, orderId)
}

/** PENDING → NEEDS_REVISION. The CTV can then edit and resubmit (design's revision loop). */
export async function requestRevision(
  db: D1Database,
  orderId: string,
  adminId: string,
  reason: string,
  now: string,
): Promise<DecideResult> {
  const res = await db
    .prepare(`UPDATE orders SET status = 'NEEDS_REVISION', revision_reason = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`)
    .bind(reason, now, orderId)
    .run()
  if (res.meta.changes === 1) {
    await logEvent(db, orderId, 'REVISION_REQUESTED', adminId, reason, now)
    return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
  }
  return classifyNonFlip(db, orderId)
}

/**
 * Approve: one batch that flips status and pays +50 (creator) / +10 (referrer, if any). S2/S3 are
 * conditional inserts guarded on THIS batch's own flip (decided_at = our ?now), so a double-approve
 * writes zero rows (tech-spec §6.1). The admin is trusted to have manually verified fullName/phone/
 * orderCode/activationCode before calling this — the system enforces none of that. Fires
 * ORDER_APPROVED → the creator and CUSTOMER_REFERRAL_BONUS → the referrer (iff S3 paid); both
 * reused unchanged from notifications.ts — their guards (decided_at / the S3 ledger row) match
 * this batch exactly.
 */
export async function approveOrder(db: D1Database, orderId: string, adminId: string, now: string): Promise<DecideResult> {
  const existing = await findOrderById(db, orderId)
  if (!existing) return { ok: false, error: 'NOT_FOUND' }

  const results = await db.batch([
    // S1: flip status, guarded on PENDING
    db
      .prepare(`UPDATE orders SET status = 'APPROVED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`)
      .bind(adminId, now, now, orderId),
    // S2: +50 to the creator
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         SELECT ?, o.user_id, 'F', 'CUSTOMER_REWARD', ?, o.id, ?
         FROM orders o WHERE o.id = ? AND o.status = 'APPROVED' AND o.decided_at = ?`,
      )
      .bind(crypto.randomUUID(), POINTS.CUSTOMER_REWARD, now, orderId, now),
    // S3: +10 to the direct referrer — only when the creator has one AND that referrer is a USER.
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

  if (results[0].meta.changes === 1) {
    await logEvent(db, orderId, 'APPROVED', adminId, null, now)
    return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
  }
  return classifyNonFlip(db, orderId)
}
