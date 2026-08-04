// Redemption: the admin deducts points for cash already paid outside the system. Reintroduced
// for wallet A/B/C after being removed (commit e2d31bf) when activation started auto-settling
// B/C on every activation — wallet A never auto-drains, so it otherwise has no payout path at
// all. The guarded batch is the authority on unlock + sufficiency; validateRedemption only
// pre-flights a friendly message. A negative balance is structurally impossible under the single
// writer.
import { validateRedemption } from '../domain/points/redemption'
import type { Wallet } from '../domain/points/types'
import { getBalances, hasCustomerReward, toAdminLedgerEntry, type AdminLedgerEntry, type LedgerRow } from './ledger'
import { notifyRedemption } from './notifications'

export interface RedeemInput {
  userId: string
  a?: number // positive integer (ArkType-validated upstream)
  b?: number
  c?: number
  note: string | null
  idempotencyKey: string
  adminId: string
  now: string
}

export type RedeemResult =
  | { ok: true; entries: AdminLedgerEntry[]; balances: { a: number; b: number; c: number } }
  | { ok: false; error: 'LOCKED' | 'INSUFFICIENT_BALANCE' | 'DUPLICATE' }

export async function redeem(db: D1Database, input: RedeemInput): Promise<RedeemResult> {
  const { userId, a, b, c, note, idempotencyKey, adminId, now } = input

  // Idempotency first: a key already on the ledger means this is a replay of a committed
  // redemption. Report DUPLICATE regardless of the current balance — otherwise a retry after the
  // original succeeded (which lowered the balance) would be masked as INSUFFICIENT_BALANCE. R4
  // remains the backstop for the concurrent case where neither submit has committed yet.
  const replay = await db
    .prepare(`SELECT 1 AS x FROM point_ledger WHERE idempotency_key = ? LIMIT 1`)
    .bind(idempotencyKey)
    .first()
  if (replay) return { ok: false, error: 'DUPLICATE' }

  // Pre-flight for a specific error message. The SQL guards below are the real authority.
  const pre = validateRedemption({
    hasCustomerReward: await hasCustomerReward(db, userId),
    balances: await getBalances(db, userId),
    amounts: { a, b, c },
  })
  if (!pre.ok) return { ok: false, error: pre.error === 'LOCKED' ? 'LOCKED' : 'INSUFFICIENT_BALANCE' }

  const wallets: Wallet[] = []
  if (a !== undefined) wallets.push('A')
  if (b !== undefined) wallets.push('B')
  if (c !== undefined) wallets.push('C')
  const amount: Record<Wallet, number> = { A: a ?? 0, B: b ?? 0, C: c ?? 0 }
  const rowId: Record<Wallet, string> = { A: crypto.randomUUID(), B: crypto.randomUUID(), C: crypto.randomUUID() }
  const [first, ...rest] = wallets

  const statements: D1PreparedStatement[] = [
    // First row carries ALL guards for the whole redemption: the B/C unlock (skipped entirely
    // when neither is being redeemed — wallet A never requires it) + all three wallets'
    // sufficiency. An absent wallet's amount is 0, so its guard (SUM >= 0) is trivially true.
    db
      .prepare(
        `INSERT INTO point_ledger
           (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
         SELECT ?, ?, ?, 'REDEMPTION', ?, ?, ?, ?, ?
         WHERE (
             (? = 0 AND ? = 0)
             OR EXISTS (SELECT 1 FROM point_ledger WHERE user_id = ? AND type = 'CUSTOMER_REWARD')
           )
           AND (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE user_id = ? AND wallet = 'A') >= ?
           AND (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE user_id = ? AND wallet = 'B') >= ?
           AND (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE user_id = ? AND wallet = 'C') >= ?`,
      )
      .bind(
        rowId[first], userId, first, -amount[first], idempotencyKey, note, adminId, now,
        amount.B, amount.C, userId,
        userId, amount.A, userId, amount.B, userId, amount.C,
      ),
    // Remaining wallets (if any) fire iff the first row committed — chained on its concrete id.
    ...rest.map((w) =>
      db
        .prepare(
          `INSERT INTO point_ledger
             (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
           SELECT ?, ?, ?, 'REDEMPTION', ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM point_ledger WHERE id = ?)`,
        )
        .bind(rowId[w], userId, w, -amount[w], idempotencyKey, note, adminId, now, rowId[first]),
    ),
  ]
  const ledgerCount = statements.length // ledger rows only, before the notification is appended

  // REDEMPTION notification, chained on the first ledger row: it fires iff the redemption committed.
  statements.push(notifyRedemption(db, rowId[first], amount.A, amount.B, amount.C, now))

  let results: D1Result[]
  try {
    results = await db.batch(statements)
  } catch (err) {
    if (isDuplicateRedemption(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }

  // All-or-nothing: the last LEDGER row chains on the first, so if it wrote nothing, nothing landed.
  // (The notification is appended after the ledger rows, so we index the last ledger statement.)
  if (results[ledgerCount - 1].meta.changes === 0) {
    // A race changed the state between pre-flight and commit — re-derive the reason.
    const needsUnlock = (amount.B > 0 || amount.C > 0) && !(await hasCustomerReward(db, userId))
    return { ok: false, error: needsUnlock ? 'LOCKED' : 'INSUFFICIENT_BALANCE' }
  }

  const ids = wallets.map((w) => rowId[w])
  const { results: rows } = await db
    .prepare(`SELECT * FROM point_ledger WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY wallet`)
    .bind(...ids)
    .all<LedgerRow>()

  return { ok: true, entries: rows.map(toAdminLedgerEntry), balances: await getBalances(db, userId) }
}

// R4 (uq_ledger_idem) rejects a replayed idempotencyKey → whole batch rolls back (tech-spec §6.2).
// D1 reports the violation by columns ("...point_ledger.idempotency_key, point_ledger.wallet"), not
// the partial index name; match either form, scoped to a UNIQUE failure so the linkage CHECK on
// idempotency_key can't be misread as a replay. Pinned by test/constraints.test.ts. Used by both
// redeem() above and activateCustomer() in orders.ts for their own idempotency-replay handling.
export function isDuplicateRedemption(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('uq_ledger_idem') ||
    (msg.includes('UNIQUE constraint failed') && msg.includes('idempotency_key'))
  )
}
