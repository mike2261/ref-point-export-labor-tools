# Maintenance reset warning — design

## Purpose

CTV whose G-wallet is about to be reset (rolling 3-month window, PRD §6.4) currently only find
out *after* the reset happens, via `MAINTENANCE_RESET`. This adds an early warning:

- The CTV gets a one-time in-app notification once 2 of the current window's 3 months have
  elapsed with no APPROVED order yet in that window (~1 month left before reset).
- The admin gets an on-demand API to list every CTV currently in that warning zone.

Not in scope (explicitly deferred by the user): notifying on a failed/insufficient-balance
redemption attempt.

## Data model

`notifications` is rebuilt (same technique as migration 0006 — SQLite can't ALTER a CHECK
constraint in place):

- Add `'MAINTENANCE_RESET_WARNING'` to the `type` CHECK.
- Add nullable `period_index INTEGER` column.
- Add `CHECK ((period_index IS NOT NULL) = (type = 'MAINTENANCE_RESET_WARNING'))`.
- Add `CREATE UNIQUE INDEX ux_notifications_reset_warning ON notifications(user_id, period_index)
  WHERE type = 'MAINTENANCE_RESET_WARNING'` — the correctness guard for "send at most once per
  (user, period)", mirroring `uq_ledger_user_period_type` (R3) on `point_ledger`.

This notification type carries neither `order_id` nor `ledger_id` (both existing CHECKs already
exclude it from their type lists, so both stay NULL for these rows) — it isn't the side effect of
another table's row, it's a time-based projection.

## Domain logic

New pure function in `src/domain/points/maintenance.ts`, alongside `planMaintenance`:

```ts
export function planResetWarning(input: {
  registeredAt: Date
  lastAccruedPeriod: number
  approvedOrderDates: Date[]
  now: Date
}): { periodIndex: number; warningRequired: boolean } | null
```

Logic:
1. `target = max(lastAccruedPeriod + 1, 1)` — the next period that would accrue/reset.
2. If `target <= WARMUP_PERIODS`, return `null` (no reset risk yet).
3. Window for `target` is `[anniversary(target - WINDOW_PERIODS), anniversary(target))` (same as
   `planMaintenance`). The 2/3 mark is `anniversary(target - 1)`.
4. If `now < anniversary(target - 1)` (not yet 2 months in) or `now >= anniversary(target)` (the
   period is already due — `planMaintenance` owns that case, not this function), return `null`.
5. Otherwise: `warningRequired = !approvedOrderDates.some(d => windowStart <= d < now)`.

Because "due" (`now >= anniversary(target)`) and "in warning zone"
(`anniversary(target-1) <= now < anniversary(target)`) are mutually exclusive, this can be
computed from the *same* `lastAccruedPeriod` used for `planMaintenance` in the same cron pass,
before that pass's accruals are applied — no ordering dependency between the two.

## Cron integration

`src/lib/maintenance.ts`:

- Factor the existing "gather users + last-accrued-period + approved-order-dates" queries out of
  `runMaintenance` into a shared helper (used by the cron loop AND the new admin listing below).
- In the existing per-user loop, after computing `plan`, also call `planResetWarning` with that
  user's original `lastAccruedPeriod`. If `warningRequired`, insert one notification row.
- The insert is a plain `INSERT` (no triggering row to `SELECT ... FROM`), wrapped in the same
  try/catch pattern as `applyPeriod`'s `isAlreadyProcessed`: a UNIQUE violation on
  `ux_notifications_reset_warning` means this (user, period) was already warned — swallow it;
  any other error stays loud.

Message copy, added to `src/domain/notifications/messages.ts`:

```ts
export function maintenanceResetWarningMessage(periodIndex: number): NotificationContent {
  return {
    title: 'Ví G sắp bị đặt lại',
    body: `Ví G của bạn có thể bị đặt lại về 0 vào chu kỳ tháng thứ ${periodIndex} nếu không có ` +
      `đơn hàng nào được duyệt trước thời điểm đó. Hãy giới thiệu thêm khách hàng để duy trì điểm.`,
  }
}
```

`'MAINTENANCE_RESET_WARNING'` is added to `NotificationType` in
`src/domain/notifications/types.ts`.

## Admin API

New shared function in `src/lib/maintenance.ts`:

```ts
export async function findAtRiskUsers(db: D1Database, now: Date): Promise<AtRiskUser[]>
```

Reuses the shared gather-helper, maps every user through `planResetWarning`, and keeps only
entries where the result is non-null and `warningRequired` is true — computed live at call time,
independent of whether a notification was already sent for that period.

`AtRiskUser`: `{ userId, fullName, phone, periodIndex, resetsAt }` (`resetsAt` = ISO timestamp of
`anniversary(periodIndex)`, i.e. when the reset would fire if nothing changes).

New route in `src/routes/admin.ts`, alongside the balances/ledger section:

```
GET /api/admin/points/at-risk
→ { users: AtRiskUser[] }
```

No pagination — this scans all `role = 'USER'` rows the same way `runMaintenance` already does,
which the codebase already treats as fine at the documented <1,000-user scale (tech-spec §6.4.1).

## Testing

- `planResetWarning`: unit tests in `src/domain/points/maintenance.test.ts` mirroring the existing
  `planMaintenance` cases — warm-up (no warning), before the 2/3 mark (no warning), in the warning
  zone with/without an approved order in-window, and at/after the period's due date (no warning —
  handled by `planMaintenance` instead).
- `runMaintenance`: extend `test/maintenance.test.ts` to assert the warning notification is
  created once, is not duplicated on a repeated cron pass for the same period, and disappears
  (isn't sent) once an approved order lands in the window.
- Admin route: extend `test/notifications.test.ts` or a new block in `test/admin-users.test.ts`
  (whichever suits the existing route test layout) covering the at-risk list content and its
  absence of duplicates/pagination surprises.
