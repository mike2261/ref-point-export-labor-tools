# Admin-triggered point bonus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monthly maintenance cron (auto G-wallet accrual + 3-month reset) with admin-triggered point bonuses — the super admin grants points + a message to all CTV at once, or to one CTV by phone, on demand, with no expiry.

**Architecture:** A new `bonus_grants` audit/idempotency table plus a new `ADMIN_BONUS` `point_ledger`/`notifications` type (both tables rebuilt, SQLite CHECK constraints can't ALTER in place). New `src/lib/bonuses.ts` does the write; two new admin routes expose it. The old cron (`src/scheduled.ts`, `src/lib/maintenance.ts`, `src/domain/points/{maintenance,periods}.ts`) is deleted outright — no feature flag, no dual-write. `scripts/seed-demo.ts` is updated to stop calling the deleted planners and demonstrate the new grants instead. Frontend gets one new admin page (`/admin/bonuses`) reusing the existing `UserPicker`/`AdminModal` patterns from `orders.tsx`.

**Tech Stack:** Hono + arktype (backend routes), D1/SQLite (raw SQL, no ORM), Vitest + `@cloudflare/vitest-pool-workers` (tests), React + TanStack Router/Query + shadcn-style components (frontend).

**Spec:** `docs/superpowers/specs/2026-08-03-admin-point-bonus-design.md` (approved).

---

## Task 1: Migration — `bonus_grants` table + rebuild `point_ledger`/`notifications`

**Files:**
- Create: `migrations/0012_admin_bonus.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Admin-triggered point bonus (design: docs/superpowers/specs/2026-08-03-admin-point-bonus-design.md).
-- Replaces the monthly maintenance cron entirely: the admin now grants G-wallet points on demand,
-- to every CTV at once or to one CTV by phone, with a message explaining why. Points no longer
-- expire or reset — MAINTENANCE_ACCRUAL/MAINTENANCE_RESET stay valid for existing history, but
-- nothing writes them anymore.
--
-- bonus_grants is the audit/idempotency record for one admin action (one broadcast or one
-- individual grant); point_ledger.bonus_grant_id links each resulting ADMIN_BONUS row back to it,
-- the same way order_id/subject_user_id/period_index link other row kinds to their trigger.
--
-- CHECK constraints can't be altered in place, so point_ledger and notifications are rebuilt, same
-- technique as migrations 0005/0006/0009/0011. bonus_grants only references users(id), which isn't
-- being rebuilt, so it's created first, plain.

CREATE TABLE bonus_grants (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('ALL', 'PHONE')),
  target_user_id  TEXT REFERENCES users(id),   -- set iff scope = 'PHONE'
  amount          INTEGER NOT NULL CHECK (amount > 0),
  content         TEXT NOT NULL,               -- admin-authored message, shown to recipients
  recipient_count INTEGER NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,

  CHECK ((target_user_id IS NOT NULL) = (scope = 'PHONE'))
);

CREATE UNIQUE INDEX uq_bonus_grants_idem ON bonus_grants(idempotency_key);
CREATE INDEX idx_bonus_grants_created ON bonus_grants(created_at, id);

-- point_ledger rebuild: add ADMIN_BONUS (credit, G-only, requires bonus_grant_id) alongside the
-- existing types. order_id still references the live `orders` table (untouched by this migration).
CREATE TABLE point_ledger_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wallet          TEXT NOT NULL CHECK (wallet IN ('F', 'G')),
  type            TEXT NOT NULL CHECK (type IN (
                    'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
                    'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS',
                    'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION')),
  points          INTEGER NOT NULL CHECK (points <> 0),
  order_id        TEXT REFERENCES orders(id),
  subject_user_id TEXT REFERENCES users(id),
  period_index    INTEGER CHECK (period_index >= 1),
  bonus_grant_id  TEXT REFERENCES bonus_grants(id),
  idempotency_key TEXT,
  note            TEXT,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,

  CHECK ((points > 0) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS',
         'MAINTENANCE_ACCRUAL', 'ADMIN_BONUS', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK (CASE
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS') THEN wallet = 'G'
    WHEN type = 'REDEMPTION' THEN 1
    ELSE wallet = 'F' END),
  CHECK ((order_id        IS NOT NULL) = (type IN ('CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK ((subject_user_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS'))),
  CHECK ((period_index    IS NOT NULL) = (type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET'))),
  CHECK ((bonus_grant_id  IS NOT NULL) = (type = 'ADMIN_BONUS')),
  CHECK ((idempotency_key IS NOT NULL) = (type = 'REDEMPTION'))
);

INSERT INTO point_ledger_new
  (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at)
SELECT
  id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at
FROM point_ledger;

-- notifications rebuild: add ADMIN_BONUS, always ledger-linked like MAINTENANCE_ACCRUAL. Must
-- reference point_ledger_new (not yet renamed) — same forward-reference technique as 0005.
CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
                 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'MAINTENANCE_RESET_WARNING',
                 'ADMIN_BONUS', 'REDEMPTION')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  order_id     TEXT REFERENCES orders(id),
  ledger_id    TEXT REFERENCES point_ledger_new(id),
  period_index INTEGER CHECK (period_index >= 1),
  read_at      TEXT,
  created_at   TEXT NOT NULL,

  CHECK ((order_id IS NOT NULL) = (type IN ('ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION'))),
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'CUSTOMER_REFERRAL_BONUS',
         'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS', 'REDEMPTION'))),
  CHECK ((period_index IS NOT NULL) = (type = 'MAINTENANCE_RESET_WARNING'))
);

INSERT INTO notifications_new (id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at)
SELECT id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at
FROM notifications;

DROP TABLE notifications;
DROP TABLE point_ledger;
ALTER TABLE point_ledger_new RENAME TO point_ledger;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE UNIQUE INDEX uq_ledger_order_type
  ON point_ledger(order_id, type) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_subject_type
  ON point_ledger(subject_user_id, type) WHERE subject_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_user_period_type
  ON point_ledger(user_id, period_index, type) WHERE period_index IS NOT NULL;
CREATE UNIQUE INDEX uq_ledger_idem
  ON point_ledger(idempotency_key, wallet) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_ledger_user_wallet_points ON point_ledger(user_id, wallet, points);
CREATE INDEX idx_ledger_user_created ON point_ledger(user_id, created_at, id);
CREATE INDEX idx_ledger_bonus_grant ON point_ledger(bonus_grant_id) WHERE bonus_grant_id IS NOT NULL;

CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at, id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX uq_notifications_reset_warning ON notifications(user_id, period_index)
  WHERE type = 'MAINTENANCE_RESET_WARNING';
```

- [ ] **Step 2: Apply it locally and confirm it runs clean**

Run: `npm run db:migrate:local`
Expected: `0012_admin_bonus.sql` listed as applied, no errors.

- [ ] **Step 3: Commit**

```bash
git add migrations/0012_admin_bonus.sql
git commit -m "feat: add bonus_grants table, ADMIN_BONUS ledger/notification type"
```

---

## Task 2: Domain types — `ADMIN_BONUS`, drop maintenance-only types

**Files:**
- Modify: `src/domain/points/types.ts`
- Modify: `src/domain/notifications/types.ts`

- [ ] **Step 1: Edit `src/domain/points/types.ts`**

Add `'ADMIN_BONUS'` to the `LedgerType` union, and delete `MaintenancePlanItem`/`ResetWarningPlanItem` (nothing will produce them once Task 9 deletes `src/domain/points/maintenance.ts`):

```ts
export type LedgerType =
  | 'REGISTRATION_BONUS'
  | 'REFERRAL_SIGNUP_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'ADMIN_BONUS'
  | 'CUSTOMER_REWARD'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'REDEMPTION'
```

Delete the `MaintenancePlanItem` and `ResetWarningPlanItem` interfaces entirely (the whole block from `/** One due maintenance period...` to the end of the file).

- [ ] **Step 2: Edit `src/domain/notifications/types.ts`**

Add `'ADMIN_BONUS'` to `NotificationType`, right after `'MAINTENANCE_RESET_WARNING'`:

```ts
export type NotificationType =
  | 'ORDER_CREATED'
  | 'ORDER_APPROVED'
  | 'ORDER_REJECTED'
  | 'ORDER_NEEDS_REVISION'
  | 'REGISTRATION_BONUS'
  | 'REFERRAL_SIGNUP_BONUS'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'MAINTENANCE_RESET_WARNING'
  | 'ADMIN_BONUS'
  | 'REDEMPTION'
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: fails right now (nothing produces `MaintenancePlanItem` yet, that's fine) — actually this file alone compiles standalone TS types with no consumers broken yet since `maintenance.ts` still imports these interfaces until Task 9. Skip a hard type-check here; move on. (Full-repo type-check happens naturally once `npm test` runs at the end of Task 9.)

- [ ] **Step 4: Commit**

```bash
git add src/domain/points/types.ts src/domain/notifications/types.ts
git commit -m "feat: add ADMIN_BONUS to LedgerType/NotificationType"
```

---

## Task 3: Notification copy — `adminBonusMessage`, drop maintenance messages

**Files:**
- Modify: `src/domain/notifications/messages.ts`
- Modify: `src/domain/notifications/messages.test.ts`

- [ ] **Step 1: Update the test first**

Replace the whole file:

```ts
import { describe, it, expect } from 'vitest'
import { POINTS } from '../points/constants'
import {
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from './messages'

describe('notification messages', () => {
  it('referral + customer referral bonuses quote their exact amounts', () => {
    expect(referralSignupBonusMessage().body).toContain(String(POINTS.REFERRAL_SIGNUP))
    expect(customerReferralBonusMessage('Trần Quốc Bảo').body).toContain(String(POINTS.CUSTOMER_REFERRAL))
  })

  it('customer referral bonus names the referred CTV who closed the customer', () => {
    const { body } = customerReferralBonusMessage('Trần Quốc Bảo')
    expect(body).toContain('Trần Quốc Bảo')
  })

  it('customer activated states the customer, order code, and both wallet payouts', () => {
    const { title, body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 720, 300)
    expect(title).toBe('Khách hàng đã được kích hoạt')
    expect(body).toContain('Trần Thị B')
    expect(body).toContain('DH-2026-0900')
    expect(body).toContain('720')
    expect(body).toContain('300')
  })

  it('customer activated omits the G wallet when there was nothing in it', () => {
    const { body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 500, 0)
    expect(body).toContain('500')
    expect(body).not.toContain('ví G')
  })

  it('admin bonus quotes the amount and includes the admin-authored content', () => {
    const { title, body } = adminBonusMessage(50, 'Thưởng mừng đạt mốc 50 CTV')
    expect(title).toBe('Bạn nhận điểm thưởng')
    expect(body).toContain('50')
    expect(body).toContain('Thưởng mừng đạt mốc 50 CTV')
  })

  it('redemption lists only the wallets actually deducted', () => {
    expect(redemptionMessage(5, 0).body).toContain('5 điểm ví F')
    expect(redemptionMessage(5, 0).body).not.toContain('ví G')
    expect(redemptionMessage(0, 3).body).toContain('3 điểm ví G')
    expect(redemptionMessage(5, 3).body).toContain('5 điểm ví F và 3 điểm ví G')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/domain/notifications/messages.test.ts`
Expected: FAIL — `adminBonusMessage` is not exported from `./messages`.

- [ ] **Step 3: Edit `src/domain/notifications/messages.ts`**

Remove `maintenanceAccrualMessage`, `maintenanceResetMessage`, `maintenanceResetWarningMessage` (three functions, lines 29–52 of the current file), and add in their place:

```ts
export function adminBonusMessage(amount: number, content: string): NotificationContent {
  return {
    title: 'Bạn nhận điểm thưởng',
    body: `Bạn được cộng ${amount} điểm thưởng vào ví G: ${content}`,
  }
}
```

- [ ] **Step 4: Run the test again**

Run: `npx vitest run src/domain/notifications/messages.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/notifications/messages.ts src/domain/notifications/messages.test.ts
git commit -m "feat: add adminBonusMessage, drop maintenance notification copy"
```

---

## Task 4: `src/lib/notifications.ts` — `notifyAdminBonus`, drop maintenance builders

**Files:**
- Modify: `src/lib/notifications.ts`

- [ ] **Step 1: Edit the imports**

Replace:

```ts
import {
  registrationBonusMessage,
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  maintenanceResetWarningMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../domain/notifications/messages'
```

with:

```ts
import {
  registrationBonusMessage,
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../domain/notifications/messages'
```

- [ ] **Step 2: Replace `notifyMaintenance`**

Delete the `notifyMaintenance` function (the one taking `kind: 'MAINTENANCE_ACCRUAL' | 'MAINTENANCE_RESET'`) and add in its place:

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

- [ ] **Step 3: Delete `notifyMaintenanceResetWarning`**

Delete the whole function (its only caller, `src/lib/maintenance.ts`, is removed in Task 9).

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications.ts
git commit -m "feat: add notifyAdminBonus, drop maintenance notification builders"
```

(Full test suite still red until Task 9 removes the dangling `maintenance.ts` imports — that's expected mid-plan; each task's own affected tests are checked individually. The whole suite is green again at the end of Task 9.)

---

## Task 5: `src/lib/bonuses.ts` — the write path

**Files:**
- Create: `src/lib/bonuses.ts`

- [ ] **Step 1: Write the file**

```ts
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/bonuses.ts
git commit -m "feat: add grantBonus/listBonusGrants (admin point bonus write path)"
```

(Covered end-to-end by the route-level test in Task 7 — there's no separable pure planner here the way `planMaintenance` was, so this isn't unit-tested in isolation.)

---

## Task 6: Admin routes — `POST/GET /api/admin/bonuses`, `GET /api/admin/bonuses/preview`; remove `/points/at-risk`

**Files:**
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Swap the `findAtRiskUsers` import for the new bonus functions**

Replace:

```ts
import { findAtRiskUsers } from '../lib/maintenance'
```

with:

```ts
import { grantBonus, listBonusGrants, countCtvUsers, toBonusGrant } from '../lib/bonuses'
```

- [ ] **Step 2: Add `'ADMIN_BONUS'` to `LEDGER_TYPES`**

```ts
const LEDGER_TYPES: readonly LedgerType[] = [
  'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS',
  'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION',
]
```

- [ ] **Step 3: Add the request schema**

Alongside `activateCustomerSchema`:

```ts
const grantBonusSchema = type({
  scope: 'string',
  'phone?': 'string',
  amount: '1 <= number.integer <= 100000',
  content: '1 <= string <= 500',
  idempotencyKey: 'string >= 1',
}).onUndeclaredKey('reject')
```

- [ ] **Step 4: Replace the "Maintenance reset warnings" section**

Find:

```ts
// --- Maintenance reset warnings ---

// Live snapshot of every CTV currently 2/3 through their G-wallet window with no approved order
// yet — independent of whether the cron has already sent them the in-app warning.
adminRoutes.get('/points/at-risk', async (c) => {
  const users = await findAtRiskUsers(c.env.DB, new Date())
  return c.json({ users })
})
```

Replace with:

```ts
// --- Admin-triggered point bonuses (replaces the old monthly maintenance cron) ---

adminRoutes.post('/bonuses', arktypeValidator('json', grantBonusSchema), async (c) => {
  const admin = c.get('user')!
  const { scope, phone, amount, content, idempotencyKey } = c.req.valid('json')
  if (scope !== 'ALL' && scope !== 'PHONE') return c.json({ error: 'invalid scope' }, 400)
  if (scope === 'PHONE' && !phone) return c.json({ error: 'phone required for scope PHONE' }, 400)
  const result = await grantBonus(c.env.DB, {
    scope, phone, amount, content, idempotencyKey, adminId: admin.id, now: new Date().toISOString(),
  })
  if (result.ok) return c.json({ grant: result.grant }, 201)
  if (result.error === 'PHONE_NOT_FOUND') return c.json({ error: 'phone not found' }, 404)
  return c.json({ error: 'duplicate grant', code: 'DUPLICATE' }, 409)
})

adminRoutes.get('/bonuses', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listBonusGrants(c.env.DB, { page, limit })
  return c.json({ grants: rows.map(toBonusGrant), page, limit, total })
})

adminRoutes.get('/bonuses/preview', async (c) => {
  if (c.req.query('scope') !== 'ALL') return c.json({ error: 'invalid scope' }, 400)
  return c.json({ recipientCount: await countCtvUsers(c.env.DB) })
})
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: add admin bonus routes, remove /points/at-risk"
```

---

## Task 7: Route-level test — `test/admin-bonuses.test.ts`

**Files:**
- Create: `test/admin-bonuses.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

interface GrantResponse {
  grant: {
    id: string
    scope: 'ALL' | 'PHONE'
    targetUserId: string | null
    amount: number
    content: string
    recipientCount: number
  }
}

async function gBalance(userId: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COALESCE(SUM(points),0) AS g FROM point_ledger WHERE user_id = ? AND wallet = 'G'`)
    .bind(userId)
    .first<{ g: number }>()
  return row?.g ?? 0
}

describe('POST /api/admin/bonuses — scope ALL', () => {
  it('credits every USER (not the admin), and only them, with a notification each', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911111111')
    const b = await registerUser(admin.referralCode, '0911111112')

    const res = await post(
      '/api/admin/bonuses',
      { scope: 'ALL', amount: 50, content: 'Thưởng mừng mốc 100 CTV', idempotencyKey: 'k1' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { grant } = await res.json<GrantResponse>()
    expect(grant.scope).toBe('ALL')
    expect(grant.recipientCount).toBe(2)

    expect(await gBalance(a.id)).toBe(50)
    expect(await gBalance(b.id)).toBe(50)

    const notifs = await (await get('/api/notifications', a.token)).json<{
      notifications: { type: string; title: string; body: string }[]
    }>()
    const bonusNotifs = notifs.notifications.filter((n) => n.type === 'ADMIN_BONUS')
    expect(bonusNotifs).toHaveLength(1)
    expect(bonusNotifs[0].body).toContain('50')
    expect(bonusNotifs[0].body).toContain('Thưởng mừng mốc 100 CTV')
  })

  it('a repeated idempotencyKey is a no-op (no double payout)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911111113')

    const first = await post(
      '/api/admin/bonuses',
      { scope: 'ALL', amount: 20, content: 'Thưởng', idempotencyKey: 'dup-key' },
      admin.token,
    )
    expect(first.status).toBe(201)
    expect(await gBalance(a.id)).toBe(20)

    const second = await post(
      '/api/admin/bonuses',
      { scope: 'ALL', amount: 20, content: 'Thưởng', idempotencyKey: 'dup-key' },
      admin.token,
    )
    expect(second.status).toBe(409)
    expect((await second.json<{ code: string }>()).code).toBe('DUPLICATE')
    expect(await gBalance(a.id)).toBe(20) // unchanged — not 40
  })

  it('requires SUPER_ADMIN', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911111114')
    const body = { scope: 'ALL', amount: 10, content: 'x', idempotencyKey: 'k2' }
    expect((await post('/api/admin/bonuses', body)).status).toBe(401)
    expect((await post('/api/admin/bonuses', body, a.token)).status).toBe(403)
  })
})

describe('POST /api/admin/bonuses — scope PHONE', () => {
  it('credits exactly the phone-matched CTV, not others', async () => {
    const admin = await seedAdmin()
    const target = await registerUser(admin.referralCode, '0922222221')
    const other = await registerUser(admin.referralCode, '0922222222')

    const res = await post(
      '/api/admin/bonuses',
      { scope: 'PHONE', phone: '0922222221', amount: 30, content: 'Thưởng nóng', idempotencyKey: 'k3' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { grant } = await res.json<GrantResponse>()
    expect(grant.recipientCount).toBe(1)
    expect(grant.targetUserId).toBe(target.id)

    expect(await gBalance(target.id)).toBe(30)
    expect(await gBalance(other.id)).toBe(0)
  })

  it('404s for a phone with no matching CTV', async () => {
    const admin = await seedAdmin()
    const res = await post(
      '/api/admin/bonuses',
      { scope: 'PHONE', phone: '0999999999', amount: 30, content: 'x', idempotencyKey: 'k4' },
      admin.token,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/admin/bonuses', () => {
  it('lists grants newest-first', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0933333331')
    await post('/api/admin/bonuses', { scope: 'ALL', amount: 10, content: 'A', idempotencyKey: 'k5' }, admin.token)
    await post('/api/admin/bonuses', { scope: 'ALL', amount: 15, content: 'B', idempotencyKey: 'k6' }, admin.token)

    const res = await get('/api/admin/bonuses', admin.token)
    const { grants, total } = await res.json<{ grants: { content: string }[]; total: number }>()
    expect(total).toBe(2)
    expect(grants[0].content).toBe('B') // most recent first
  })
})

describe('GET /api/admin/bonuses/preview', () => {
  it('counts current CTV for scope=ALL', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0944444441')
    await registerUser(admin.referralCode, '0944444442')

    const res = await get('/api/admin/bonuses/preview?scope=ALL', admin.token)
    expect(res.status).toBe(200)
    expect((await res.json<{ recipientCount: number }>()).recipientCount).toBe(2)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/admin-bonuses.test.ts`
Expected: PASS (8 tests). If `phone` typing on `GrantBonusInput` complains about `input.phone ?? ''` being passed to `findByPhone` when `scope === 'ALL'` — that's fine, it's just never called in that branch; no fix needed.

- [ ] **Step 3: Commit**

```bash
git add test/admin-bonuses.test.ts
git commit -m "test: cover admin bonus grant routes"
```

---

## Task 8: `test/constraints.test.ts` — pin the new UNIQUE/CHECK constraints, drop the retired ones

**Files:**
- Modify: `test/constraints.test.ts`

- [ ] **Step 1: Update the header comment and remove the two retired pin tests**

Replace the header comment (lines 4–8):

```ts
// These tests pin the D1 error-message substrings that lib/ matches on to classify constraint
// violations: isDuplicateRedemption (redemptions.ts), isDuplicateBonusGrant (bonuses.ts), and
// translateConflict (users.ts). Those detectors are correct against today's D1 behavior, but a
// Wrangler/D1 update that reworded constraint errors would silently turn a handled conflict into
// a 500. Asserting the raw message shape here makes that regression loud instead (Mike, PR review).
```

Delete the two `it(...)` blocks titled `'R3 uq_ledger_user_period_type: ...'` and
`'uq_notifications_reset_warning: ...'` (their only consumers, `isAlreadyProcessed`/`isAlreadyWarned`
in `src/lib/maintenance.ts`, are deleted in Task 9). The `uq_ledger_user_period_type` and
`uq_notifications_reset_warning` indexes themselves stay in the schema (historical
`MAINTENANCE_*`/`MAINTENANCE_RESET_WARNING` rows still rely on them) — only the tests pinning
their *error message shape* for a now-deleted detector go away.

- [ ] **Step 2: Add a pin test for `uq_bonus_grants_idem`, right after the `R4 uq_ledger_idem` test**

```ts
  it('R5 uq_bonus_grants_idem: a duplicate idempotency_key is named in the error', async () => {
    const adminId = crypto.randomUUID()
    await seedUser(adminId, '0911111117', 'SUPER_ADMIN', '0911111117')
    const key = crypto.randomUUID()
    const row = (id: string) =>
      env.DB.prepare(
        `INSERT INTO bonus_grants (id, idempotency_key, scope, amount, content, recipient_count, created_by, created_at)
         VALUES (?, ?, 'ALL', 10, 'x', 0, ?, '2026-01-01T00:00:00.000Z')`,
      ).bind(id, key, adminId)

    await row(crypto.randomUUID()).run()
    const msg = await captureError(() => row(crypto.randomUUID()).run())
    expect(msg).toContain('UNIQUE constraint failed')
    expect(msg).toMatch(/uq_bonus_grants_idem|idempotency_key/) // isDuplicateBonusGrant
  })
```

- [ ] **Step 3: Add two CHECK-constraint tests in a new describe block, at the end of the file**

```ts
describe('point_ledger ADMIN_BONUS CHECK constraints', () => {
  it('rejects an ADMIN_BONUS row with no bonus_grant_id', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111118')
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, created_at)
         VALUES (?, ?, 'G', 'ADMIN_BONUS', 10, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })

  it('rejects an ADMIN_BONUS row in wallet F', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111119')
    const adminId = crypto.randomUUID()
    await seedUser(adminId, '0911111120', 'SUPER_ADMIN', '0911111120')
    const grantId = crypto.randomUUID()
    await env.DB
      .prepare(
        `INSERT INTO bonus_grants (id, idempotency_key, scope, amount, content, recipient_count, created_by, created_at)
         VALUES (?, ?, 'ALL', 10, 'x', 0, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(grantId, crypto.randomUUID(), adminId)
      .run()
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, bonus_grant_id, created_at)
         VALUES (?, ?, 'F', 'ADMIN_BONUS', 10, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, grantId)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })
})
```

- [ ] **Step 4: Run the file**

Run: `npx vitest run test/constraints.test.ts`
Expected: PASS (7 tests: R4, R5, users.phone, one_super_admin, the 2 new ADMIN_BONUS CHECK tests — R3/reset-warning removed).

- [ ] **Step 5: Commit**

```bash
git add test/constraints.test.ts
git commit -m "test: pin uq_bonus_grants_idem and ADMIN_BONUS CHECK constraints"
```

---

## Task 9: Delete the old maintenance system (backend)

**Files:**
- Delete: `src/lib/maintenance.ts`
- Delete: `src/domain/points/maintenance.ts`
- Delete: `src/domain/points/maintenance.test.ts`
- Delete: `src/domain/points/periods.ts`
- Delete: `src/domain/points/periods.test.ts`
- Delete: `src/scheduled.ts`
- Delete: `test/maintenance.test.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.jsonc`
- Modify: `src/domain/points/constants.ts`
- Modify: `src/lib/ledger.ts`
- Modify: `test/points.test.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm src/lib/maintenance.ts src/domain/points/maintenance.ts src/domain/points/maintenance.test.ts \
       src/domain/points/periods.ts src/domain/points/periods.test.ts src/scheduled.ts test/maintenance.test.ts
```

- [ ] **Step 2: Edit `src/index.ts`** — remove the cron wiring

Remove the line `import { scheduled } from './scheduled'` and the `scheduled,` entry from the exported worker object (find it via `grep -n "scheduled" src/index.ts` first — there are exactly 2 occurrences, the import and the export-object property).

- [ ] **Step 3: Edit `wrangler.jsonc`** — remove the cron trigger

Remove this block (and its explanatory comment line just above it):

```jsonc
  // Daily 01:00 UTC = 08:00 Việt Nam — maintenance accrual + rolling-window reset (tech-spec §7).
  "triggers": { "crons": ["0 1 * * *"] },
```

(Leave the rest of the file — including the unrelated in-progress `WP_API_BASE` edit already in this working tree — untouched.)

- [ ] **Step 4: Edit `src/domain/points/constants.ts`** — drop the now-unused constants

```ts
// System-wide point constants (PRD §8) — compile-time values, NOT per-transaction configurable
// and NOT env vars. Fixed amounts credited by each event.
export const POINTS = {
  REGISTRATION: 100, // F, to the new registrant
  REFERRAL_SIGNUP: 20, // F, to the direct referrer when someone they referred registers
  CUSTOMER_REWARD: 500, // F, to the order creator when the order is APPROVED
  CUSTOMER_REFERRAL: 100, // F, to the creator's direct referrer on APPROVED
} as const
```

(Drop `MAINTENANCE: 100` from the object, and delete the trailing `WARMUP_PERIODS`/`WINDOW_PERIODS` exports and their comment entirely.)

- [ ] **Step 5: Edit `src/lib/ledger.ts`** — drop the now-dead `maxAccruedPeriod`

Delete the `maxAccruedPeriod` function (it fed `planMaintenance`, which no longer exists, and has no other caller):

```ts
/** Highest accrued maintenance period for a user, or 0 if none yet (feeds planMaintenance). */
export async function maxAccruedPeriod(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(period_index), 0) AS n
       FROM point_ledger WHERE user_id = ? AND type = 'MAINTENANCE_ACCRUAL'`,
    )
    .bind(userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}
```

- [ ] **Step 6: Edit `test/points.test.ts`** — drop the at-risk describe block and its now-unused helpers

Delete lines 10–32 (the `registeredMonthsAgo` comment + function, and the `seedAccrual` function, plus their surrounding blank lines — everything between `async function ledgerCount()`'s closing `}` and `describe('registration bonuses', ...)`).

Delete the entire `describe('admin at-risk listing', ...)` block at the end of the file (currently lines 167–202 — from `describe('admin at-risk listing', () => {` through the file's final `})`), so the file now ends after `describe('admin ledger: subjectUserFullName traceability', ...)`'s closing `})`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, no reference to any deleted maintenance symbol anywhere (a leftover import would show as a TypeScript/module-resolution error in whichever file still has it — fix and rerun).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: remove the monthly maintenance cron and its at-risk listing"
```

---

## Task 10: Fix `scripts/seed-demo.ts`

The script imports `planMaintenance`/`planResetWarning`/`anniversaryDate` (deleted in Task 9) and the
three deleted maintenance message functions — it will not run until this is fixed. This task
replaces the old "replay the monthly cron over backdated history" pass with two demo `ADMIN_BONUS`
grants (one broadcast, one individual), matching the new feature, and fixes `purgeSql()` so
`--purge` doesn't leave orphaned `bonus_grants` rows behind.

**Files:**
- Modify: `scripts/seed-demo.ts`

- [ ] **Step 1: Fix the file-header comment (lines 16–21)**

Replace:

```ts
// Why raw SQL and not the HTTP API: the interesting scenarios (G-wallet accrual, the rolling
// 3-month reset, the "sắp bị đặt lại" warning) only exist for accounts that registered months
// ago, and no endpoint can backdate `users.created_at`. To make sure the backdated history is
// byte-for-byte what production would have produced, this script imports the REAL domain
// planners (planRegistrationBonuses / planOrderApprovalBonuses / planMaintenance /
// planResetWarning) and the REAL notification copy rather than restating any of it.
```

with:

```ts
// Why raw SQL and not the HTTP API: some of the backdated history (registration months ago,
// customers activated months apart) can't be produced by calling today's endpoints, which always
// timestamp "now". To make sure it's still byte-for-byte what production would have produced,
// this script imports the REAL notification copy (referralSignupBonusMessage, adminBonusMessage,
// etc.) rather than restating any of it.
```

- [ ] **Step 2: Fix the imports (lines 29–39)**

Replace:

```ts
import { planMaintenance, planResetWarning } from '../src/domain/points/maintenance'
import { anniversaryDate } from '../src/domain/points/periods'
import {
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  maintenanceResetWarningMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../src/domain/notifications/messages'
```

with:

```ts
import {
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../src/domain/notifications/messages'
```

- [ ] **Step 3: Fix the now-stale `CustomerSpec` comment**

Replace:

```ts
  /** When the admin activated them. Also drives the G-wallet maintenance window. */
```

with:

```ts
  /** When the admin activated them. */
```

- [ ] **Step 4: Fix the `bao` persona comment**

Replace:

```ts
    // bao-1 → bao-2 leaves a 140-day gap with no APPROVED order — long enough that the rolling
    // 3-month window empties out and period 5 gets a real MAINTENANCE_RESET (verified against
    // planMaintenance directly), before bao-2's approval refills the window and periods 6-8
    // accrue normally again. Requested explicitly: the flagship persona should also show the
    // "tài khoản lâu ngày bị trừ thưởng rồi hồi phục" case, not just Hạnh's (KB-02).
```

with:

```ts
    // bao-1 → bao-2 leaves a 140-day gap with no APPROVED order — kept as realistic spacing; it
    // no longer drives any G-wallet behavior now that the maintenance cron is gone.
```

- [ ] **Step 5: Fix the `hanh` persona comment**

Replace:

```ts
    // The "reset rồi hồi phục" persona: an early win, then a dry spell long enough for the
    // rolling window to wipe G, then a fresh approval that keeps it accruing again. Her ledger is
    // the one to open when checking that MAINTENANCE_RESET renders correctly mid-history.
```

with:

```ts
    // An early win, then a dry spell, then a fresh approval — realistic spacing only; her
    // G-wallet history now comes entirely from the ADMIN_BONUS grants seeded in Pass 3.
```

- [ ] **Step 6: Extend `insertLedger` to accept `bonusGrantId`**

Replace:

```ts
function insertLedger(row: {
  id: string; userId: string; wallet: 'F' | 'G'; type: string; points: number
  orderId?: string | null; subjectUserId?: string | null; periodIndex?: number | null
  idempotencyKey?: string | null; note?: string | null; createdBy?: string | null; createdAt: string
}): void {
  const t = tally.get(row.userId) ?? { F: 0, G: 0 }
  t[row.wallet] += row.points
  tally.set(row.userId, t)
  statements.push(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at) VALUES (` +
      [q(row.id), q(row.userId), q(row.wallet), q(row.type), String(row.points),
        qn(row.orderId ?? null), qn(row.subjectUserId ?? null),
        row.periodIndex == null ? 'NULL' : String(row.periodIndex),
        qn(row.idempotencyKey ?? null), qn(row.note ?? null), qn(row.createdBy ?? null),
        q(row.createdAt)].join(', ') +
      `);`,
  )
}
```

with:

```ts
function insertLedger(row: {
  id: string; userId: string; wallet: 'F' | 'G'; type: string; points: number
  orderId?: string | null; subjectUserId?: string | null; periodIndex?: number | null
  bonusGrantId?: string | null
  idempotencyKey?: string | null; note?: string | null; createdBy?: string | null; createdAt: string
}): void {
  const t = tally.get(row.userId) ?? { F: 0, G: 0 }
  t[row.wallet] += row.points
  tally.set(row.userId, t)
  statements.push(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, bonus_grant_id, idempotency_key, note, created_by, created_at) VALUES (` +
      [q(row.id), q(row.userId), q(row.wallet), q(row.type), String(row.points),
        qn(row.orderId ?? null), qn(row.subjectUserId ?? null),
        row.periodIndex == null ? 'NULL' : String(row.periodIndex),
        qn(row.bonusGrantId ?? null),
        qn(row.idempotencyKey ?? null), qn(row.note ?? null), qn(row.createdBy ?? null),
        q(row.createdAt)].join(', ') +
      `);`,
  )
}
```

- [ ] **Step 7: Delete the now-dead `cronRunAt` helper**

Delete this whole block (its only two call sites are removed in Step 8):

```ts
/** The cron fires 01:00 UTC daily, so a period's rows land at 01:00 on its anniversary date. */
function cronRunAt(anniversary: Date): string {
  return new Date(Date.UTC(
    anniversary.getUTCFullYear(), anniversary.getUTCMonth(), anniversary.getUTCDate(), 1, 0, 0,
  )).toISOString()
}
```

- [ ] **Step 8: Replace Pass 3**

Replace the entire block from `// Pass 3: replay the monthly cron over the whole backdated history...`
through the closing `}` right before `// Pass 4: redemptions ...` with:

```ts
  // Pass 3: two admin bonus grants (design: docs/superpowers/specs/2026-08-03-admin-point-bonus-
  // design.md) — a broadcast to every demo CTV, and one extra individual grant to `bao`, so the
  // demo shows both flows and their ledger/notification/history rows.
  const broadcastId = crypto.randomUUID()
  const broadcastAt = daysAgo(90).toISOString()
  const broadcastContent = 'Thưởng mừng hệ thống đạt mốc 50 CTV — tháng 4/2026'
  statements.push(
    `INSERT INTO bonus_grants (id, idempotency_key, scope, target_user_id, amount, content, recipient_count, created_by, created_at) VALUES (` +
      [q(broadcastId), q(`demo-bonus-${broadcastId}`), q('ALL'), 'NULL', '50', q(broadcastContent),
        String(users.size), q(adminId), q(broadcastAt)].join(', ') +
      `);`,
  )
  for (const built of users.values()) {
    const ledgerId = crypto.randomUUID()
    insertLedger({
      id: ledgerId, userId: built.id, wallet: 'G', type: 'ADMIN_BONUS',
      points: 50, bonusGrantId: broadcastId, note: broadcastContent, createdBy: adminId, createdAt: broadcastAt,
    })
    const m = adminBonusMessage(50, broadcastContent)
    insertNotification({ userId: built.id, type: 'ADMIN_BONUS', title: m.title, body: m.body, ledgerId, createdAt: broadcastAt })
  }

  const bao = users.get('bao')!
  const individualId = crypto.randomUUID()
  const individualAt = daysAgo(8).toISOString()
  const individualContent = 'Thưởng nóng vượt chỉ tiêu quý — dẫn đầu khu vực'
  statements.push(
    `INSERT INTO bonus_grants (id, idempotency_key, scope, target_user_id, amount, content, recipient_count, created_by, created_at) VALUES (` +
      [q(individualId), q(`demo-bonus-${individualId}`), q('PHONE'), q(bao.id), '30', q(individualContent),
        '1', q(adminId), q(individualAt)].join(', ') +
      `);`,
  )
  const individualLedgerId = crypto.randomUUID()
  insertLedger({
    id: individualLedgerId, userId: bao.id, wallet: 'G', type: 'ADMIN_BONUS',
    points: 30, bonusGrantId: individualId, note: individualContent, createdBy: adminId, createdAt: individualAt,
  })
  const im = adminBonusMessage(30, individualContent)
  insertNotification({ userId: bao.id, type: 'ADMIN_BONUS', title: im.title, body: im.body, ledgerId: individualLedgerId, createdAt: individualAt })
```

- [ ] **Step 9: Fix `purgeSql()` so `--purge` also removes the demo `bonus_grants` rows**

Replace:

```ts
function purgeSql(): string[] {
  const demoUsers = `SELECT id FROM users WHERE phone LIKE '${DEMO_PHONE_PREFIX}%'`
  const demoOrders = `SELECT id FROM orders WHERE user_id IN (${demoUsers})`
  const demoLedger = `SELECT id FROM point_ledger WHERE user_id IN (${demoUsers})`
  return [
    `DELETE FROM notifications WHERE user_id IN (${demoUsers}) OR order_id IN (${demoOrders}) OR ledger_id IN (${demoLedger});`,
    `DELETE FROM order_events WHERE order_id IN (${demoOrders});`,
    `DELETE FROM point_ledger WHERE user_id IN (${demoUsers}) OR subject_user_id IN (${demoUsers}) OR order_id IN (${demoOrders});`,
    `DELETE FROM orders WHERE user_id IN (${demoUsers});`,
    `DELETE FROM password_reset_log WHERE user_id IN (${demoUsers});`,
    `DELETE FROM users WHERE phone LIKE '${DEMO_PHONE_PREFIX}%';`,
    `DELETE FROM posts WHERE title LIKE '${DEMO_NAME_PREFIX}%';`,
    `DELETE FROM guides WHERE title LIKE '${DEMO_NAME_PREFIX}%';`,
  ]
}
```

with:

```ts
function purgeSql(): string[] {
  const demoUsers = `SELECT id FROM users WHERE phone LIKE '${DEMO_PHONE_PREFIX}%'`
  const demoOrders = `SELECT id FROM orders WHERE user_id IN (${demoUsers})`
  const demoLedger = `SELECT id FROM point_ledger WHERE user_id IN (${demoUsers})`
  // A broadcast grant's bonus_grants row has target_user_id = NULL (not owned by any single demo
  // user), so it can only be found via the ledger rows it produced — must run before point_ledger
  // itself is deleted below.
  const demoBonusGrants = `SELECT bonus_grant_id FROM point_ledger WHERE user_id IN (${demoUsers}) AND bonus_grant_id IS NOT NULL`
  return [
    `DELETE FROM notifications WHERE user_id IN (${demoUsers}) OR order_id IN (${demoOrders}) OR ledger_id IN (${demoLedger});`,
    `DELETE FROM bonus_grants WHERE id IN (${demoBonusGrants});`,
    `DELETE FROM order_events WHERE order_id IN (${demoOrders});`,
    `DELETE FROM point_ledger WHERE user_id IN (${demoUsers}) OR subject_user_id IN (${demoUsers}) OR order_id IN (${demoOrders});`,
    `DELETE FROM orders WHERE user_id IN (${demoUsers});`,
    `DELETE FROM password_reset_log WHERE user_id IN (${demoUsers});`,
    `DELETE FROM users WHERE phone LIKE '${DEMO_PHONE_PREFIX}%';`,
    `DELETE FROM posts WHERE title LIKE '${DEMO_NAME_PREFIX}%';`,
    `DELETE FROM guides WHERE title LIKE '${DEMO_NAME_PREFIX}%';`,
  ]
}
```

- [ ] **Step 10: Update the 5 stale social-proof/guide blurbs that describe the removed reset mechanic**

In `DEMO_POSTS`, replace:
- `'Giữ nhịp giới thiệu đều 8 tháng liên tiếp, không tháng nào bị đặt lại ví G.'` → `'Giữ nhịp giới thiệu đều 8 tháng liên tiếp, luôn có khách mới mỗi quý.'`
- `'Ba khách xuất cảnh liên tiếp trong quý I/2026, giữ ví G không lần nào bị reset.'` → `'Ba khách xuất cảnh liên tiếp trong quý I/2026, liên tục nhận thưởng điểm từ admin.'`

In `DEMO_GUIDES`, replace:
- `{ title: 'Bí quyết giữ ví G không bị đặt lại', daysAgo: 26, blurb: 'Ví G bị đặt lại nếu 3 tháng liền không có đơn được duyệt — mẹo duy trì ít nhất một khách mỗi quý.' }` → `{ title: 'Ví G là gì và khi nào được cộng điểm', daysAgo: 26, blurb: 'Ví G chỉ được cộng khi admin chủ động thưởng — điểm tích luỹ không giới hạn thời gian, dùng để đổi thưởng cùng ví F khi có khách xuất cảnh.' }`
- `'Công thức cộng điểm khi khách xuất cảnh, khi giới thiệu CTV mới, và điểm duy trì hàng tháng.'` → `'Công thức cộng điểm khi khách xuất cảnh, khi giới thiệu CTV mới, và điểm thưởng do admin chủ động cấp.'`
- `'Cách giữ ví G không bị đặt lại và duy trì mạng lưới giới thiệu vào những tháng ít khách.'` → `'Cách duy trì mạng lưới giới thiệu đều đặn vào những tháng ít khách để luôn có cơ hội nhận thưởng điểm.'`

- [ ] **Step 11: Dry-run it against local**

Run: `npm run seed:demo -- --local --dry-run`
Expected: prints SQL with no errors (in particular: no `ReferenceError`/module-resolution error from the deleted imports, and `INSERT INTO bonus_grants` statements appear for both the broadcast and `bao`'s individual grant).

- [ ] **Step 12: Commit**

```bash
git add scripts/seed-demo.ts
git commit -m "fix: replace maintenance-cron replay in seed-demo with admin bonus grants"
```

---

## Task 11: Frontend types + hooks

**Files:**
- Modify: `../xkld-tools-client/src/lib/api.ts`
- Modify: `../xkld-tools-client/src/lib/ledgerFilters.ts`
- Modify: `../xkld-tools-client/src/lib/notifications.ts`
- Create: `../xkld-tools-client/src/lib/adminBonuses.ts`

(Paths below are relative to the `xkld-tools-client` working directory.)

- [ ] **Step 1: `src/lib/api.ts`** — add `ADMIN_BONUS` to both unions, and the `BonusGrant` type

In `LedgerType`:

```ts
export type Wallet = 'F' | 'G'
export type LedgerType =
  | 'REGISTRATION_BONUS'
  | 'REFERRAL_SIGNUP_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'ADMIN_BONUS'
  | 'CUSTOMER_REWARD'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'REDEMPTION'
```

In `NotificationType`:

```ts
export type NotificationType =
  | 'ORDER_CREATED'
  | 'ORDER_APPROVED'
  | 'ORDER_REJECTED'
  | 'ORDER_NEEDS_REVISION'
  | 'REGISTRATION_BONUS'
  | 'REFERRAL_SIGNUP_BONUS'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'ADMIN_BONUS'
  | 'REDEMPTION'
```

Add, near `AdminLedgerEntry` (end of file is fine too):

```ts
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
```

- [ ] **Step 2: `src/lib/ledgerFilters.ts`** — add the label

```ts
export const LEDGER_TYPE_LABELS: Record<LedgerType, string> = {
  REGISTRATION_BONUS: 'Thưởng đăng ký',
  REFERRAL_SIGNUP_BONUS: 'Thưởng giới thiệu',
  MAINTENANCE_ACCRUAL: 'Cộng duy trì',
  MAINTENANCE_RESET: 'Reset duy trì',
  ADMIN_BONUS: 'Thưởng điểm',
  CUSTOMER_REWARD: 'Thưởng khách hàng',
  CUSTOMER_REFERRAL_BONUS: 'Thưởng giới thiệu khách hàng',
  REDEMPTION: 'Đổi điểm',
}
```

- [ ] **Step 3: `src/lib/notifications.ts`** — add the icon

```ts
export const NOTIFICATION_ICON: Record<NotificationType, string> = {
  ORDER_CREATED: '🆕',
  ORDER_APPROVED: '✅',
  ORDER_REJECTED: '❌',
  ORDER_NEEDS_REVISION: '✏️',
  REGISTRATION_BONUS: '🎉',
  REFERRAL_SIGNUP_BONUS: '🤝',
  CUSTOMER_REFERRAL_BONUS: '💰',
  MAINTENANCE_ACCRUAL: '🔄',
  MAINTENANCE_RESET: '♻️',
  ADMIN_BONUS: '🏆',
  REDEMPTION: '🎁',
}
```

- [ ] **Step 4: Create `src/lib/adminBonuses.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { req, type BonusGrant, type Paginated } from './api'
import { AppError } from './error'

export function useBonusGrants(page: number) {
  return useQuery<Paginated<BonusGrant, 'grants'>, AppError>({
    queryKey: ['admin', 'bonuses', page] as const,
    queryFn: () => req<Paginated<BonusGrant, 'grants'>>(`/api/admin/bonuses?page=${page}`),
  })
}

/** Only fetches once the confirm step is showing — `enabled` gates it. */
export function useBonusRecipientPreview(enabled: boolean) {
  return useQuery<{ recipientCount: number }, AppError>({
    queryKey: ['admin', 'bonuses', 'preview'] as const,
    queryFn: () => req<{ recipientCount: number }>('/api/admin/bonuses/preview?scope=ALL'),
    enabled,
  })
}

export interface GrantBonusInput {
  scope: 'ALL' | 'PHONE'
  phone?: string
  amount: number
  content: string
  idempotencyKey: string
}

export function useGrantBonus() {
  const queryClient = useQueryClient()
  return useMutation<{ grant: BonusGrant }, AppError, GrantBonusInput>({
    mutationFn: (body) => req<{ grant: BonusGrant }>('/api/admin/bonuses', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'bonuses'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'ledger'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
  })
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/ledgerFilters.ts src/lib/notifications.ts src/lib/adminBonuses.ts
git commit -m "feat: add ADMIN_BONUS types and admin bonus API hooks"
```

---

## Task 12: Frontend page — `/admin/bonuses`

**Files:**
- Create: `../xkld-tools-client/src/routes/admin/bonuses.tsx`
- Modify: `../xkld-tools-client/src/components/shell/AdminNavTile.tsx`
- Modify: `../xkld-tools-client/src/routes/admin/dashboard.tsx`

(Paths below are relative to the `xkld-tools-client` working directory.)

- [ ] **Step 1: `src/components/shell/AdminNavTile.tsx`** — add the route to the union

```ts
export type AdminRoute =
  | '/admin/users'
  | '/admin/orders'
  | '/admin/bonuses'
  | '/admin/posts'
  | '/admin/guides'
```

- [ ] **Step 2: Create `src/routes/admin/bonuses.tsx`**

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Gift } from 'lucide-react'
import { AdminShell, AdminCard } from '@/components/shell/AdminShell'
import { AdminModal } from '@/components/shell/AdminModal'
import { UserPicker } from '@/components/admin/UserPicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { useBonusGrants, useBonusRecipientPreview, useGrantBonus } from '@/lib/adminBonuses'
import { useUserDirectory } from '@/lib/adminUsers'
import { randomId } from '@/lib/randomId'
import type { AuthUser } from '@/lib/api'

export const Route = createFileRoute('/admin/bonuses')({
  component: AdminBonusesPage,
})

function BroadcastBonusModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'form' | 'confirm'>('form')
  const [amount, setAmount] = useState('')
  const [content, setContent] = useState('')
  const [idempotencyKey] = useState(randomId)
  const grant = useGrantBonus()
  const preview = useBonusRecipientPreview(step === 'confirm')

  const amountNum = Number(amount)
  const canContinue = Number.isInteger(amountNum) && amountNum > 0 && content.trim().length > 0

  const submit = () => {
    grant.mutate(
      { scope: 'ALL', amount: amountNum, content: content.trim(), idempotencyKey },
      { onSuccess: onClose },
    )
  }

  return (
    <AdminModal
      title="Thưởng điểm toàn bộ CTV"
      description="Cộng điểm vào ví G cho mọi CTV. Điểm này không tự reset — CTV tích luỹ đến khi có khách hàng mới rút hết."
      onClose={onClose}
      footer={
        step === 'form' ? (
          <>
            <Button variant="outline" onClick={onClose}>Hủy</Button>
            <Button disabled={!canContinue} onClick={() => setStep('confirm')}>Tiếp tục</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => setStep('form')}>Quay lại</Button>
            <Button disabled={grant.isPending} onClick={submit}>
              {grant.isPending ? 'Đang thưởng…' : 'Xác nhận thưởng'}
            </Button>
          </>
        )
      }
    >
      {step === 'form' ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="broadcastAmount">Số điểm</Label>
            <Input id="broadcastAmount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="broadcastContent">Nội dung</Label>
            <Textarea
              id="broadcastContent"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="VD: Thưởng mừng CTV đạt mốc 100 người"
            />
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
          {preview.data ? (
            <>
              <div>
                Sắp thưởng <b>{amountNum}</b> điểm cho <b>{preview.data.recipientCount}</b> CTV.
              </div>
              <div className="mt-1">Nội dung: &quot;{content.trim()}&quot;</div>
            </>
          ) : (
            'Đang tải số lượng CTV…'
          )}
          {grant.isError && <p className="mt-2 text-red-700">{grant.error.message}</p>}
        </div>
      )}
    </AdminModal>
  )
}

function IndividualBonusModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'form' | 'confirm'>('form')
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null)
  const [amount, setAmount] = useState('')
  const [content, setContent] = useState('')
  const [idempotencyKey] = useState(randomId)
  const grant = useGrantBonus()

  const amountNum = Number(amount)
  const canContinue = Boolean(selectedUser) && Number.isInteger(amountNum) && amountNum > 0 && content.trim().length > 0

  const submit = () => {
    if (!selectedUser) return
    grant.mutate(
      { scope: 'PHONE', phone: selectedUser.phone, amount: amountNum, content: content.trim(), idempotencyKey },
      { onSuccess: onClose },
    )
  }

  return (
    <AdminModal
      title="Thưởng điểm cho một CTV"
      description="Tìm CTV theo tên hoặc số điện thoại, cộng điểm vào ví G của riêng người đó."
      onClose={onClose}
      footer={
        step === 'form' ? (
          <>
            <Button variant="outline" onClick={onClose}>Hủy</Button>
            <Button disabled={!canContinue} onClick={() => setStep('confirm')}>Tiếp tục</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => setStep('form')}>Quay lại</Button>
            <Button disabled={grant.isPending} onClick={submit}>
              {grant.isPending ? 'Đang thưởng…' : 'Xác nhận thưởng'}
            </Button>
          </>
        )
      }
    >
      {step === 'form' ? (
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block">CTV</Label>
            <UserPicker selected={selectedUser} onSelect={setSelectedUser} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="individualAmount">Số điểm</Label>
            <Input id="individualAmount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="individualContent">Nội dung</Label>
            <Textarea
              id="individualContent"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="VD: Thưởng nóng vượt chỉ tiêu tháng"
            />
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
          <div>
            Sắp thưởng <b>{amountNum}</b> điểm cho <b>{selectedUser?.fullName}</b> ({selectedUser?.phone}).
          </div>
          <div className="mt-1">Nội dung: &quot;{content.trim()}&quot;</div>
          {grant.isError && <p className="mt-2 text-red-700">{grant.error.message}</p>}
        </div>
      )}
    </AdminModal>
  )
}

function AdminBonusesPage() {
  const [page, setPage] = useState(1)
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [showIndividual, setShowIndividual] = useState(false)
  const { data } = useBonusGrants(page)
  const users = useUserDirectory()

  return (
    <AdminShell
      title="Thưởng điểm"
      subtitle="Admin chủ động cộng điểm cho CTV"
      backTo="/admin/dashboard"
      action={
        <div className="flex gap-2">
          <Button variant="outline" className="gap-1.5" onClick={() => setShowIndividual(true)}>
            <Gift className="h-4 w-4" />
            Thưởng theo SĐT
          </Button>
          <Button className="gap-1.5" onClick={() => setShowBroadcast(true)}>
            <Gift className="h-4 w-4" />
            Thưởng toàn bộ CTV
          </Button>
        </div>
      }
    >
      <AdminCard>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="px-5 font-bold text-slate-600">Ngày</TableHead>
              <TableHead className="font-bold text-slate-600">Phạm vi</TableHead>
              <TableHead className="font-bold text-slate-600">Điểm</TableHead>
              <TableHead className="font-bold text-slate-600">Nội dung</TableHead>
              <TableHead className="px-5 font-bold text-slate-600">Số người nhận</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.grants.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-slate-500">
                  Chưa có đợt thưởng nào.
                </TableCell>
              </TableRow>
            )}
            {data?.grants.map((grant) => (
              <TableRow key={grant.id}>
                <TableCell className="px-5 text-slate-500">
                  {new Date(grant.createdAt).toLocaleDateString('vi-VN')}
                </TableCell>
                <TableCell>
                  {grant.scope === 'ALL' ? (
                    <Badge variant="secondary">Toàn bộ CTV</Badge>
                  ) : (
                    <Badge variant="outline">
                      {grant.targetUserId && users.get(grant.targetUserId)
                        ? `${users.get(grant.targetUserId)!.fullName} (${users.get(grant.targetUserId)!.phone})`
                        : 'Cá nhân'}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-semibold">+{grant.amount}</TableCell>
                <TableCell>{grant.content}</TableCell>
                <TableCell className="px-5">{grant.recipientCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AdminCard>

      {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPageChange={setPage} />}

      {showBroadcast && <BroadcastBonusModal onClose={() => setShowBroadcast(false)} />}
      {showIndividual && <IndividualBonusModal onClose={() => setShowIndividual(false)} />}
    </AdminShell>
  )
}
```

- [ ] **Step 3: `src/routes/admin/dashboard.tsx`** — add the nav tile

Add `Gift` to the existing `lucide-react` import:

```ts
import { BookOpen, FileText, Gift, Image, Users } from 'lucide-react'
```

Add a tile, after the `/admin/orders` one:

```tsx
        <AdminNavTile
          to="/admin/bonuses"
          icon={Gift}
          label="Thưởng điểm"
          hint="Cộng điểm thưởng cho CTV"
          tint="purple"
        />
```

- [ ] **Step 4: Regenerate the route tree and type-check**

Run: `npm run build`
Expected: succeeds (this both regenerates `src/routeTree.gen.ts` via the TanStack Router Vite
plugin and runs `tsc -b --noEmit`). Do not hand-edit `routeTree.gen.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/bonuses.tsx src/components/shell/AdminNavTile.tsx src/routes/admin/dashboard.tsx src/routeTree.gen.ts
git commit -m "feat: add admin bonus page (broadcast + individual grant, history)"
```

---

## Task 13: Manual verification

- [ ] **Step 1: Backend full suite**

Run (from `xkld-tools/`): `npm test`
Expected: all green.

- [ ] **Step 2: Backend dev server + seed a fresh local DB**

```bash
npm run db:migrate:local
npm run seed:admin
npm run seed:demo -- --local
npm run dev
```

Expected: seed commands succeed with no errors; `wrangler dev` starts clean.

- [ ] **Step 3: Frontend — exercise both bonus flows in the browser**

```bash
cd ../xkld-tools-client && npm run dev
```

Log in as the seeded super admin, open **Thưởng điểm** from the dashboard:
- Broadcast: enter an amount + content, click **Tiếp tục**, confirm the recipient count matches
  the seeded CTV count, click **Xác nhận thưởng**, confirm it appears in the history table and
  every demo CTV's ledger (`/admin/users` → a CTV → ledger) shows a new `Thưởng điểm` row in ví G.
- Individual: search a CTV by phone via the picker, grant a bonus, confirm only that CTV's G
  balance moved and the history table shows the correct scope badge.
- Confirm the notification bell shows the 🏆 `Bạn nhận điểm thưởng` notification when logged in as
  that CTV.

- [ ] **Step 4: Confirm the old flows are gone**

`GET /api/admin/points/at-risk` should now 404 (route removed); there is no more "sắp bị đặt lại"
copy anywhere in the admin or CTV UI.

---

## Self-review notes

- **Spec coverage:** broadcast grant (Task 5–7, 12), individual-by-phone grant (Task 5–7, 12),
  admin-authored content stored + shown (`note` column, `content` field throughout), no
  expiry/reset (old cron fully removed in Task 9), accumulates until customer activation drains it
  (unchanged `activateCustomer()` — not modified anywhere in this plan, verified in Task 13 step 3),
  dedicated admin page with both actions + history (Task 12), idempotency (`bonus_grants` unique
  index, Task 1 + tested in Task 7), confirm-before-broadcast with recipient count (Task 12).
- **Out of scope, intentionally:** `docs/API.md` is not updated — it already has unrelated
  uncommitted changes in this working tree and pre-existing stale entries (e.g. still documents
  `POST /api/admin/redemptions`, removed earlier), so it isn't treated as a reliable source and
  touching it isn't part of this plan.
