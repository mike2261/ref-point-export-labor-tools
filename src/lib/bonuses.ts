// Admin-triggered bonus grants (replaces the monthly maintenance cron — see
// docs/superpowers/specs/2026-08-03-admin-point-bonus-design.md). The admin decides when and how
// much to credit; there is no schedule and no reset. Every grant is recorded in bonus_grants (the
// idempotency boundary + audit trail) before any point_ledger row is written, so a retried
// request can never double-pay.
import { findByPhone } from './users'
import { notifyAdminBonus } from './notifications'

export interface BonusGrantRow {
  id: string
  idempotency_key: string
  scope: 'ALL' | 'PHONE'
  target_user_id: string | null
  amount: number
  content: string
  recipient_count: number
  created_by: string
  created_at: string
}

export interface BonusGrant {
  id: string
  scope: 'ALL' | 'PHONE'
  targetUserId: string | null
  amount: number
  content: string
  recipientCount: number
  createdBy: string
  createdAt: string
}

export function toBonusGrant(row: BonusGrantRow): BonusGrant {
  return {
    id: row.id,
    scope: row.scope,
    targetUserId: row.target_user_id,
    amount: row.amount,
    content: row.content,
    recipientCount: row.recipient_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

export interface GrantBonusInput {
  scope: 'ALL' | 'PHONE'
  phone?: string
  amount: number
  content: string
  adminId: string
  idempotencyKey: string
  now: string
}

export type GrantBonusResult =
  | { ok: true; grant: BonusGrant }
  | { ok: false; error: 'DUPLICATE' }
  | { ok: false; error: 'PHONE_NOT_FOUND' }

/**
 * Insert one bonus_grants row, then one ADMIN_BONUS ledger row (+ notification) per recipient.
 * Each recipient is its own small batch, isolated by try/catch — one bad row never sinks the rest
 * of a broadcast (same failure-isolation pattern the old runMaintenance used per-user).
 */
export async function grantBonus(db: D1Database, input: GrantBonusInput): Promise<GrantBonusResult> {
  let recipientIds: string[]
  let targetUserId: string | null = null

  if (input.scope === 'PHONE') {
    const user = await findByPhone(db, input.phone ?? '')
    if (!user || user.role !== 'USER') return { ok: false, error: 'PHONE_NOT_FOUND' }
    recipientIds = [user.id]
    targetUserId = user.id
  } else {
    const { results } = await db.prepare(`SELECT id FROM users WHERE role = 'USER'`).all<{ id: string }>()
    recipientIds = results.map((r) => r.id)
  }

  const grantId = crypto.randomUUID()
  try {
    await db
      .prepare(
        `INSERT INTO bonus_grants (id, idempotency_key, scope, target_user_id, amount, content, recipient_count, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        grantId, input.idempotencyKey, input.scope, targetUserId, input.amount, input.content,
        recipientIds.length, input.adminId, input.now,
      )
      .run()
  } catch (err) {
    if (isDuplicateBonusGrant(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }

  for (const userId of recipientIds) {
    const ledgerId = crypto.randomUUID()
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO point_ledger (id, user_id, wallet, type, points, bonus_grant_id, note, created_by, created_at)
             VALUES (?, ?, 'G', 'ADMIN_BONUS', ?, ?, ?, ?, ?)`,
          )
          .bind(ledgerId, userId, input.amount, grantId, input.content, input.adminId, input.now),
        notifyAdminBonus(db, ledgerId, input.amount, input.content, input.now),
      ])
    } catch (err) {
      console.error(`bonus grant ${grantId} failed for user ${userId}`, err)
    }
  }

  const row = await db.prepare(`SELECT * FROM bonus_grants WHERE id = ?`).bind(grantId).first<BonusGrantRow>()
  return { ok: true, grant: toBonusGrant(row!) }
}

export interface ListBonusGrantsFilter {
  page: number
  limit: number
}

export async function listBonusGrants(
  db: D1Database,
  filter: ListBonusGrantsFilter,
): Promise<{ rows: BonusGrantRow[]; total: number }> {
  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM bonus_grants`).first<{ n: number }>()
  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(`SELECT * FROM bonus_grants ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(filter.limit, offset)
    .all<BonusGrantRow>()
  return { rows: results, total: totalRow?.n ?? 0 }
}

/** Backs the FE "sắp thưởng cho N CTV" confirm dialog for a broadcast grant. */
export async function countCtvUsers(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'USER'`).first<{ n: number }>()
  return row?.n ?? 0
}

// R5 (uq_bonus_grants_idem) rejects a replayed idempotencyKey. D1 reports the violation by column
// name, not the index name — match either form, same pattern as isDuplicateRedemption
// (redemptions.ts). Pinned by test/constraints.test.ts.
export function isDuplicateBonusGrant(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('uq_bonus_grants_idem') || (msg.includes('UNIQUE constraint failed') && msg.includes('idempotency_key'))
}
