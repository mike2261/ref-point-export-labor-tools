# Admin-triggered point bonus (replaces monthly maintenance) — design

## Purpose

The G-wallet "maintenance" mechanic (PRD §6.4) auto-credited every CTV +100 points/month via a
daily cron, and reset G to 0 if the CTV had no APPROVED order in the trailing 3-month window.
This is being replaced entirely: there is no more automatic monthly accrual and no more reset.

Instead, the super admin manually grants bonus points, on demand, with a message describing why:

- **Broadcast**: grant N points + a message to every CTV (`role = 'USER'`) at once.
- **Individual**: grant N points + a message to one CTV, looked up by phone number.

Granted points still land in the G wallet, still never expire/reset on their own, and still drain
to 0 automatically the moment that CTV's first customer order is activated (existing
`activateCustomer()` behavior — unchanged). This is the same "accumulate until you close a
customer" semantics the old G wallet had; only the *source* of G credits changes, from a cron to
an admin action.

Existing history (`MAINTENANCE_ACCRUAL`/`MAINTENANCE_RESET` ledger rows and
`MAINTENANCE_RESET_WARNING` notifications already sent) is left untouched — this is a forward-only
change. Every CTV's current G balance carries over unchanged; nothing is reset as part of this
migration.

## Data model

### New table: `bonus_grants`

One row per admin bonus action (broadcast or individual) — the audit/history record, and the
idempotency boundary that makes a double-submit (double-click, retried request) a no-op instead of
a double payout.

```sql
CREATE TABLE bonus_grants (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('ALL', 'PHONE')),
  target_user_id   TEXT REFERENCES users(id),   -- set iff scope = 'PHONE'
  amount           INTEGER NOT NULL CHECK (amount > 0),
  content          TEXT NOT NULL,               -- admin-authored message, shown to recipients
  recipient_count  INTEGER NOT NULL,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,

  CHECK ((target_user_id IS NOT NULL) = (scope = 'PHONE'))
);

CREATE UNIQUE INDEX uq_bonus_grants_idem ON bonus_grants(idempotency_key);
CREATE INDEX idx_bonus_grants_created ON bonus_grants(created_at, id);
```

`idempotency_key` is client-generated (same pattern as `activateCustomerSchema.idempotencyKey`),
one per admin submit. A retried/duplicate submit hits the unique index and is treated as "already
processed" — mirrors `isAlreadyProcessed`/`isDuplicateRedemption` elsewhere in the codebase.

### `point_ledger` rebuild

SQLite can't ALTER a CHECK constraint in place — this is a table rebuild, same technique as
migrations 0006/0009/0011/the point_ledger FK rebuild.

