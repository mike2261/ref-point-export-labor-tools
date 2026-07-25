// Orders repository: the DRAFT→PENDING→NEEDS_REVISION→PENDING→APPROVED/REJECTED lifecycle
// (design: docs/superpowers/specs/2026-07-25-order-lifecycle-design.md). Every transition is
// logged to order_events; approve additionally emits the F-wallet bonuses and enforces "one
// APPROVED order per customer, ever" (tech-spec §6.1 for the point math, unchanged).
import { MAX_PENDING_ORDERS, POINTS } from '../domain/points/constants'
import { CODE_COLLISION_RETRIES, monthKey, randomActivationCode } from './orderCodes'
import { upsertCustomer, type UpsertCustomerInput } from './customers'
import type { OrderStatus } from '../domain/points/types'

export interface OrderRow {
  id: string
  user_id: string
  customer_id: string
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

// orders JOIN customers — the shape every read query returns; customer_id is NOT NULL so the
// join never drops a row.
export interface OrderWithCustomerRow extends OrderRow {
  customer_full_name: string
  customer_phone: string
  customer_date_of_birth: string | null
  customer_market: string | null
}

export interface Order {
  id: string
  userId: string
  customer: {
    id: string
    fullName: string
    phone: string
    dateOfBirth: string | null
    market: string | null
  }
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

export function toOrder(row: OrderWithCustomerRow): Order {
  return {
    id: row.id,
    userId: row.user_id,
    customer: {
      id: row.customer_id,
      fullName: row.customer_full_name,
      phone: row.customer_phone,
      dateOfBirth: row.customer_date_of_birth,
      market: row.customer_market,
    },
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

const SELECT_WITH_CUSTOMER = `
  SELECT o.*, c.full_name AS customer_full_name, c.phone AS customer_phone,
         c.date_of_birth AS customer_date_of_birth, c.market AS customer_market
  FROM orders o JOIN customers c ON c.id = o.customer_id`

export function findOrderById(db: D1Database, id: string): Promise<OrderWithCustomerRow | null> {
  return db.prepare(`${SELECT_WITH_CUSTOMER} WHERE o.id = ?`).bind(id).first<OrderWithCustomerRow>()
}

/** Ownership baked into SQL: a foreign id returns null → the route maps to 404 (no leak, §10). */
export function findOrderByIdForUser(db: D1Database, id: string, userId: string): Promise<OrderWithCustomerRow | null> {
  return db
    .prepare(`${SELECT_WITH_CUSTOMER} WHERE o.id = ? AND o.user_id = ?`)
    .bind(id, userId)
    .first<OrderWithCustomerRow>()
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

function isCodeCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('UNIQUE constraint failed') && (msg.includes('order_code') || msg.includes('activation_code'))
}

export interface CreateDraftInput {
  customerFullName: string
  customerPhone: string
  customerDob?: string | null
  customerMarket?: string | null
  note?: string | null
}

/**
 * Create a DRAFT order: find-or-update the CTV's customer by phone, then insert the order with a
 * freshly minted order/activation code. Not capped by MAX_PENDING_ORDERS — drafts aren't in
 * anyone's queue yet; the cap is enforced at submit time instead.
 */
export async function createDraftOrder(db: D1Database, userId: string, input: CreateDraftInput, now: string): Promise<Order> {
  const customerInput: UpsertCustomerInput = {
    ctvId: userId,
    fullName: input.customerFullName,
    phone: input.customerPhone,
    dateOfBirth: input.customerDob,
    market: input.customerMarket,
  }
  const customer = await upsertCustomer(db, customerInput, now)
  const month = monthKey(now)

  let lastErr: unknown
  for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
    const id = crypto.randomUUID()
    try {
      await db
        .prepare(
          `INSERT INTO orders
             (id, user_id, customer_id, order_code, activation_code, note, status, created_at, updated_at)
           SELECT ?, ?, ?,
             'XKLD-' || ? || '-' || printf('%06d',
               (SELECT COUNT(*) + 1 FROM orders WHERE order_code LIKE 'XKLD-' || ? || '-%')),
             ?, ?, 'DRAFT', ?, ?`,
        )
        .bind(id, userId, customer.id, month, month, randomActivationCode(), input.note ?? null, now, now)
        .run()
      return toOrder((await findOrderById(db, id))!)
    } catch (err) {
      if (!isCodeCollision(err)) throw err
      lastErr = err
    }
  }
  throw lastErr
}

export interface UpdateOrderInput {
  note?: string | null
  customerFullName?: string
  customerPhone?: string
  customerDob?: string | null
  customerMarket?: string | null
}

export type UpdateResult = { ok: true; order: Order } | { ok: false; error: 'NOT_FOUND' | 'LOCKED' }

/** Edit note/customer fields. Only while DRAFT or NEEDS_REVISION — locked otherwise. */
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

  let customerId = row.customer_id
  const touchesCustomer =
    input.customerFullName !== undefined ||
    input.customerPhone !== undefined ||
    input.customerDob !== undefined ||
    input.customerMarket !== undefined
  if (touchesCustomer) {
    const customer = await upsertCustomer(
      db,
      {
        ctvId: userId,
        fullName: input.customerFullName ?? row.customer_full_name,
        phone: input.customerPhone ?? row.customer_phone,
        dateOfBirth: input.customerDob !== undefined ? input.customerDob : row.customer_date_of_birth,
        market: input.customerMarket !== undefined ? input.customerMarket : row.customer_market,
      },
      now,
    )
    customerId = customer.id
  }

  const note = input.note !== undefined ? input.note : row.note
  await db
    .prepare(`UPDATE orders SET note = ?, customer_id = ?, updated_at = ? WHERE id = ?`)
    .bind(note, customerId, now, orderId)
    .run()

  return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
}

export type SubmitResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'NOT_EDITABLE'; status: OrderStatus }
  | { ok: false; error: 'PENDING_LIMIT' }

/** DRAFT|NEEDS_REVISION → PENDING, guarded by the same MAX_PENDING_ORDERS cap as before. */
export async function submitOrder(db: D1Database, orderId: string, userId: string, now: string): Promise<SubmitResult> {
  const before = await findOrderByIdForUser(db, orderId, userId)
  if (!before) return { ok: false, error: 'NOT_FOUND' }
  if (before.status !== 'DRAFT' && before.status !== 'NEEDS_REVISION') {
    return { ok: false, error: 'NOT_EDITABLE', status: before.status }
  }

  const res = await db
    .prepare(
      `UPDATE orders SET status = 'PENDING', revision_reason = NULL, updated_at = ?
       WHERE id = ? AND status IN ('DRAFT', 'NEEDS_REVISION')
         AND (SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'PENDING') < ?`,
    )
    .bind(now, orderId, userId, MAX_PENDING_ORDERS)
    .run()

  if (res.meta.changes === 0) {
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
  page: number
  limit: number
}

export async function listOrders(db: D1Database, filter: OrderFilter): Promise<{ rows: OrderWithCustomerRow[]; total: number }> {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.userId) {
    where.push('o.user_id = ?')
    args.push(filter.userId)
  }
  if (filter.status) {
    where.push('o.status = ?')
    args.push(filter.status)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>()

  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(`${SELECT_WITH_CUSTOMER} ${whereSql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, filter.limit, offset)
    .all<OrderWithCustomerRow>()

  return { rows: results, total: totalRow?.n ?? 0 }
}

export type DecideResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'ALREADY_DECIDED'; status: OrderStatus }
  | { ok: false; error: 'NOT_PENDING'; status: OrderStatus }

// Shared tail for reject/request-revision: on a successful flip re-read the row; otherwise
// classify why nothing flipped (truly decided vs. never-submitted-yet/needs-revision).
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
 * retrying means the CTV creates a new order against the same customer (design decision #4).
 */
export async function rejectOrder(db: D1Database, orderId: string, adminId: string, now: string): Promise<DecideResult> {
  const res = await db
    .prepare(`UPDATE orders SET status = 'REJECTED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`)
    .bind(adminId, now, now, orderId)
    .run()
  if (res.meta.changes === 1) {
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

export type ApproveResult = DecideResult | { ok: false; error: 'CUSTOMER_ALREADY_REWARDED' }

// D1 names the column, not the partial index, in its constraint-violation message (see
// test/constraints.test.ts) — match on `orders.customer_id`, not `uq_orders_customer_approved`.
function isCustomerAlreadyRewarded(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('UNIQUE constraint failed') && msg.includes('orders.customer_id')
}

/**
 * Approve: one batch that flips status and pays +50 (creator) / +10 (referrer, if any). S2/S3 are
 * conditional inserts guarded on THIS batch's own flip (decided_at = our ?now), so a double-approve
 * writes zero rows (tech-spec §6.1). `uq_orders_customer_approved` additionally stops a *different*
 * order for the same customer from ever paying out twice — a batch that would violate it throws,
 * caught below and reported as CUSTOMER_ALREADY_REWARDED instead of a raw 500.
 */
export async function approveOrder(db: D1Database, orderId: string, adminId: string, now: string): Promise<ApproveResult> {
  let results: D1Result[]
  try {
    results = await db.batch([
      // S1: flip status, guarded on PENDING (and, via the partial unique index, on no sibling
      // order for the same customer already being APPROVED)
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
    ])
  } catch (err) {
    if (isCustomerAlreadyRewarded(err)) return { ok: false, error: 'CUSTOMER_ALREADY_REWARDED' }
    throw err
  }

  if (results[0].meta.changes === 1) {
    await logEvent(db, orderId, 'APPROVED', adminId, null, now)
    return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
  }
  return classifyNonFlip(db, orderId)
}
