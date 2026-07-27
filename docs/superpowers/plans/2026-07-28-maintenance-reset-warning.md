# Maintenance Reset Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn a CTV once their G-wallet's rolling 3-month window is 2/3 elapsed with no APPROVED
order yet (~1 month before `MAINTENANCE_RESET` would fire), and give the admin an on-demand API
listing every CTV currently in that warning zone.

**Architecture:** A new pure planner (`planResetWarning`) mirrors the existing `planMaintenance`
and is evaluated in the same daily cron loop (`runMaintenance`). A match inserts a new
`MAINTENANCE_RESET_WARNING` notification, deduplicated by a UNIQUE index on
`(user_id, period_index)` since — unlike every other notification type — it isn't the side effect
of another table's row. The same planner, reused via a shared query-gathering helper, powers a new
read-only admin endpoint (`GET /api/admin/points/at-risk`) that lists at-risk users live.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-07-28-maintenance-reset-warning-design.md`

---

## File Structure

- Modify `src/domain/points/types.ts` — add `ResetWarningPlanItem`.
- Modify `src/domain/points/maintenance.ts` — add `planResetWarning`.
- Modify `src/domain/points/maintenance.test.ts` — unit tests for `planResetWarning`.
- Modify `src/domain/notifications/types.ts` — add `'MAINTENANCE_RESET_WARNING'`.
- Modify `src/domain/notifications/messages.ts` — add `maintenanceResetWarningMessage`.
- Modify `src/domain/notifications/messages.test.ts` — test for the new message.
- Create `migrations/0009_notification_reset_warning.sql` — table rebuild (new type, new
  `period_index` column, new unique index).
- Modify `src/lib/notifications.ts` — add `notifyMaintenanceResetWarning`.
- Modify `src/lib/maintenance.ts` — factor out query-gathering, wire the warning into
  `runMaintenance`, add `findAtRiskUsers` + `AtRiskUser`.
- Modify `test/maintenance.test.ts` — integration tests for the cron-side warning behavior.
- Modify `test/constraints.test.ts` — pin the new unique index's D1 error-message shape.
- Modify `src/routes/admin.ts` — add `GET /points/at-risk`.
- Modify `test/points.test.ts` — integration test for the new admin endpoint.
- Modify `docs/API.md` — document the new endpoint.

---

### Task 1: `planResetWarning` domain planner

**Files:**
- Modify: `src/domain/points/types.ts`
- Modify: `src/domain/points/maintenance.ts`
- Test: `src/domain/points/maintenance.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/points/maintenance.test.ts` (add the import alongside the existing one):

```ts
import { planMaintenance, planResetWarning } from './maintenance'
```

Add this new `describe` block at the end of the file, after the existing `describe('planMaintenance', ...)` block:

```ts
describe('planResetWarning', () => {
  it('no warning during warm-up, regardless of position in the period', () => {
    expect(
      planResetWarning({
        registeredAt: reg,
        lastAccruedPeriod: 2,
        approvedOrderDates: [],
        now: anniversaryDate(reg, 2),
      }),
    ).toBeNull()
  })

  it('no warning before the 2/3 mark of the target window', () => {
    expect(
      planResetWarning({
        registeredAt: reg,
        lastAccruedPeriod: 3,
        approvedOrderDates: [],
        now: new Date(anniversaryDate(reg, 3).getTime() - 1),
      }),
    ).toBeNull()
  })

  it('warns at exactly the 2/3 mark with no approved order in-window', () => {
    expect(
      planResetWarning({
        registeredAt: reg,
        lastAccruedPeriod: 3,
        approvedOrderDates: [],
        now: anniversaryDate(reg, 3),
      }),
    ).toEqual({ periodIndex: 4, warningRequired: true })
  })

  it('no warning when an approved order already covers the window', () => {
    expect(
      planResetWarning({
        registeredAt: reg,
        lastAccruedPeriod: 3,
        approvedOrderDates: [anniversaryDate(reg, 2)],
        now: anniversaryDate(reg, 3),
      }),
    ).toEqual({ periodIndex: 4, warningRequired: false })
  })

  it('no warning once the period is already due — planMaintenance owns that case', () => {
    expect(
      planResetWarning({
        registeredAt: reg,
        lastAccruedPeriod: 3,
        approvedOrderDates: [],
        now: anniversaryDate(reg, 4),
      }),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/domain/points/maintenance.test.ts`
Expected: FAIL — `planResetWarning` is not exported from `./maintenance`.

- [ ] **Step 3: Add `ResetWarningPlanItem` to the domain types**

In `src/domain/points/types.ts`, add this after the existing `MaintenancePlanItem` interface:

```ts
/** Whether the CTV should be warned about period `periodIndex`'s upcoming G-wallet reset. */
export interface ResetWarningPlanItem {
  periodIndex: number
  warningRequired: boolean
}
```

- [ ] **Step 4: Implement `planResetWarning`**

In `src/domain/points/maintenance.ts`, change the type import line from:

```ts
import type { MaintenancePlanItem } from './types'
```

to:

```ts
import type { MaintenancePlanItem, ResetWarningPlanItem } from './types'
```

Then append this function at the end of the file:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/domain/points/maintenance.test.ts`
Expected: PASS (all `planMaintenance` and `planResetWarning` tests green).

- [ ] **Step 6: Commit**

```bash
git add src/domain/points/types.ts src/domain/points/maintenance.ts src/domain/points/maintenance.test.ts
git commit -m "$(cat <<'EOF'
feat: add planResetWarning domain planner for G-wallet reset warnings

EOF
)"
```

---

### Task 2: Notification type + message copy

**Files:**
- Modify: `src/domain/notifications/types.ts`
- Modify: `src/domain/notifications/messages.ts`
- Test: `src/domain/notifications/messages.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/domain/notifications/messages.test.ts`, add `maintenanceResetWarningMessage` to the import list:

```ts
import {
  orderCreatedMessage,
  orderApprovedMessage,
  orderRejectedMessage,
  orderNeedsRevisionMessage,
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  maintenanceResetWarningMessage,
  redemptionMessage,
} from './messages'
```

Add this test in the `describe('notification messages', ...)` block, right after the
`'maintenance messages mention the period'` test:

```ts
  it('reset-warning message mentions the period and carries no point amount', () => {
    const { body } = maintenanceResetWarningMessage(4)
    expect(body).toContain('thứ 4')
    expect(body).not.toContain(String(POINTS.MAINTENANCE))
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/domain/notifications/messages.test.ts`
Expected: FAIL — `maintenanceResetWarningMessage` is not exported from `./messages`.

- [ ] **Step 3: Add the type and the message builder**

In `src/domain/notifications/types.ts`, add `'MAINTENANCE_RESET_WARNING'` to the union, right
after `'MAINTENANCE_RESET'`:

```ts
export type NotificationType =
  | 'ORDER_CREATED'
  | 'ORDER_APPROVED'
  | 'ORDER_REJECTED'
  | 'ORDER_NEEDS_REVISION'
  | 'REFERRAL_SIGNUP_BONUS'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'MAINTENANCE_RESET_WARNING'
  | 'REDEMPTION'
```

In `src/domain/notifications/messages.ts`, add this function right after `maintenanceResetMessage`:

```ts
export function maintenanceResetWarningMessage(periodIndex: number): NotificationContent {
  return {
    title: 'Ví G sắp bị đặt lại',
    body:
      `Ví G của bạn có thể bị đặt lại về 0 vào chu kỳ tháng thứ ${periodIndex} nếu không có đơn ` +
      `hàng nào được duyệt trước thời điểm đó. Hãy giới thiệu thêm khách hàng để duy trì điểm.`,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/domain/notifications/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/notifications/types.ts src/domain/notifications/messages.ts src/domain/notifications/messages.test.ts
git commit -m "$(cat <<'EOF'
feat: add MAINTENANCE_RESET_WARNING notification type and copy

EOF
)"
```

---

### Task 3: Migration — rebuild `notifications`

**Files:**
- Create: `migrations/0009_notification_reset_warning.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/0009_notification_reset_warning.sql`:

```sql
-- Add MAINTENANCE_RESET_WARNING to the notification taxonomy (docs/superpowers/specs/
-- 2026-07-28-maintenance-reset-warning-design.md): a heads-up sent once a CTV's G-wallet window
-- is 2/3 elapsed with no APPROVED order yet, ~1 month before MAINTENANCE_RESET would fire.
--
-- Unlike every other notification type, this one isn't the side effect of another table's row
-- (no order_id, no ledger_id) — it's a time-based projection computed by the daily maintenance
-- cron. Idempotency (send at most once per user per period) is enforced by a UNIQUE index on
-- (user_id, period_index), so it needs its own nullable period_index column.
--
-- CHECK constraints can't be altered in place, so this is a table rebuild, same technique as 0006.

CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
                 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'MAINTENANCE_RESET_WARNING',
                 'REDEMPTION')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  order_id     TEXT REFERENCES orders(id),
  ledger_id    TEXT REFERENCES point_ledger(id),
  period_index INTEGER,
  read_at      TEXT,
  created_at   TEXT NOT NULL,

  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'REDEMPTION'))),
  CHECK ((period_index IS NOT NULL) = (type = 'MAINTENANCE_RESET_WARNING'))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

-- Idempotency guard for MAINTENANCE_RESET_WARNING: at most one row per (user, period).
CREATE UNIQUE INDEX uq_notifications_reset_warning ON notifications(user_id, period_index)
  WHERE type = 'MAINTENANCE_RESET_WARNING';
```

- [ ] **Step 2: Verify the whole suite still boots against the new schema**

Run: `pnpm exec vitest run test/notifications.test.ts`
Expected: PASS — `test/apply-migrations.ts` applies every file under `migrations/` (via
`readD1Migrations('./migrations')` in `vitest.config.ts`) before each test, so this migration is
picked up automatically; existing notification behavior is unaffected.

- [ ] **Step 3: Commit**

```bash
git add migrations/0009_notification_reset_warning.sql
git commit -m "$(cat <<'EOF'
feat: add MAINTENANCE_RESET_WARNING type and period_index to notifications

EOF
)"
```

---

### Task 4: `notifyMaintenanceResetWarning` insert builder

**Files:**
- Modify: `src/lib/notifications.ts`

No new test in this task — it's exercised end-to-end by Task 5's integration tests. This task is a
narrow, mechanical addition matching the file's existing builder style.

- [ ] **Step 1: Add the import**

In `src/lib/notifications.ts`, add `maintenanceResetWarningMessage` to the existing import block:

```ts
import {
  orderCreatedMessage,
  orderApprovedMessage,
  orderRejectedMessage,
  orderNeedsRevisionMessage,
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  maintenanceResetWarningMessage,
  redemptionMessage,
} from '../domain/notifications/messages'
```

- [ ] **Step 2: Add the builder**

Append this function at the end of `src/lib/notifications.ts`, after `notifyRedemption`:

```ts
/** MAINTENANCE_RESET_WARNING → the user. Unlike every other builder here, there's no triggering
 *  table row to SELECT from — it's a time-based projection the maintenance cron computes, so this
 *  is a plain INSERT. Idempotency (once per user per period) is enforced by the UNIQUE index
 *  ux_notifications_reset_warning; the caller (lib/maintenance.ts) catches that violation. */
export function notifyMaintenanceResetWarning(
  db: D1Database,
  userId: string,
  periodIndex: number,
  now: string,
): D1PreparedStatement {
  const content = maintenanceResetWarningMessage(periodIndex)
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, period_index, created_at)
       VALUES (?, ?, 'MAINTENANCE_RESET_WARNING', ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), userId, content.title, content.body, periodIndex, now)
}
```

- [ ] **Step 3: Confirm the project still typechecks**

Run: `pnpm exec tsc --noEmit`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications.ts
git commit -m "$(cat <<'EOF'
feat: add notifyMaintenanceResetWarning insert builder

EOF
)"
```

---

### Task 5: Wire the warning into the daily cron

**Files:**
- Modify: `src/lib/maintenance.ts`
- Test: `test/maintenance.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/maintenance.test.ts`, add this helper right after `gBalance`:

```ts
async function resetWarningCount(userId: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'MAINTENANCE_RESET_WARNING'`)
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}
```

Add this `describe` block at the end of the file, after the existing `describe('runMaintenance', ...)` block:

```ts
describe('runMaintenance — reset warning', () => {
  it('does not warn during warm-up (periods 1–3)', async () => {
    const id = await seedUser(REG)
    await runMaintenance(env.DB, anniversaryDate(reg, 2))
    await runMaintenance(env.DB, anniversaryDate(reg, 2)) // same instant again: lastAccruedPeriod
                                                            // is now 2 → target period 3, still warm-up
    expect(await resetWarningCount(id)).toBe(0)
  })

  it('warns exactly once when 2/3 into period 4\'s window with no approved order', async () => {
    const id = await seedUser(REG)
    await runMaintenance(env.DB, anniversaryDate(reg, 3)) // catches up periods 1–3; this pass's
                                                            // warning check still uses the pre-run
                                                            // lastAccruedPeriod (0) — warm-up, no warning.
    expect(await resetWarningCount(id)).toBe(0)

    await runMaintenance(env.DB, anniversaryDate(reg, 3)) // same instant: lastAccruedPeriod is now
                                                            // 3 → target period 4, exactly the 2/3 mark.
    expect(await resetWarningCount(id)).toBe(1)

    await runMaintenance(env.DB, anniversaryDate(reg, 3)) // repeat run: no duplicate.
    expect(await resetWarningCount(id)).toBe(1)
  })

  it('does not warn when an approved order already covers the window', async () => {
    const id = await seedUser(REG)
    await seedApprovedOrder(id, anniversaryDate(reg, 2).toISOString()) // inside period-4's window
    await runMaintenance(env.DB, anniversaryDate(reg, 3))
    await runMaintenance(env.DB, anniversaryDate(reg, 3))
    expect(await resetWarningCount(id)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/maintenance.test.ts`
Expected: FAIL — no `MAINTENANCE_RESET_WARNING` rows are ever created yet (`resetWarningCount`
stays 0 in the second test's later assertions).

- [ ] **Step 3: Refactor the query-gathering and wire in the warning**

Replace the full contents of `src/lib/maintenance.ts` with:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/maintenance.test.ts`
Expected: PASS — all existing `runMaintenance` tests plus the new `runMaintenance — reset warning`
block.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm test`
Expected: PASS across the board (this file is imported by other suites indirectly through the
cron/notification machinery, so a full run is worth the extra minute here).

- [ ] **Step 6: Commit**

```bash
git add src/lib/maintenance.ts test/maintenance.test.ts
git commit -m "$(cat <<'EOF'
feat: send a reset-warning notification from the maintenance cron

EOF
)"
```

---

### Task 6: Pin the new unique index's error shape

**Files:**
- Modify: `test/constraints.test.ts`

- [ ] **Step 1: Write the test**

In `test/constraints.test.ts`, add this test inside the existing `describe(...)` block, after the
`R3 uq_ledger_user_period_type` test:

```ts
  it('uq_notifications_reset_warning: a duplicate (user, period) warning is named in the error', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111116')
    const row = (id: string) =>
      env.DB.prepare(
        `INSERT INTO notifications (id, user_id, type, title, body, period_index, created_at)
         VALUES (?, ?, 'MAINTENANCE_RESET_WARNING', 't', 'b', 4, '2026-01-01T00:00:00.000Z')`,
      ).bind(id, uid)

    await row(crypto.randomUUID()).run()
    const msg = await captureError(() => row(crypto.randomUUID()).run())
    expect(msg).toContain('UNIQUE constraint failed')
    expect(msg).toMatch(/uq_notifications_reset_warning|notifications\.period_index/) // isAlreadyWarned
  })
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm exec vitest run test/constraints.test.ts`
Expected: PASS. (This test doesn't need to "fail first" — Task 3's migration and Task 5's
`isAlreadyWarned` already exist; this step only pins the current D1 error shape against future
regressions, per the file's stated purpose.)

- [ ] **Step 3: Commit**

```bash
git add test/constraints.test.ts
git commit -m "$(cat <<'EOF'
test: pin uq_notifications_reset_warning's D1 error-message shape

EOF
)"
```

---

### Task 7: Admin at-risk endpoint

**Files:**
- Modify: `src/routes/admin.ts`
- Test: `test/points.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/points.test.ts`, add this helper near the top of the file, after `ledgerCount`:

```ts
// Same day-of-month as right now, `months` months earlier (UTC) — so anniversaryDate(registeredAt, months)
// lands exactly on today, letting tests place "now" at a precise point in a maintenance window
// without needing to fake the system clock.
function registeredMonthsAgo(months: number): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())).toISOString()
}

async function seedAccrual(userId: string, periodIndex: number, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
     VALUES (?, ?, 'G', 'MAINTENANCE_ACCRUAL', 10, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, periodIndex, createdAt)
    .run()
}
```

Add this new `describe` block at the end of the file:

```ts
describe('admin at-risk listing', () => {
  it('lists a user 2/3 into an empty window, and omits one with an in-window approved order', async () => {
    const admin = await seedAdmin()
    const atRisk = await registerUser(admin.referralCode, '0912345678')
    const safe = await registerUser(admin.referralCode, '0987654321')

    // Both "registered" 3 months ago with periods 1–3 already accrued: today sits exactly at the
    // 2/3 mark of period 4's window [anniv(1), anniv(4)).
    const registeredAt = registeredMonthsAgo(3)
    await env.DB
      .prepare('UPDATE users SET created_at = ? WHERE id IN (?, ?)')
      .bind(registeredAt, atRisk.id, safe.id)
      .run()
    for (const id of [atRisk.id, safe.id]) {
      for (let p = 1; p <= 3; p++) await seedAccrual(id, p, registeredAt)
    }

    // `safe` has an approved order landing inside the current window → not at risk.
    const order = await createPendingOrder(safe.token, '0900000001')
    await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)

    const res = await get('/api/admin/points/at-risk', admin.token)
    expect(res.status).toBe(200)
    const { users } = await res.json<{ users: { userId: string; periodIndex: number }[] }>()
    const ids = users.map((u) => u.userId)
    expect(ids).toContain(atRisk.id)
    expect(ids).not.toContain(safe.id)
    expect(users.find((u) => u.userId === atRisk.id)!.periodIndex).toBe(4)
  })

  it('requires SUPER_ADMIN', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    expect((await get('/api/admin/points/at-risk')).status).toBe(401)
    expect((await get('/api/admin/points/at-risk', a.token)).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/points.test.ts`
Expected: FAIL — `GET /api/admin/points/at-risk` doesn't exist yet (404, or the `requires
SUPER_ADMIN` test fails because there's no route to reject).

- [ ] **Step 3: Add the route**

In `src/routes/admin.ts`, add `findAtRiskUsers` to the imports:

```ts
import { approveOrder, listOrders, rejectOrder, requestRevision, toOrder } from '../lib/orders'
import { redeem } from '../lib/redemptions'
import { findAtRiskUsers } from '../lib/maintenance'
```

Add this route after the `--- Balances & ledger (PRD FR6/FR7) ---` section's `GET /ledger` route
(i.e. right before the `--- Social-proof posts ...` comment):

```ts
// --- Maintenance reset warnings ---

// Live snapshot of every CTV currently 2/3 through their G-wallet window with no approved order
// yet — independent of whether the cron has already sent them the in-app warning.
adminRoutes.get('/points/at-risk', async (c) => {
  const users = await findAtRiskUsers(c.env.DB, new Date())
  return c.json({ users })
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/points.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: PASS across the board.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.ts test/points.test.ts
git commit -m "$(cat <<'EOF'
feat: add GET /api/admin/points/at-risk

EOF
)"
```

---

### Task 8: Document the new endpoint

**Files:**
- Modify: `docs/API.md`

- [ ] **Step 1: Add the endpoint doc**

In `docs/API.md`, insert this new subsection right after the `GET /api/admin/ledger` section
(after its `---` separator, before `## Social-proof posts`):

```markdown
#### `GET /api/admin/points/at-risk`

Live list of every CTV currently 2/3 through their G-wallet's rolling window with no APPROVED
order yet (~1 month before `MAINTENANCE_RESET` would fire). Independent of whether that CTV has
already received the in-app `MAINTENANCE_RESET_WARNING` notification for this period.

**Success — `200`**

```json
{
  "users": [
    { "userId": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "periodIndex": 4, "resetsAt": "2026-11-15T00:00:00.000Z" }
  ]
}
```

No query params, no pagination — this scans all `USER` rows the same way the maintenance cron
already does, which is fine at the documented <1,000-user scale (tech-spec §6.4.1).

---
```

- [ ] **Step 2: Commit**

```bash
git add docs/API.md
git commit -m "$(cat <<'EOF'
docs: document GET /api/admin/points/at-risk

EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** migration + domain planner (spec §Data model/§Domain logic) → Tasks 1, 3;
  cron-side notification (§Cron integration) → Tasks 2, 4, 5, 6; admin API (§Admin API) → Task 7;
  testing plan (§Testing) → covered inline in Tasks 1, 5, 6, 7. Task 8 (API.md) is an addition
  beyond the spec's explicit scope, added because every other `/api/admin/*` endpoint is
  documented there.
- **Placeholder scan:** none found — every step has complete code and exact commands.
- **Type consistency:** `ResetWarningPlanItem { periodIndex, warningRequired }` (Task 1) is the
  return shape of `planResetWarning` (Task 1) and is what `runMaintenance` (Task 5) and
  `findAtRiskUsers` (Task 5) destructure (`warning.periodIndex`, `warning.warningRequired`) —
  consistent throughout. `AtRiskUser` (Task 5) matches exactly what the route (Task 7) returns and
  what the test (Task 7) and docs (Task 8) assert against.
