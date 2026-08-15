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
  | { ok: true; order: Order; credited: { b: number } }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'DUPLICATE' }

export const DIRECT_ACTIVATION_ORDER_NOTE = 'Kích hoạt trực tiếp bởi admin — khách đã thanh toán tiền mặt'
// Các hằng ghi chú dòng rút khi kích hoạt đã bỏ cùng với luồng tự tất toán (15/08/2026). Dòng cũ
// trong sổ vẫn giữ nguyên chữ đã ghi; từ giờ admin trả tiền bằng chức năng rút tiền thủ công và
// tự nhập ghi chú.

/**
 * Admin kích hoạt khách hàng: CTV được CỘNG tiền và KHÔNG bị trừ gì cả. Trả tiền cho CTV là việc
 * riêng, admin làm bằng chức năng rút tiền thủ công (POST /api/admin/redemptions) y như mọi loại
 * tiền khác — đổi ngày 15/08/2026. Trước đó hàm này tự tất toán sạch ví B và C ngay trong cùng
 * giao dịch, nên số dư CTV lúc nào cũng về 0 và họ không nhìn thấy khoản mình vừa được cộng.
 *
 * One batch: the order (APPROVED from creation, there is no PENDING step) + its order_events
 * audit row + CUSTOMER_REWARD (wallet B) to the CTV + CUSTOMER_REFERRAL_BONUS (wallet A) to their
 * referrer + one notification to the CTV + the referrer's usual bonus notification.
 *
 * Chống gửi trùng: khoá idempotency nằm ở chính bảng `orders` (cột idempotency_key + unique
 * index, migration 0016). Trước đây khoá gắn vào dòng REDEMPTION, mà point_ledger có CHECK ràng
 * chỉ dòng REDEMPTION mới được mang khoá — bỏ dòng rút đi thì không còn chỗ nào giữ khoá nữa.
 *
 * Deliberately NOT a composition of approveOrder() — that fires its own notification inside its
 * own atomic batch, so reusing it would produce two notifications where the CTV should get one.
 */
export async function activateCustomer(db: D1Database, input: ActivateCustomerInput): Promise<ActivateCustomerResult> {
  const { userId, fullName, phone, orderCode, idempotencyKey, adminId, now } = input

  const ctv = await db
    .prepare(`SELECT id, full_name FROM users WHERE id = ? AND role = 'USER'`)
    .bind(userId)
    .first<{ id: string; full_name: string }>()
  if (!ctv) return { ok: false, error: 'NOT_FOUND' }

  const replay = await db.prepare(`SELECT 1 AS x FROM orders WHERE idempotency_key = ? LIMIT 1`).bind(idempotencyKey).first()
  if (replay) return { ok: false, error: 'DUPLICATE' }

  const orderId = crypto.randomUUID()
  const rewardLedgerId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    // Order, already APPROVED — activation_code mirrors orderCode (not asked for separately).
    db
      .prepare(
        `INSERT INTO orders
           (id, user_id, full_name, phone, order_code, activation_code, note, status, decided_by, decided_at, created_at, updated_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?)`,
      )
      .bind(
        orderId, userId, fullName, phone, orderCode, orderCode, DIRECT_ACTIVATION_ORDER_NOTE,
        adminId, now, now, now, idempotencyKey,
      ),
    // Audit trail parity with a normal approval.
    db
      .prepare(`INSERT INTO order_events (id, order_id, type, actor_id, reason, created_at) VALUES (?, ?, 'APPROVED', ?, NULL, ?)`)
      .bind(crypto.randomUUID(), orderId, adminId, now),
    // +500 B to the CTV — khoản duy nhất hàm này ghi vào ví CTV. Không còn dòng rút nào.
    db
      .prepare(`INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at) VALUES (?, ?, 'B', 'CUSTOMER_REWARD', ?, ?, ?)`)
      .bind(rewardLedgerId, userId, POINTS.CUSTOMER_REWARD, orderId, now),
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
    // One notification to the CTV, tied to the +500 credit row it is announcing.
    notifyCustomerActivated(db, rewardLedgerId, fullName, orderCode, POINTS.CUSTOMER_REWARD, now),
    // The referrer's own notification, unaffected by this flow — fires iff the +100 leg was paid.
    notifyCustomerReferralBonus(db, orderId, ctv.full_name, now),
  ]

  try {
    await db.batch(statements)
  } catch (err) {
    // Gửi trùng vẫn có thể lọt qua kiểm tra ở trên nếu hai request chạy song song — unique index
    // trên orders.idempotency_key là chốt chặn cuối.
    if (isDuplicateRedemption(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }

  return { ok: true, order: toOrder((await findOrderById(db, orderId))!), credited: { b: POINTS.CUSTOMER_REWARD } }
}
