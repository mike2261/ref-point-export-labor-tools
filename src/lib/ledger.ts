// Ledger repository: derived balances, the unlock check, history listing, and the shared
// draft→statement helper. Balances are always summed from point_ledger, never stored (PRD §5).
import type { LedgerDraft, LedgerType, Wallet } from '../domain/points/types'

// Raw DB row (snake_case, all nullable reference columns) — includes the LEFT JOIN columns
// from listLedger's query (order_full_name/order_code from orders, subject_full_name from
// users), which are simply absent for entries with no order_id/subject_user_id.
export interface LedgerRow {
  id: string
  user_id: string
  wallet: Wallet
  type: LedgerType
  points: number
  order_id: string | null
  subject_user_id: string | null
  period_index: number | null
  idempotency_key: string | null
  note: string | null
  created_by: string | null
  created_at: string
  order_full_name: string | null
  order_code: string | null
  order_owner_full_name: string | null
  subject_full_name: string | null
  subject_phone: string | null
}

// User-facing shape (PRD §8): no idempotencyKey. orderFullName/orderCode trace a CUSTOMER_*
// row back to who it was for; subjectUserId/subjectUserFullName trace a REFERRAL_SIGNUP_BONUS
// row back to who signed up under this user (gap report §5.1: "mỗi giao dịch phải truy ngược
// được tới hồ sơ liên quan") without a separate round trip.
export interface LedgerEntry {
  id: string
  userId: string
  wallet: Wallet
  type: LedgerType
  points: number
  orderId: string | null
  orderFullName: string | null
  orderCode: string | null
  // The CTV who owns the order (orders.user_id) — distinct from orderFullName, which is the
  // CUSTOMER's name. Only meaningful for CUSTOMER_REFERRAL_BONUS rows: it names the referred
  // CTV whose closed customer earned this row's beneficiary their commission.
  orderOwnerFullName: string | null
  subjectUserId: string | null
  subjectUserFullName: string | null
  subjectUserPhone: string | null
  periodIndex: number | null
  note: string | null
  createdBy: string | null
  createdAt: string
}

// Admin shape adds only the internal idempotency linkage — everything else is already on
// LedgerEntry.
export interface AdminLedgerEntry extends LedgerEntry {
  idempotencyKey: string | null
}

export function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    wallet: row.wallet,
    type: row.type,
    points: row.points,
    orderId: row.order_id,
    orderFullName: row.order_full_name,
    orderCode: row.order_code,
    orderOwnerFullName: row.order_owner_full_name,
    subjectUserId: row.subject_user_id,
    subjectUserFullName: row.subject_full_name,
    subjectUserPhone: row.subject_phone,
    periodIndex: row.period_index,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

export function toAdminLedgerEntry(row: LedgerRow): AdminLedgerEntry {
  return {
    ...toLedgerEntry(row),
    idempotencyKey: row.idempotency_key,
  }
}

/** Derived A, B & C balances for a user (covering index makes this touch no table rows). */
export async function getBalances(db: D1Database, userId: string): Promise<{ a: number; b: number; c: number }> {
  const { results } = await db
    .prepare(
      `SELECT wallet, COALESCE(SUM(points), 0) AS total
       FROM point_ledger WHERE user_id = ? GROUP BY wallet`,
    )
    .bind(userId)
    .all<{ wallet: Wallet; total: number }>()

  let a = 0
  let b = 0
  let c = 0
  for (const r of results) {
    if (r.wallet === 'A') a = r.total
    else if (r.wallet === 'B') b = r.total
    else if (r.wallet === 'C') c = r.total
  }
  return { a, b, c }
}

/** Redemption unlock (PRD §6.5.1): has the user ever earned a CUSTOMER_REWARD? Permanent once true. */
export async function hasCustomerReward(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM point_ledger WHERE user_id = ? AND type = 'CUSTOMER_REWARD' LIMIT 1`)
    .bind(userId)
    .first()
  return row !== null
}

export interface LedgerFilter {
  userId?: string // omitted = all users (admin ledger); user routes always pass their own id
  wallet?: Wallet
  type?: LedgerType
  direction?: 'credit' | 'debit' // gap report §5.1 "cộng/trừ"
  from?: string // ISO, inclusive
  to?: string // ISO, exclusive
  // Substring match against the linked order's code/name/phone (gap report §5.1 "tên khách, mã
  // đơn"). Entries with no order_id never match — q is specifically for finding order-linked rows.
  q?: string
  page: number
  limit: number
}

/**
 * Paginated ledger history (created_at DESC, id DESC), optionally scoped to one user.
 * LEFT JOINs orders (for CUSTOMER_* traceability) and users (for the registration bonuses'
 * referred-person name) — both joins are cheap (indexed PK lookups) and every other row type
 * simply gets NULLs back.
 */
export async function listLedger(db: D1Database, filter: LedgerFilter): Promise<{ rows: LedgerRow[]; total: number }> {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.userId) {
    where.push('pl.user_id = ?')
    args.push(filter.userId)
  }
  if (filter.wallet) {
    where.push('pl.wallet = ?')
    args.push(filter.wallet)
  }
  if (filter.type) {
    where.push('pl.type = ?')
    args.push(filter.type)
  }
  if (filter.direction) {
    where.push(filter.direction === 'credit' ? 'pl.points > 0' : 'pl.points < 0')
  }
  if (filter.from) {
    where.push('pl.created_at >= ?')
    args.push(filter.from)
  }
  if (filter.to) {
    where.push('pl.created_at < ?')
    args.push(filter.to)
  }
  if (filter.q) {
    where.push('(o.order_code LIKE ? OR o.full_name LIKE ? OR o.phone LIKE ?)')
    args.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const joinSql = `
    FROM point_ledger pl
    LEFT JOIN orders o ON o.id = pl.order_id
    LEFT JOIN users ou ON ou.id = o.user_id
    LEFT JOIN users su ON su.id = pl.subject_user_id`

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n ${joinSql} ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>()

  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(
      `SELECT pl.*, o.full_name AS order_full_name, o.order_code AS order_code,
              ou.full_name AS order_owner_full_name,
              su.full_name AS subject_full_name, su.phone AS subject_phone
       ${joinSql} ${whereSql}
       ORDER BY pl.created_at DESC, pl.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...args, filter.limit, offset)
    .all<LedgerRow>()

  return { rows: results, total: totalRow?.n ?? 0 }
}

/**
 * Turn a fixed-amount draft into a plain INSERT statement (used inside batches — registration
 * bonuses in §6.3). Resets and order-approval guards are NOT built here; they are conditional
 * writes assembled in their own lib functions (tech-spec §1.1 rule 2, §6.1).
 */
export function draftToStatement(db: D1Database, draft: LedgerDraft, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO point_ledger
         (id, user_id, wallet, type, points, order_id, subject_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      draft.userId,
      draft.wallet,
      draft.type,
      draft.points,
      draft.orderId ?? null,
      draft.subjectUserId ?? null,
      now,
    )
}
