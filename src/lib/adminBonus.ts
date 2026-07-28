import { getBalances, toAdminLedgerEntry, type AdminLedgerEntry, type LedgerRow } from './ledger'

export interface GrantGBonusInput {
  userId: string
  points: number
  reason: string
  idempotencyKey: string
  adminId: string
  now: string
}

export type GrantGBonusResult =
  | {
      ok: true
      entry: AdminLedgerEntry
      before: { f: number; g: number }
      after: { f: number; g: number }
    }
  | { ok: false; error: 'DUPLICATE' }

/** Append a Super Admin award to G; ordinary G maintenance/reset logic then applies to it. */
export async function grantGBonus(db: D1Database, input: GrantGBonusInput): Promise<GrantGBonusResult> {
  const replay = await db
    .prepare(`SELECT 1 AS x FROM point_ledger WHERE idempotency_key = ? LIMIT 1`)
    .bind(input.idempotencyKey)
    .first()
  if (replay) return { ok: false, error: 'DUPLICATE' }

  const before = await getBalances(db, input.userId)
  const id = crypto.randomUUID()
  try {
    await db
      .prepare(
        `INSERT INTO point_ledger
           (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
         VALUES (?, ?, 'G', 'ADMIN_BONUS', ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.userId, input.points, input.idempotencyKey, input.reason, input.adminId, input.now)
      .run()
  } catch (err) {
    if (isDuplicateIdempotencyKey(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }

  const row = await db.prepare(`SELECT * FROM point_ledger WHERE id = ?`).bind(id).first<LedgerRow>()
  if (!row) throw new Error('admin bonus ledger row missing after insert')

  return {
    ok: true,
    entry: toAdminLedgerEntry(row),
    before,
    after: await getBalances(db, input.userId),
  }
}

function isDuplicateIdempotencyKey(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('uq_ledger_idem') ||
    (message.includes('UNIQUE constraint failed') && message.includes('idempotency_key'))
  )
}
