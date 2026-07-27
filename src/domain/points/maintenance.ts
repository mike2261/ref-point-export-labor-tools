// Monthly maintenance planner (PRD §6.4, tech-spec §5). Decides, per due period, WHETHER a
// G-wallet reset is required. The reset AMOUNT is not computed here — it depends on the live G
// balance and is resolved inside the SQL transaction (tech-spec §1.1 rule 2).
import { WARMUP_PERIODS, WINDOW_PERIODS } from './constants'
import { anniversaryDate, duePeriods } from './periods'
import type { MaintenancePlanItem, ResetWarningPlanItem } from './types'

export function planMaintenance(input: {
  registeredAt: Date
  lastAccruedPeriod: number // 0 if no MAINTENANCE_ACCRUAL rows yet
  approvedOrderDates: Date[] // decided_at of the user's APPROVED orders
  now: Date
}): MaintenancePlanItem[] {
  const { registeredAt, lastAccruedPeriod, approvedOrderDates, now } = input

  return duePeriods(registeredAt, lastAccruedPeriod, now).map((n) => {
    // Warm-up: no reset for periods 1..WARMUP_PERIODS — there isn't a full window to evaluate yet.
    if (n <= WARMUP_PERIODS) {
      return { periodIndex: n, resetRequired: false }
    }

    // Rolling window, half-open on the right: [anniv(n-WINDOW), anniv(n)). An order approved at
    // exactly the closing anniversary belongs to the NEXT window, not this one.
    const windowStart = anniversaryDate(registeredAt, n - WINDOW_PERIODS).getTime()
    const windowEnd = anniversaryDate(registeredAt, n).getTime()
    const hasApprovedInWindow = approvedOrderDates.some((d) => {
      const t = d.getTime()
      return t >= windowStart && t < windowEnd
    })

    return { periodIndex: n, resetRequired: !hasApprovedInWindow }
  })
}

/**
 * Whether to warn the user that their NEXT maintenance period's G-wallet reset is approaching:
 * fires once 2 of that period's 3-month window have elapsed with no APPROVED order in it yet.
 * Returns null when there's nothing to evaluate: still in warm-up, not yet at the 2/3 mark, or
 * the period is already due (planMaintenance owns that case instead — the two are mutually
 * exclusive, so this can run off the same pre-run lastAccruedPeriod in the same cron pass).
 */
export function planResetWarning(input: {
  registeredAt: Date
  lastAccruedPeriod: number
  approvedOrderDates: Date[]
  now: Date
}): ResetWarningPlanItem | null {
  const { registeredAt, lastAccruedPeriod, approvedOrderDates, now } = input
  const target = Math.max(lastAccruedPeriod + 1, 1)
  if (target <= WARMUP_PERIODS) return null

  const windowStart = anniversaryDate(registeredAt, target - WINDOW_PERIODS).getTime()
  const warnAt = anniversaryDate(registeredAt, target - 1).getTime()
  const windowEnd = anniversaryDate(registeredAt, target).getTime()
  const t = now.getTime()
  if (t < warnAt || t >= windowEnd) return null

  const hasApprovedSoFar = approvedOrderDates.some((d) => {
    const dt = d.getTime()
    return dt >= windowStart && dt < t
  })
  return { periodIndex: target, warningRequired: !hasApprovedSoFar }
}
