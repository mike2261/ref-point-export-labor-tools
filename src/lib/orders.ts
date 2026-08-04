// Orders repository. One order = one real customer the CTV activated — fullName/phone/orderCode
// are typed in by the ADMIN and checked against records outside this system; the app does not
// generate or dedupe them.
//
// There is no lifecycle left: the DRAFT→PENDING→NEEDS_REVISION→APPROVED/REJECTED state machine
// (and the CTV-facing create/edit/submit routes that drove it) was removed once activation moved
// to the admin — the customer pays the CTV in cash in person, so there is nothing to queue up for
// approval. An order row is now only ever born already-APPROVED, via activateCustomer() below.
// `orders.status` keeps its 5-value CHECK constraint (no migration), but only 'APPROVED' is ever
// written. Superseded design: docs/superpowers/specs/2026-07-25-order-lifecycle-design.md.
import { POINTS } from '../domain/points/constants'
import type { OrderStatus } from '../domain/points/types'
import { getBalances } from './ledger'
import { notifyCustomerActivated, notifyCustomerReferralBonus } from './notifications'
import { isDuplicateRedemption } from './redemptions'

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

export interface ActivateCustomerInput {
  userId: string // the CTV
  fullName: string // the customer
  phone: string // the customer
  orderCode: string
  idempotencyKey: string
  adminId: string
  now: string
}

export type ActivateCustomerResult =
  | { ok: true; order: Order; paid: { b: number; c: number } }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'DUPLICATE' }

export const DIRECT_ACTIVATION_ORDER_NOTE = 'Kích hoạt trực tiếp bởi admin — khách đã thanh toán tiền mặt'
export const DIRECT_ACTIVATION_REDEMPTION_NOTE = 'Quyết toán toàn bộ điểm khi kích hoạt khách — admin đã chi tiền mặt'

/**
 * Admin activates a customer who already paid the CTV in cash, and SETTLES the CTV'S B AND C
 * WALLETS IN FULL — every point they hold in those two wallets is cashed out on the spot, both
 * ending at 0. Wallet A (referral commission earned when a CTV they referred lands a customer) is
 * deliberately NEVER touched here — it doesn't auto-drain; an admin settles it out-of-band.
 *
 * One batch: the order (APPROVED from creation, there is no PENDING step) + its order_events
 * audit row + CUSTOMER_REWARD (wallet B) to the CTV + CUSTOMER_REFERRAL_BONUS (wallet A) to their
 * referrer + one or two REDEMPTION rows draining the CTV's B and C wallets + one notification to
 * the CTV + the referrer's usual bonus notification.
 *
 * The referrer is deliberately NOT settled — their wallet A commission keeps accruing until they
 * close a customer of their own, at which point their own activation settles their B/C (not A).
 *
 * The drained amounts are read via getBalances() before the batch (same pre-flight-then-bind
 * pattern redeem() already uses, not a live SQL subquery), then bound as literal amounts: B is
 * the CTV's current balance plus this order's CUSTOMER_REWARD (which hasn't landed yet at read
 * time), C is whatever it currently holds. point_ledger CHECKs `points <> 0`, so the C row is
 * only added to the batch when there's actually something to drain.
 *
 * Deliberately NOT a composition of approveOrder() + redeem() — both fire their own
 * notification unconditionally inside their own atomic batch, so reusing them would produce
 * two or three notifications where the CTV should get exactly one.
 */
export async function activateCustomer(db: D1Database, input: ActivateCustomerInput): Promise<ActivateCustomerResult> {
  const { userId, fullName, phone, orderCode, idempotencyKey, adminId, now } = input

  const ctv = await db
    .prepare(`SELECT id, full_name FROM users WHERE id = ? AND role = 'USER'`)
    .bind(userId)
    .first<{ id: string; full_name: string }>()
  if (!ctv) return { ok: false, error: 'NOT_FOUND' }

  const replay = await db.prepare(`SELECT 1 AS x FROM point_ledger WHERE idempotency_key = ? LIMIT 1`).bind(idempotencyKey).first()
  if (replay) return { ok: false, error: 'DUPLICATE' }

  // Read before the batch (same pre-flight-then-bind pattern redeem() uses) — this order's own
  // CUSTOMER_REWARD hasn't landed yet, so add it to B by hand to get what the CTV is about to hold.
  const before = await getBalances(db, userId)
  const paidB = before.b + POINTS.CUSTOMER_REWARD
  const paidC = before.c

  const orderId = crypto.randomUUID()
  const redemptionBId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    // Order, already APPROVED — activation_code mirrors orderCode (not asked for separately).
    db
      .prepare(
        `INSERT INTO orders
           (id, user_id, full_name, phone, order_code, activation_code, note, status, decided_by, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`,
      )
      .bind(orderId, userId, fullName, phone, orderCode, orderCode, DIRECT_ACTIVATION_ORDER_NOTE, adminId, now, now, now),
    // Audit trail parity with a normal approval.
    db
      .prepare(`INSERT INTO order_events (id, order_id, type, actor_id, reason, created_at) VALUES (?, ?, 'APPROVED', ?, NULL, ?)`)
      .bind(crypto.randomUUID(), orderId, adminId, now),
    // +500 B to the CTV.
    db
      .prepare(`INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at) VALUES (?, ?, 'B', 'CUSTOMER_REWARD', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, POINTS.CUSTOMER_REWARD, orderId, now),
    // +100 A to the direct referrer — same condition as before (referrer is a USER). Deliberately
    // NOT settled here: wallet A keeps accruing until the referrer's own activation, and even then
    // that activation only ever touches B/C, never A.
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         SELECT ?, r.id, 'A', 'CUSTOMER_REFERRAL_BONUS', ?, ?, ?
         FROM users u JOIN users r ON r.id = u.referrer_id
         WHERE u.id = ? AND r.role = 'USER'`,
      )
      .bind(crypto.randomUUID(), POINTS.CUSTOMER_REFERRAL, orderId, now, userId),
    // Drain B to 0 — the CTV's entire B balance, not just this order's own reward.
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
         VALUES (?, ?, 'B', 'REDEMPTION', ?, ?, ?, ?, ?)`,
      )
      .bind(redemptionBId, userId, -paidB, idempotencyKey, DIRECT_ACTIVATION_REDEMPTION_NOTE, adminId, now),
    // One notification to the CTV, tied to the B redemption row above (always written — B is
    // never 0 here, CUSTOMER_REWARD just landed).
    notifyCustomerActivated(db, redemptionBId, fullName, orderCode, paidB, paidC, now),
    // The referrer's own notification, unaffected by this flow — fires iff the +100 leg was paid.
    notifyCustomerReferralBonus(db, orderId, ctv.full_name, now),
  ]

  // Drain C too, but only if there's anything in it — point_ledger CHECKs points <> 0.
  if (paidC > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
           VALUES (?, ?, 'C', 'REDEMPTION', ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), userId, -paidC, idempotencyKey, DIRECT_ACTIVATION_REDEMPTION_NOTE, adminId, now),
    )
  }

  try {
    await db.batch(statements)
  } catch (err) {
    if (isDuplicateRedemption(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }

  return { ok: true, order: toOrder((await findOrderById(db, orderId))!), paid: { b: paidB, c: paidC } }
}
