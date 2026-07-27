// Monthly maintenance engine (tech-spec §6.4). Directly testable: takes `now: Date`, no cron
// harness. Idempotent by (user, period) under R3, self-healing after missed runs, isolated per user.
import { POINTS } from '../domain/points/constants'
import { planMaintenance, planResetWarning } from '../domain/points/maintenance'
import { anniversaryDate } from '../domain/points/periods'
import type { MaintenancePlanItem } from '../domain/points/types'
import { notifyMaintenance, notifyMaintenanceResetWarning } from './notifications'

interface MaintenanceUser {
  id: string
  fullName: string
  phone: string
  createdAt: string
}

interface MaintenanceContext {
  users: MaintenanceUser[]
  lastAccruedByUser: Map<string, number>
  approvedDatesByUser: Map<string, Date[]>
}

// The three cheap bulk queries both runMaintenance and findAtRiskUsers need — fine at <1,000
// users (tech-spec §6.4.1). Shared here so the two never drift on what "due" or "at risk" means.
async function gatherMaintenanceContext(db: D1Database): Promise<MaintenanceContext> {
  const { results: users } = await db
    .prepare(`SELECT id, full_name, phone, created_at FROM users WHERE role = 'USER'`)
    .all<{ id: string; full_name: string; phone: string; created_at: string }>()

  const { results: accruals } = await db
    .prepare(
      `SELECT user_id, MAX(period_index) AS n FROM point_ledger
       WHERE type = 'MAINTENANCE_ACCRUAL' GROUP BY user_id`,
    )
    .all<{ user_id: string; n: number }>()
  const lastAccruedByUser = new Map(accruals.map((r) => [r.user_id, r.n]))

  const { results: approved } = await db
    .prepare(`SELECT user_id, decided_at FROM orders WHERE status = 'APPROVED'`)
    .all<{ user_id: string; decided_at: string }>()
  const approvedDatesByUser = new Map<string, Date[]>()
  for (const r of approved) {
    const list = approvedDatesByUser.get(r.user_id) ?? []
    list.push(new Date(r.decided_at))
    approvedDatesByUser.set(r.user_id, list)
  }

  return {
    users: users.map((u) => ({ id: u.id, fullName: u.full_name, phone: u.phone, createdAt: u.created_at })),
    lastAccruedByUser,
    approvedDatesByUser,
  }
}

export async function runMaintenance(db: D1Database, now: Date): Promise<void> {
  const nowIso = now.toISOString()
  const { users, lastAccruedByUser, approvedDatesByUser } = await gatherMaintenanceContext(db)

  for (const user of users) {
    // Failure isolation: one bad user never sinks the run; the next daily pass retries idempotently.
    try {
      const registeredAt = new Date(user.createdAt)
      const lastAccruedPeriod = lastAccruedByUser.get(user.id) ?? 0
      const approvedOrderDates = approvedDatesByUser.get(user.id) ?? []

      const plan = planMaintenance({ registeredAt, lastAccruedPeriod, approvedOrderDates, now })
      // Ascending order matters: each period's reset amount is the G balance at that point.
      for (const item of plan) {
        await applyPeriod(db, user.id, item, nowIso)
      }

      // Computed from the SAME pre-run lastAccruedPeriod as `plan` above: "due" (handled by
      // planMaintenance) and "in the warning zone" are mutually exclusive at a given instant, so
      // there's no ordering dependency between the two calls.
      const warning = planResetWarning({ registeredAt, lastAccruedPeriod, approvedOrderDates, now })
      if (warning?.warningRequired) {
        await applyResetWarning(db, user.id, warning.periodIndex, nowIso)
      }
    } catch (err) {
      console.error(`maintenance failed for user ${user.id}`, err)
    }
  }
}