- Add `'ADMIN_BONUS'` to the `type` CHECK.
- Add nullable `bonus_grant_id TEXT REFERENCES bonus_grants(id)`.
- Sign discipline: add `ADMIN_BONUS` to the positive-points type list (it's a credit).
- Wallet discipline: add `ADMIN_BONUS` alongside `MAINTENANCE_ACCRUAL`/`MAINTENANCE_RESET` in the
  `wallet = 'G'` case branch.
- Linkage discipline: add `CHECK ((bonus_grant_id IS NOT NULL) = (type = 'ADMIN_BONUS'))`,
  following the existing pattern for `order_id`/`subject_user_id`/`period_index`.

All existing rows (including historical `MAINTENANCE_ACCRUAL`/`MAINTENANCE_RESET`) stay exactly as
they are — those types remain valid in the rebuilt CHECK; the application simply stops writing new
ones.

### `notifications` rebuild

Same technique. Add `'ADMIN_BONUS'` to the `type` CHECK and to the `ledger_id`-required list
(alongside `MAINTENANCE_ACCRUAL`, etc. — an `ADMIN_BONUS` notification is always the side effect of
its ledger row, like every other point-event notification).

### `NotificationType` (`src/domain/notifications/types.ts`)

Add `'ADMIN_BONUS'` to the union.

### `LedgerType` (`src/domain/points/types.ts`)

Add `'ADMIN_BONUS'` to the union. Remove `MaintenancePlanItem` and `ResetWarningPlanItem` (no
longer produced by anything).

## Backend logic

### `src/lib/bonuses.ts` (new)

```ts
export interface GrantBonusInput {
  scope: 'ALL' | 'PHONE'
  phone?: string        // required iff scope === 'PHONE'
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

export async function grantBonus(db: D1Database, input: GrantBonusInput): Promise<GrantBonusResult>
```

Steps:

1. `scope === 'PHONE'`: `findByPhone(db, phone)` — if missing or not `role = 'USER'`, return
   `PHONE_NOT_FOUND`. Resolve to a one-element recipient list.
   `scope === 'ALL'`: `SELECT id, full_name, phone FROM users WHERE role = 'USER'` — same query
   `gatherMaintenanceContext` used, so "all CTV" means exactly what it always meant.
2. Insert the `bonus_grants` row (`recipient_count` = recipients found). A UNIQUE violation on
   `idempotency_key` → return `DUPLICATE` (no ledger rows touched — the grant row is written before
   any per-user work, so a duplicate submit is caught up front).
3. For each recipient, in its own small batch (`db.batch([...])`), isolated by try/catch — same
   failure-isolation pattern as `runMaintenance`'s per-user loop, so one bad row never sinks the
   whole broadcast:
   - `INSERT INTO point_ledger (id, user_id, wallet, type, points, bonus_grant_id, note, created_by, created_at) VALUES (?, ?, 'G', 'ADMIN_BONUS', ?, ?, ?, ?, ?)` — `points = amount`, `note = content`.
   - `notifyAdminBonus(db, ledgerId, amount, content, now)` appended to the same batch (so the
     notification only exists if its ledger row committed — the established pattern).
4. Return the grant row.

No cron, no periods, no rolling windows — this is deliberately the simplest possible write path.

### `src/lib/notifications.ts`

Add, next to `notifyMaintenance`:

```ts
/** ADMIN_BONUS → the user, linked to the specific ledger row by id. */
export function notifyAdminBonus(
  db: D1Database,
  ledgerId: string,
  amount: number,
  content: string,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    { type: 'ADMIN_BONUS', content: adminBonusMessage(amount, content), whereSql: `l.id = ?`, binds: [ledgerId] },
    now,
  )
}
```

### `src/domain/notifications/messages.ts`

```ts
export function adminBonusMessage(amount: number, content: string): NotificationContent {
  return {
    title: 'Bạn nhận điểm thưởng',
    body: `Bạn được cộng ${amount} điểm thưởng vào ví G: ${content}`,
  }
}
```

Remove `maintenanceResetWarningMessage` (its only caller is deleted below). Keep
`maintenanceAccrualMessage`/`maintenanceResetMessage` deleted too — they're write-path only
(nothing reads them back to render history; the admin ledger view renders historical rows from
their stored `type`, via the frontend's static label map, not by re-deriving copy).

## Admin API (`src/routes/admin.ts`)

```
POST /api/admin/bonuses
  body: { scope: 'ALL' | 'PHONE', phone?: string, amount: number, content: string, idempotencyKey: string }
  → 201 { grant: BonusGrant }
  → 404 { error: 'phone not found' }              (scope=PHONE, no matching CTV)
  → 409 { error: 'duplicate grant', code: 'DUPLICATE' }

GET /api/admin/bonuses?page=&limit=
  → { grants: BonusGrant[], page, limit, total }   -- history list, newest first

GET /api/admin/bonuses/preview?scope=ALL
  → { recipientCount: number }                     -- backs the FE confirm dialog's "N CTV" count
```

`amount`/`content` validated with `arktype`, same style as `activateCustomerSchema`: `amount:
'1 <= number.integer <= 100000'` (matches the existing `points <> 0`/positive-credit constraint,
generous upper bound — no product-mandated cap was given), `content: '1 <= string <= 500'`.

Add `'ADMIN_BONUS'` to the `LEDGER_TYPES` array (line 30) so `GET /api/admin/ledger?type=` accepts
it as a filter.

## Removed (old maintenance system)

- `src/lib/maintenance.ts`, `src/domain/points/maintenance.ts`, `src/domain/points/periods.ts` —
  deleted entirely.
- `src/scheduled.ts` — deleted; remove its import/wiring in `src/index.ts` (`scheduled` export)
  and the `"triggers": { "crons": [...] }` block in `wrangler.jsonc`.
- `GET /api/admin/points/at-risk` route and `findAtRiskUsers` — deleted (no replacement; the whole
  "at risk of reset" concept no longer exists).
- `notifyMaintenanceResetWarning`, `maintenanceResetWarningMessage` — deleted.
- `WARMUP_PERIODS`, `WINDOW_PERIODS`, `POINTS.MAINTENANCE` in `src/domain/points/constants.ts` —
  deleted (unused once nothing accrues on a schedule).
- `uq_notifications_reset_warning` index and the `period_index` column on `notifications` become
  dead weight (no new rows will ever set them) but are left in place — dropping them needs another
  table rebuild for no functional gain, since old `MAINTENANCE_RESET_WARNING` rows still reference
  `period_index` for display.

`notifyMaintenance` (the `MAINTENANCE_ACCRUAL`/`MAINTENANCE_RESET` builder) and its two message
functions are deleted too, since `runMaintenance` — their only caller — is gone.

## Frontend (`xkld-tools-client`)

New admin page, `src/routes/admin/bonuses.tsx` (or similar — first "dedicated place" for this
workflow, per the request):

- **Section 1 — Broadcast to all CTV.** Amount + content inputs. On submit, fetch
  `GET /api/admin/bonuses/preview?scope=ALL` and show a confirm dialog: "Sắp thưởng {amount} điểm
  cho {recipientCount} CTV: \"{content}\". Xác nhận?" — only on confirm does it
  `POST /api/admin/bonuses` with `scope: 'ALL'`.
- **Section 2 — Individual by phone.** Phone + amount + content inputs. Same confirm-then-submit
  shape, `scope: 'PHONE'`; a 404 response renders "Không tìm thấy CTV với số điện thoại này."
- **Section 3 — History.** Table from `GET /api/admin/bonuses`: date, scope (badge:
  "Toàn bộ"/"Cá nhân" + phone if PHONE), amount, content, recipient count.

`src/lib/ledgerFilters.ts`: add `ADMIN_BONUS: 'Thưởng điểm'` to the existing type-label map (used
by the admin ledger viewer to render this new row type like every other).

`src/lib/notifications.ts`: add an icon for `ADMIN_BONUS` (e.g. `🎁`) to the existing type→icon map.

No changes needed to `redeem.tsx` — the unlock/drain semantics it depends on
(`hasCustomerReward`, `activateCustomer` draining both wallets) are untouched.

## Testing

- `src/lib/bonuses.test.ts` (or a `test/admin-bonuses.test.ts` route-level test, matching the
  existing split between domain-level and route-level tests in this codebase): broadcast credits
  every `role = 'USER'` row and no others; individual credits exactly the phone-matched user;
  phone-not-found returns the typed error; a repeated `idempotencyKey` is a no-op (no second
  `bonus_grants` row, no second `point_ledger` rows, original `grant` returned or a clear
  `DUPLICATE`); one failing recipient (e.g. simulate a constraint violation) doesn't stop the rest
  of a broadcast from being credited.
- `test/constraints.test.ts`: extend with the new CHECK cases — `ADMIN_BONUS` requires
  `bonus_grant_id`, rejects negative points, rejects wallet `F`.
- Delete `src/domain/points/maintenance.test.ts`, `src/domain/points/periods.test.ts`,
  `test/maintenance.test.ts` (or the maintenance-specific blocks within it) — their subject no
  longer exists.
- `test/notifications.test.ts`: add an `ADMIN_BONUS` case (content flows into the notification
  body); drop any `MAINTENANCE_RESET_WARNING`-specific cases that only made sense with the cron.