// One (user, period): reset-then-accrue in a single transaction. Reset amount is computed
// in-transaction so it zeroes exactly the pre-accrual balance; the +10 always follows (PRD §6.4).
async function applyPeriod(db: D1Database, userId: string, item: MaintenancePlanItem, nowIso: string): Promise<void> {
  const statements: D1PreparedStatement[] = []
  const accrualId = crypto.randomUUID()
  const resetId = crypto.randomUUID()

  if (item.resetRequired) {
    // Skipped entirely when G <= 0 (no zero-point rows, which would violate points <> 0; A8).
    statements.push(
      db
        .prepare(
          `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
           SELECT ?, ?, 'G', 'MAINTENANCE_RESET',
                  -(SELECT SUM(points) FROM point_ledger WHERE user_id = ? AND wallet = 'G'),
                  ?, ?
           WHERE (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE user_id = ? AND wallet = 'G') > 0`,
        )
        .bind(resetId, userId, userId, item.periodIndex, nowIso, userId),
    )
  }

  // Plain INSERT (not OR IGNORE): a cron-overlap duplicate violates R3 and rolls back the whole
  // (user, period) batch — including the reset — which we classify as already-processed below.
  statements.push(
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
         VALUES (?, ?, 'G', 'MAINTENANCE_ACCRUAL', ?, ?, ?)`,
      )
      .bind(accrualId, userId, POINTS.MAINTENANCE, item.periodIndex, nowIso),
  )

  // Notifications, appended after their ledger rows: each INSERT-SELECT keys off its row's id, so a
  // reset notif only fires when the reset actually happened (G>0), and an R3 rollback discards both.
  if (item.resetRequired) {
    statements.push(notifyMaintenance(db, resetId, 'MAINTENANCE_RESET', item.periodIndex, nowIso))
  }
  statements.push(notifyMaintenance(db, accrualId, 'MAINTENANCE_ACCRUAL', item.periodIndex, nowIso))

  try {
    await db.batch(statements)
  } catch (err) {
    // R3 (uq_ledger_user_period_type) → this period is already done (overlap/catch-up). Swallow it;
    // any OTHER constraint failure stays loud.
    if (isAlreadyProcessed(err)) return
    throw err
  }
}

// No triggering row to chain on (see notifyMaintenanceResetWarning) — a plain INSERT, guarded by
// the UNIQUE index uq_notifications_reset_warning against a repeat cron pass for the same period.
async function applyResetWarning(db: D1Database, userId: string, periodIndex: number, nowIso: string): Promise<void> {
  try {
    await notifyMaintenanceResetWarning(db, userId, periodIndex, nowIso).run()
  } catch (err) {
    if (isAlreadyWarned(err)) return
    throw err
  }
}

export interface AtRiskUser {
  userId: string
  fullName: string
  phone: string
  periodIndex: number
  resetsAt: string // ISO timestamp of anniversary(periodIndex) — when the reset fires if nothing changes
}

/** Every USER currently in the reset-warning zone, computed live (independent of whether a
 *  notification was already sent for that period). Backs the admin at-risk listing. */
export async function findAtRiskUsers(db: D1Database, now: Date): Promise<AtRiskUser[]> {
  const { users, lastAccruedByUser, approvedDatesByUser } = await gatherMaintenanceContext(db)

  const atRisk: AtRiskUser[] = []
  for (const user of users) {
    const registeredAt = new Date(user.createdAt)
    const warning = planResetWarning({
      registeredAt,
      lastAccruedPeriod: lastAccruedByUser.get(user.id) ?? 0,
      approvedOrderDates: approvedDatesByUser.get(user.id) ?? [],
      now,
    })
    if (warning?.warningRequired) {
      atRisk.push({
        userId: user.id,
        fullName: user.fullName,
        phone: user.phone,
        periodIndex: warning.periodIndex,
        resetsAt: anniversaryDate(registeredAt, warning.periodIndex).toISOString(),
      })
    }
  }
  return atRisk
}

// D1 reports the violation by columns ("...point_ledger.user_id, point_ledger.period_index,
// point_ledger.type"), not the partial index name; some builds may name the index instead. Match
// either form, scoped to a UNIQUE failure so a CHECK error on period_index can never be misread as
// "already processed". Pinned by test/constraints.test.ts.
function isAlreadyProcessed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('uq_ledger_user_period_type') ||
    (msg.includes('UNIQUE constraint failed') && msg.includes('period_index'))
  )
}

// Same D1 error-shape caveat as isAlreadyProcessed, but scoped to "notifications" so a ledger-side
// period_index violation is never misread as an already-sent warning. Pinned by
// test/constraints.test.ts.
function isAlreadyWarned(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('uq_notifications_reset_warning') ||
    (msg.includes('UNIQUE constraint failed') && msg.includes('notifications.period_index'))
  )
}
