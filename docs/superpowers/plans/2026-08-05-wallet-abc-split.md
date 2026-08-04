# Wallet A/B/C Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-wallet F/G point system with three wallets — A (referral commission, never auto-drains), B (own registration + own customer reward, auto-drains), C (admin bonus, auto-drains) — and remove the `REFERRAL_SIGNUP_BONUS` earn event entirely.

**Architecture:** A D1 schema migration rebuilds `point_ledger`/`notifications` with new CHECK constraints (table-rebuild technique, matching migrations 0006/0009/0011/0012). Every backend file that reads/writes wallet letters, sort keys, or the removed ledger type is updated in lockstep. All application data is wiped (local + production) before/with this ships, so the migration needs no historical remapping.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), Vitest (`domain` project = plain Node for pure functions, `workers` project = `@cloudflare/vitest-pool-workers` integration tests against a real ephemeral D1).

**Spec:** `docs/superpowers/specs/2026-08-05-wallet-abc-split-design.md`

---

## Before you start

Run these once to get your bearings — every task below assumes you're starting from a clean working tree on `main`:

```bash
git status   # should be clean except the pre-existing uncommitted WIP in src/domain/notifications/messages.ts and messages.test.ts (Task 6 finishes that work)
pnpm test    # confirm the suite is green before touching anything
```

---

### Task 1: Schema migration — `point_ledger`/`notifications` rebuild for A/B/C

**Files:**
- Create: `migrations/0013_wallet_abc.sql`
- Test: `test/constraints.test.ts` (new `describe` block; existing wallet-F/G-specific cases are updated in Task 16, not here — this task only proves the new CHECK shape exists)

- [ ] **Step 1: Write the failing test**

Add this new `describe` block to the bottom of `test/constraints.test.ts` (leave everything else in the file untouched for now — Task 16 handles the rest of that file):

```ts
describe('point_ledger wallet A/B/C CHECK constraints', () => {
  it('accepts a CUSTOMER_REFERRAL_BONUS row only in wallet A', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111121')
    const orderId = crypto.randomUUID()
    await env.DB
      .prepare(`INSERT INTO orders (id, user_id, full_name, phone, order_code, activation_code, status, created_at, updated_at)
                VALUES (?, ?, 'C', '0900000001', 'OC-1', 'OC-1', 'APPROVED', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .bind(orderId, uid)
      .run()

    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         VALUES (?, ?, 'B', 'CUSTOMER_REFERRAL_BONUS', 100, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, orderId)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')

    // The same row in wallet A succeeds.
    await env.DB
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         VALUES (?, ?, 'A', 'CUSTOMER_REFERRAL_BONUS', 100, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(crypto.randomUUID(), uid, orderId)
      .run()
  })

  it('rejects wallet F/G entirely — only A/B/C are valid', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111122')
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
         VALUES (?, ?, 'F', 'REGISTRATION_BONUS', 100, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, uid)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })

  it('rejects REFERRAL_SIGNUP_BONUS as an unknown type — it no longer exists', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111123')
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
         VALUES (?, ?, 'B', 'REFERRAL_SIGNUP_BONUS', 20, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, uid)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/constraints.test.ts`
Expected: FAIL — against the current schema, wallet `'A'` isn't a valid value (CHECK rejects it) and `'F'`/`REFERRAL_SIGNUP_BONUS` are still accepted, so the new assertions don't hold.

- [ ] **Step 3: Write the migration**

Create `migrations/0013_wallet_abc.sql`:

```sql
-- Wallet A/B/C split (design: docs/superpowers/specs/2026-08-05-wallet-abc-split-design.md).
-- Replaces the F/G wallet pair with three:
--   A — referral commission (CUSTOMER_REFERRAL_BONUS): never auto-drains, admin settles it
--       out-of-band.
--   B — own registration + own customer reward (REGISTRATION_BONUS, CUSTOMER_REWARD): auto-drains
--       to 0 the moment the CTV activates their own customer (unchanged "settle on activation"
--       behavior, just renamed from F).
--   C — admin bonus (ADMIN_BONUS) and the dead MAINTENANCE_ACCRUAL/MAINTENANCE_RESET types: same
--       auto-drain behavior, renamed from G.
-- REFERRAL_SIGNUP_BONUS (earning points just for referring someone who registers, before they
-- land a customer) is removed entirely — "mồi CTV" no longer earns anything on its own.
--
-- Precondition: point_ledger and notifications are EMPTY when this runs (all app data is wiped,
-- locally and in production, before/alongside this migration — see the design doc). The
-- INSERT...SELECT below is kept for parity with the table-rebuild technique used elsewhere
-- (0006/0009/0011/0012) and doubles as a safety net: if this is ever run against non-empty tables
-- still holding old F/G rows, the new CHECK constraints reject them and the migration fails loudly
-- instead of silently mis-migrating money.
--
-- CHECK constraints can't be altered in place, so point_ledger and notifications are rebuilt.

CREATE TABLE point_ledger_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  wallet          TEXT NOT NULL CHECK (wallet IN ('A', 'B', 'C')),
  type            TEXT NOT NULL CHECK (type IN (
                    'REGISTRATION_BONUS',
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

  CHECK ((points > 0) = (type IN ('REGISTRATION_BONUS',
         'MAINTENANCE_ACCRUAL', 'ADMIN_BONUS', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK (CASE
    WHEN type = 'CUSTOMER_REFERRAL_BONUS' THEN wallet = 'A'
    WHEN type IN ('REGISTRATION_BONUS', 'CUSTOMER_REWARD') THEN wallet = 'B'
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS') THEN wallet = 'C'
    WHEN type = 'REDEMPTION' THEN 1
    END),
  CHECK ((order_id        IS NOT NULL) = (type IN ('CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))),
  CHECK ((subject_user_id IS NOT NULL) = (type = 'REGISTRATION_BONUS')),
  CHECK ((period_index    IS NOT NULL) = (type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET'))),
  CHECK ((bonus_grant_id  IS NOT NULL) = (type = 'ADMIN_BONUS')),
  CHECK ((idempotency_key IS NOT NULL) = (type = 'REDEMPTION'))
);

INSERT INTO point_ledger_new
  (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, bonus_grant_id, idempotency_key, note, created_by, created_at)
SELECT
  id, user_id, wallet, type, points, order_id, subject_user_id, period_index, bonus_grant_id, idempotency_key, note, created_by, created_at
FROM point_ledger;

CREATE TABLE notifications_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_REJECTED', 'ORDER_NEEDS_REVISION',
                 'REGISTRATION_BONUS', 'CUSTOMER_REFERRAL_BONUS',
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
  CHECK ((ledger_id IS NOT NULL) = (type IN ('REGISTRATION_BONUS', 'CUSTOMER_REFERRAL_BONUS',
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/constraints.test.ts`
Expected: PASS (migrations are read fresh from `./migrations` and applied to an ephemeral D1 per the `workers` Vitest project — no manual `wrangler d1 migrations apply` needed for tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/0013_wallet_abc.sql test/constraints.test.ts
git commit -m "feat(db): rebuild point_ledger/notifications for wallet A/B/C, drop REFERRAL_SIGNUP_BONUS"
```

---

### Task 2: Domain types & constants

**Files:**
- Modify: `src/domain/points/types.ts`
- Modify: `src/domain/points/constants.ts`
- Modify: `src/domain/notifications/types.ts`

No test for this task on its own — these are type/constant declarations that downstream tasks' tests exercise. `pnpm tsc --noEmit` (or the project's typecheck script — check `package.json` for one; if none exists, `pnpm exec tsc --noEmit`) is the verification.

- [ ] **Step 1: Update `src/domain/points/types.ts`**

```ts
// Shared domain types for the points core. No framework, no I/O — plain data only.

export type Wallet = 'A' | 'B' | 'C'

export type LedgerType =
  | 'REGISTRATION_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'ADMIN_BONUS'
  | 'CUSTOMER_REWARD'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'REDEMPTION'

export type OrderStatus = 'DRAFT' | 'PENDING' | 'NEEDS_REVISION' | 'APPROVED' | 'REJECTED'

/**
 * What planners emit; `lib/` turns these into SQL statements. Fixed-amount rows only —
 * resets are NOT drafts (their amount depends on the live balance at commit time; see
 * tech-spec §1.1 rule 2).
 */
export interface LedgerDraft {
  userId: string // wallet owner (beneficiary)
  wallet: Wallet
  type: LedgerType
  points: number // positive, fixed amount
  orderId?: string // CUSTOMER_* rows only
  subjectUserId?: string // REGISTRATION_BONUS rows only: the new registrant (always themselves)
}
```

- [ ] **Step 2: Update `src/domain/points/constants.ts`**

```ts
// System-wide point constants (PRD §8) — compile-time values, NOT per-transaction configurable
// and NOT env vars. Fixed amounts credited by each event.
export const POINTS = {
  REGISTRATION: 100, // B, to the new registrant
  CUSTOMER_REWARD: 500, // B, to the order creator when the order is APPROVED
  CUSTOMER_REFERRAL: 100, // A, to the creator's direct referrer on APPROVED
} as const
```

- [ ] **Step 3: Update `src/domain/notifications/types.ts`**

```ts
// Notification taxonomy (PRD §6.3). ORDER_* target an order; the rest target a point-ledger row.
export type NotificationType =
  | 'ORDER_CREATED'
  | 'ORDER_APPROVED'
  | 'ORDER_REJECTED'
  | 'ORDER_NEEDS_REVISION'
  | 'REGISTRATION_BONUS'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'MAINTENANCE_RESET_WARNING'
  | 'ADMIN_BONUS'
  | 'REDEMPTION'

/** Rendered copy for one notification. Pure data — no I/O, no formatting side effects. */
export interface NotificationContent {
  title: string
  body: string
}
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: errors in every file that still references `POINTS.REFERRAL_SIGNUP`, `'REFERRAL_SIGNUP_BONUS'`, or wallet literals `'F'`/`'G'` — this is expected; each is fixed in its own task below. Re-run this command at the end of Task 14 and expect it to be clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/points/types.ts src/domain/points/constants.ts src/domain/notifications/types.ts
git commit -m "feat(domain): wallet A/B/C types, drop REFERRAL_SIGNUP_BONUS from the type system"
```

---

### Task 3: Simplify `planRegistrationBonuses` (TDD)

**Files:**
- Modify: `src/domain/points/registration.ts`
- Modify: `src/domain/points/registration.test.ts`

- [ ] **Step 1: Rewrite the test file first (red)**

Replace the full contents of `src/domain/points/registration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planRegistrationBonuses } from './registration'
import { POINTS } from './constants'

describe('planRegistrationBonuses', () => {
  it('always emits exactly one draft: the self REGISTRATION_BONUS in wallet B', () => {
    const drafts = planRegistrationBonuses({ userId: 'u1' })
    expect(drafts).toEqual([
      { userId: 'u1', wallet: 'B', type: 'REGISTRATION_BONUS', points: POINTS.REGISTRATION, subjectUserId: 'u1' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/domain/points/registration.test.ts`
Expected: FAIL — `planRegistrationBonuses` still requires a `referrerId` argument and returns wallet `'F'`.

- [ ] **Step 3: Rewrite the implementation (green)**

Replace the full contents of `src/domain/points/registration.ts`:

```ts
// Registration-bonus planner (PRD §6.1, tech-spec §6.3). Emits the wallet-B draft credited
// atomically with user creation. Referring someone who merely registers earns nothing (that
// bonus was REFERRAL_SIGNUP_BONUS, removed) — only the registrant's own self bonus is left.
import { POINTS } from './constants'
import type { LedgerDraft } from './types'

export function planRegistrationBonuses(input: { userId: string }): LedgerDraft[] {
  return [
    {
      userId: input.userId,
      wallet: 'B',
      type: 'REGISTRATION_BONUS',
      points: POINTS.REGISTRATION,
      subjectUserId: input.userId,
    },
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/domain/points/registration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/points/registration.ts src/domain/points/registration.test.ts
git commit -m "feat(domain): simplify planRegistrationBonuses to a single wallet-B draft"
```

---

### Task 4: Delete dead code — `orderApproval.ts`

**Files:**
- Delete: `src/domain/points/orderApproval.ts`
- Delete: `src/domain/points/orderApproval.test.ts`

This planner has had no caller since the order lifecycle was removed (`activateCustomer()` in `src/lib/orders.ts` duplicates its logic inline). Confirm before deleting:

- [ ] **Step 1: Confirm it's unreferenced**

Run: `grep -rn "orderApproval\|planOrderApprovalBonuses" src/ test/ --include="*.ts"`
Expected: only matches inside `src/domain/points/orderApproval.ts` and `orderApproval.test.ts` themselves.

- [ ] **Step 2: Delete both files**

```bash
git rm src/domain/points/orderApproval.ts src/domain/points/orderApproval.test.ts
```

- [ ] **Step 3: Run the domain test suite**

Run: `pnpm test -- --project domain`
Expected: PASS (no test referenced the deleted files)

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(domain): delete orderApproval planner — unreferenced since the order lifecycle was removed"
```

---

### Task 5: Notification message copy — finish the A/B/C wording (TDD)

**Files:**
- Modify: `src/domain/notifications/messages.ts`
- Modify: `src/domain/notifications/messages.test.ts`

This finishes the uncommitted wording change already sitting in the working tree (which renamed "ví F"/"ví G" copy to "điểm cá nhân"/"điểm thưởng" but didn't yet remove the referral-signup message or rename the `paidF`/`paidG` parameters). Confirmed wording: **A = "điểm hoa hồng"**, **B = "điểm cá nhân"**, **C = "điểm thưởng"**.

- [ ] **Step 1: Rewrite the test file first (red)**

Replace the full contents of `src/domain/notifications/messages.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { POINTS } from '../points/constants'
import {
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from './messages'

describe('notification messages', () => {
  it('customer referral bonus quotes its exact amount', () => {
    expect(customerReferralBonusMessage('Trần Quốc Bảo').body).toContain(String(POINTS.CUSTOMER_REFERRAL))
  })

  it('customer referral bonus names the referred CTV who closed the customer', () => {
    const { body } = customerReferralBonusMessage('Trần Quốc Bảo')
    expect(body).toContain('Trần Quốc Bảo')
  })

  it('customer referral bonus is framed as commission (điểm hoa hồng), not personal points', () => {
    const { body } = customerReferralBonusMessage('Trần Quốc Bảo')
    expect(body).toContain('điểm hoa hồng')
    expect(body).not.toContain('điểm cá nhân')
  })

  it('customer activated states the customer, order code, and both wallet payouts', () => {
    const { title, body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 720, 300)
    expect(title).toBe('Khách hàng đã được kích hoạt')
    expect(body).toContain('Trần Thị B')
    expect(body).toContain('DH-2026-0900')
    expect(body).toContain('720')
    expect(body).toContain('300')
  })

  it('customer activated omits wallet C when there was nothing in it', () => {
    const { body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 500, 0)
    expect(body).toContain('500')
    expect(body).not.toContain('điểm thưởng')
  })

  it('admin bonus quotes the amount and includes the admin-authored content', () => {
    const { title, body } = adminBonusMessage(50, 'Thưởng mừng đạt mốc 50 CTV')
    expect(title).toBe('Bạn nhận điểm thưởng')
    expect(body).toContain('50')
    expect(body).toContain('Thưởng mừng đạt mốc 50 CTV')
  })

  it('redemption lists only the wallets actually deducted', () => {
    expect(redemptionMessage(5, 0).body).toContain('5 điểm cá nhân')
    expect(redemptionMessage(5, 0).body).not.toContain('điểm thưởng')
    expect(redemptionMessage(0, 3).body).toContain('3 điểm thưởng')
    expect(redemptionMessage(5, 3).body).toContain('5 điểm cá nhân và 3 điểm thưởng')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/domain/notifications/messages.test.ts`
Expected: FAIL — `customerReferralBonusMessage` currently says "điểm cá nhân", not "điểm hoa hồng"; the import of `referralSignupBonusMessage` (removed from the test) would also now be unused if left in `messages.ts`, but that's fine, the type-error surfaces separately.

- [ ] **Step 3: Rewrite `src/domain/notifications/messages.ts`**

Replace the full contents:

```ts
// Notification copy, in Vietnamese (the product language for CTV/admin). Pure builders: given the
// event's facts they return { title, body }. Amounts come from the single POINTS source of truth so
// the copy can never drift from what the ledger actually credited. Kept here (domain, plain-node
// tested) so wording changes are a millisecond TDD loop, not an integration run.
import { POINTS } from '../points/constants'
import type { NotificationContent } from './types'

export function registrationBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận điểm đăng ký',
    body: `Chào mừng bạn đến với hệ thống. Bạn được cộng ${POINTS.REGISTRATION} điểm cá nhân.`,
  }
}

// Wallet A — never auto-drains (see redemptionMessage/customerActivatedMessage, neither of which
// ever mentions it). Framed as "điểm hoa hồng" specifically so the copy itself signals to the CTV
// that this is not personal points and needs a manual admin settlement.
export function customerReferralBonusMessage(ctvFullName: string): NotificationContent {
  return {
    title: 'Bạn nhận điểm hoa hồng',
    body: `CTV ${ctvFullName} bạn giới thiệu vừa có khách hàng được kích hoạt. Bạn được cộng ${POINTS.CUSTOMER_REFERRAL} điểm hoa hồng.`,
  }
}

export function adminBonusMessage(amount: number, content: string): NotificationContent {
  return {
    title: 'Bạn nhận điểm thưởng',
    body: `Bạn được cộng ${amount} điểm thưởng: ${content}`,
  }
}

// Admin deducted points for cash paid out. One or both wallets may be touched; amounts are the
// positive point counts removed. b/c only — wallet A is never redeemed through this path.
export function redemptionMessage(b: number, c: number): NotificationContent {
  const parts: string[] = []
  if (b > 0) parts.push(`${b} điểm cá nhân`)
  if (c > 0) parts.push(`${c} điểm thưởng`)
  return {
    title: 'Quy đổi điểm',
    body: `Quản trị viên đã trừ ${parts.join(' và ')} khỏi tài khoản của bạn.`,
  }
}

// Admin created an already-paid customer's order directly: the CTV's own share is credited
// then immediately redeemed (net zero) since the cash never went through the payout process.
// b/c only — wallet A (any referral commission this CTV holds) is left untouched.
export function customerActivatedMessage(
  fullName: string,
  orderCode: string,
  paidB: number,
  paidC: number,
): NotificationContent {
  const parts = [`${paidB} điểm cá nhân`]
  if (paidC > 0) parts.push(`${paidC} điểm thưởng`)
  return {
    title: 'Khách hàng đã được kích hoạt',
    body:
      `Khách hàng ${fullName} (đơn ${orderCode}) đã được kích hoạt. Toàn bộ điểm của bạn đã được ` +
      `quyết toán và chi trả: ${parts.join(' và ')}. Ví đã tất toán và bắt đầu tích luỹ lại từ đầu.`,
  }
}
```

Note: `referralSignupBonusMessage` is deleted (no caller once Task 7 removes `notifyReferralSignupBonus`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/domain/notifications/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/notifications/messages.ts src/domain/notifications/messages.test.ts
git commit -m "feat(notifications): finish A/B/C wallet wording, drop referral-signup message"
```

---

### Task 6: `src/lib/notifications.ts` — drop referral-signup notifier, rename wallet params

**Files:**
- Modify: `src/lib/notifications.ts`

No standalone test file for this module (it's exercised through the routes/orders tests in later tasks). Verify via typecheck + the integration tests in Task 16-19.

- [ ] **Step 1: Edit the imports and delete `notifyReferralSignupBonus`**

In `src/lib/notifications.ts`, change the import block (currently lines 11-18):

```ts
import type { NotificationContent, NotificationType } from '../domain/notifications/types'
import {
  registrationBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../domain/notifications/messages'
```

Delete the whole `notifyReferralSignupBonus` function (currently lines 166-179):

```ts
/** REFERRAL_SIGNUP_BONUS → the referrer. Identified by the unique (subject_user_id, type) row for
 *  the new registrant (index R2). Fires only when a referral bonus was actually paid. */
export function notifyReferralSignupBonus(db: D1Database, newUserId: string, now: string): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'REFERRAL_SIGNUP_BONUS',
      content: referralSignupBonusMessage(),
      whereSql: `l.subject_user_id = ? AND l.type = 'REFERRAL_SIGNUP_BONUS'`,
      binds: [newUserId],
    },
    now,
  )
}
```

- [ ] **Step 2: Rename the wallet params on `notifyRedemption` and `notifyCustomerActivated`**

Replace the `notifyRedemption` function:

```ts
/** REDEMPTION → the user, linked to the first redemption ledger row (whichever wallet). */
export function notifyRedemption(db: D1Database, firstLedgerId: string, b: number, c: number, now: string): D1PreparedStatement {
  return ledgerNotif(
    db,
    { type: 'REDEMPTION', content: redemptionMessage(b, c), whereSql: `l.id = ?`, binds: [firstLedgerId] },
    now,
  )
}
```

Replace the `notifyCustomerActivated` function:

```ts
/** REDEMPTION (custom copy) → the CTV, linked to the redemption row `activateCustomer()`
 *  creates. Reuses the REDEMPTION type deliberately — no new NotificationType needed, and
 *  the CTV's own client already renders REDEMPTION notifications correctly. */
export function notifyCustomerActivated(
  db: D1Database,
  redemptionLedgerId: string,
  fullName: string,
  orderCode: string,
  paidB: number,
  paidC: number,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    {
      type: 'REDEMPTION',
      content: customerActivatedMessage(fullName, orderCode, paidB, paidC),
      whereSql: `l.id = ?`,
      binds: [redemptionLedgerId],
    },
    now,
  )
}
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: errors remaining only in `src/lib/users.ts` (still calls `notifyReferralSignupBonus`) and `src/lib/orders.ts` (still passes `paidF`/`paidG`-named args positionally, which is fine positionally but the file itself still has old wallet literals) — both fixed in Tasks 8 and 10.

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications.ts
git commit -m "feat(notifications): drop notifyReferralSignupBonus, rename redemption params to b/c"
```

---

### Task 7: `src/lib/ledger.ts` — `getBalances` returns `{ a, b, c }`

**Files:**
- Modify: `src/lib/ledger.ts`

- [ ] **Step 1: Replace `getBalances`**

```ts
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
```

(This is the only change in the file — `hasCustomerReward`, `listLedger`, `draftToStatement`, and all the type/interface definitions above it are untouched.)

- [ ] **Step 2: Verify it compiles for this file in isolation**

Run: `pnpm exec tsc --noEmit`
Expected: new errors in `src/routes/points.ts` and `src/routes/admin.ts` (destructure `{ f, g }` from balances) — fixed in Tasks 12-13. `src/lib/orders.ts` also now errors (`before.f`/`before.g`) — fixed in Task 10.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ledger.ts
git commit -m "feat(ledger): getBalances returns wallet A/B/C balances"
```

---

### Task 8: `src/lib/users.ts` — simplify `createUser`, rename sort keys, add balance A

**Files:**
- Modify: `src/lib/users.ts`

- [ ] **Step 1: Simplify `CreateUserInput` and `createUser`**

Replace the `CreateUserInput` interface (currently lines 76-87):

```ts
export interface CreateUserInput {
  fullName: string
  phone: string
  password: string
  role: Role
  referrerId: string | null
}
```

Replace the body of `createUser` (currently lines 89-145) — the signature and password/id/timestamp setup at the top are unchanged, only the bonus block and doc comment change:

```ts
export async function createUser(db: D1Database, input: CreateUserInput): Promise<AuthUser> {
  const id = crypto.randomUUID()
  const passwordHash = await hashPassword(input.password)
  const referralCode = input.phone // default: the code is the phone (unique because phone is unique)
  const createdAt = new Date().toISOString()

  // User row + registration bonus go in ONE batch so the bonus is atomic with creation — a dup
  // phone rolls back the whole batch, so an orphan bonus is impossible (tech-spec §6.3).
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO users
           (id, full_name, phone, password_hash, role, referrer_id, referral_code, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, input.fullName, input.phone, passwordHash, input.role, input.referrerId, referralCode, createdAt),
  ]

  // The new SUPER_ADMIN earns no points (tech-spec A2); USERs (including admin-created root users)
  // do — always just the self bonus now, referral relationship no longer affects it.
  if (input.role === 'USER') {
    for (const draft of planRegistrationBonuses({ userId: id })) {
      statements.push(draftToStatement(db, draft, createdAt))
    }
    // Notify the new user of their own +100 bonus — always paid for a USER, so always fires.
    statements.push(notifyRegistrationBonus(db, id, createdAt))
  }

  try {
    await db.batch(statements)
  } catch (err) {
    throw translateConflict(err)
  }

  return toAuthUser({
    id,
    full_name: input.fullName,
    phone: input.phone,
    password_hash: passwordHash,
    role: input.role,
    referrer_id: input.referrerId,
    referral_code: referralCode,
    is_active: 1,
    password_version: 0,
    must_change_password: 0,
    temporary_password_expires_at: null,
    password_reset_by: null,
    password_reset_at: null,
    created_at: createdAt,
  })
}
```

Update the import line at the top (currently line 7):

```ts
import { notifyRegistrationBonus } from './notifications'
```

- [ ] **Step 2: Rename `UserSort` and the balance columns**

Replace (currently lines 250-283):

```ts
export type UserSort = 'a_asc' | 'a_desc' | 'b_asc' | 'b_desc' | 'c_asc' | 'c_desc'

export interface ListUsersFilter {
  q?: string
  page: number
  limit: number
  sort?: UserSort
}

// Row shape for listUsers() only — balance_a/balance_b/balance_c are computed columns (SUM over
// point_ledger), not real table columns, so every other UserRow consumer (findById, etc.) is
// unaffected.
export interface UserRowWithBalances extends UserRow {
  balance_a: number
  balance_b: number
  balance_c: number
}

export interface AuthUserWithBalances extends AuthUser {
  balanceA: number
  balanceB: number
  balanceC: number
}

export function toAuthUserWithBalances(row: UserRowWithBalances): AuthUserWithBalances {
  return { ...toAuthUser(row), balanceA: row.balance_a, balanceB: row.balance_b, balanceC: row.balance_c }
}

// Whitelisted, never interpolated from the raw query param — SORT_CLAUSES' keys are the only
// valid `sort` values (also enforced by the route before this is ever called).
const SORT_CLAUSES: Record<UserSort, string> = {
  a_asc: 'balance_a ASC',
  a_desc: 'balance_a DESC',
  b_asc: 'balance_b ASC',
  b_desc: 'balance_b DESC',
  c_asc: 'balance_c ASC',
  c_desc: 'balance_c DESC',
}
```

- [ ] **Step 3: Update the `listUsers` query**

Replace the SQL inside `listUsers` (currently the `SELECT u.*, ...` block around lines 307-317):

```ts
  const { results } = await db
    .prepare(
      `SELECT u.*,
         COALESCE((SELECT SUM(points) FROM point_ledger WHERE user_id = u.id AND wallet = 'A'), 0) AS balance_a,
         COALESCE((SELECT SUM(points) FROM point_ledger WHERE user_id = u.id AND wallet = 'B'), 0) AS balance_b,
         COALESCE((SELECT SUM(points) FROM point_ledger WHERE user_id = u.id AND wallet = 'C'), 0) AS balance_c
       FROM users u ${whereSql}
       ORDER BY ${orderSql}, u.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...args, filter.limit, offset)
    .all<UserRowWithBalances>()
```

Also update the doc comment two lines above `listUsers` that currently says "Every row carries its live F/G balance" — change "F/G" to "A/B/C".

- [ ] **Step 4: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: `src/routes/auth.ts` still errors (passes `referrerEarnsBonus`, a field that no longer exists on `CreateUserInput`) — fixed in Task 9. `src/routes/admin.ts` still errors (`USER_SORTS` uses old sort keys) — fixed in Task 13.

- [ ] **Step 5: Commit**

```bash
git add src/lib/users.ts
git commit -m "feat(users): simplify createUser (no referral bonus), rename sort keys to A/B/C"
```

---

### Task 9: `src/routes/auth.ts` — drop `referrerEarnsBonus`

**Files:**
- Modify: `src/routes/auth.ts`

- [ ] **Step 1: Edit the `/register` handler**

Replace the `createUser` call inside `authRoutes.post('/register', ...)` (currently lines 56-65):

```ts
  try {
    const user = await createUser(c.env.DB, {
      fullName,
      phone,
      password,
      role: 'USER',
      referrerId: referrer.id,
    })
    const token = await signSession(c.env.JWT_SECRET, user.id, 0)
    return c.json({ user, token }, 201)
  } catch (err) {
```

The `referrer` lookup above this (resolving `code` via `findByReferralCode`, 400 if missing) is unchanged — a referral code is still required to register, and `referrer_id` is still stored; only the bonus-eligibility branching (`referrer.role === 'USER'`) is gone, since there's no referral bonus left to be eligible for.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: no more errors in `src/routes/auth.ts`. Remaining errors are in `src/routes/admin.ts`, `src/routes/points.ts`, `src/lib/orders.ts`, `src/lib/bonuses.ts` — fixed in Tasks 10-13.

- [ ] **Step 3: Commit**

```bash
git add src/routes/auth.ts
git commit -m "feat(auth): drop referrerEarnsBonus — no referral-signup bonus left to gate"
```

---

### Task 10: `src/lib/orders.ts` — `activateCustomer()` settles B/C only, A is exempt

**Files:**
- Modify: `src/lib/orders.ts`

- [ ] **Step 1: Rewrite the doc comment and body of `activateCustomer`**

Replace the doc comment above `activateCustomer` (currently lines 130-151):

```ts
/**
 * Admin activates a customer who already paid the CTV in cash, and SETTLES the CTV'S B AND C
 * WALLETS IN FULL — every point they hold in those two wallets is cashed out on the spot, both
 * ending at 0. Wallet A (referral commission earned when a CTV they referred lands a customer) is
 * deliberately NEVER touched here — it doesn't auto-drain; an admin settles it out-of-band.
 *
 * One batch: the order (APPROVED from creation, there is no PENDING step) + its order_events
 * audit row + CUSTOMER_REWARD (wallet B) to the CTV + CUSTOMER_REFERRAL_BONUS (wallet A) to their
 * referrer + one or two REDEMPTION rows draining the CTV's B and C wallets + one notification to
 * the CTV + the referrer's usual bonus notification.
 *
 * The referrer is deliberately NOT settled — their wallet A commission keeps accruing until they
 * close a customer of their own, at which point their own activation settles their B/C (not A).
 *
 * The drained amounts are read via getBalances() before the batch (same pre-flight-then-bind
 * pattern redeem() already uses, not a live SQL subquery), then bound as literal amounts: B is
 * the CTV's current balance plus this order's CUSTOMER_REWARD (which hasn't landed yet at read
 * time), C is whatever it currently holds. point_ledger CHECKs `points <> 0`, so the C row is
 * only added to the batch when there's actually something to drain.
 *
 * Deliberately NOT a composition of approveOrder() + redeem() — both fire their own
 * notification unconditionally inside their own atomic batch, so reusing them would produce
 * two or three notifications where the CTV should get exactly one.
 */
```

Replace the body of `activateCustomer` (currently lines 152-234):

```ts
export async function activateCustomer(db: D1Database, input: ActivateCustomerInput): Promise<ActivateCustomerResult> {
  const { userId, fullName, phone, orderCode, idempotencyKey, adminId, now } = input

  const ctv = await db
    .prepare(`SELECT id, full_name FROM users WHERE id = ? AND role = 'USER'`)
    .bind(userId)
    .first<{ id: string; full_name: string }>()
  if (!ctv) return { ok: false, error: 'NOT_FOUND' }

  const replay = await db.prepare(`SELECT 1 AS x FROM point_ledger WHERE idempotency_key = ? LIMIT 1`).bind(idempotencyKey).first()
  if (replay) return { ok: false, error: 'DUPLICATE' }

  // Read before the batch (same pre-flight-then-bind pattern redeem() uses) — this order's own
  // CUSTOMER_REWARD hasn't landed yet, so add it to B by hand to get what the CTV is about to hold.
  const before = await getBalances(db, userId)
  const paidB = before.b + POINTS.CUSTOMER_REWARD
  const paidC = before.c

  const orderId = crypto.randomUUID()
  const redemptionBId = crypto.randomUUID()

  const statements: D1PreparedStatement[] = [
    // Order, already APPROVED — activation_code mirrors orderCode (not asked for separately).
    db
      .prepare(
        `INSERT INTO orders
           (id, user_id, full_name, phone, order_code, activation_code, note, status, decided_by, decided_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`,
      )
      .bind(orderId, userId, fullName, phone, orderCode, orderCode, DIRECT_ACTIVATION_ORDER_NOTE, adminId, now, now, now),
    // Audit trail parity with a normal approval.
    db
      .prepare(`INSERT INTO order_events (id, order_id, type, actor_id, reason, created_at) VALUES (?, ?, 'APPROVED', ?, NULL, ?)`)
      .bind(crypto.randomUUID(), orderId, adminId, now),
    // +500 B to the CTV.
    db
      .prepare(`INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at) VALUES (?, ?, 'B', 'CUSTOMER_REWARD', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, POINTS.CUSTOMER_REWARD, orderId, now),
    // +100 A to the direct referrer — same condition as before (referrer is a USER). Deliberately
    // NOT settled here: wallet A keeps accruing until the referrer's own activation, and even then
    // that activation only ever touches B/C, never A.
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         SELECT ?, r.id, 'A', 'CUSTOMER_REFERRAL_BONUS', ?, ?, ?
         FROM users u JOIN users r ON r.id = u.referrer_id
         WHERE u.id = ? AND r.role = 'USER'`,
      )
      .bind(crypto.randomUUID(), POINTS.CUSTOMER_REFERRAL, orderId, now, userId),
    // Drain B to 0 — the CTV's entire B balance, not just this order's own reward.
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
         VALUES (?, ?, 'B', 'REDEMPTION', ?, ?, ?, ?, ?)`,
      )
      .bind(redemptionBId, userId, -paidB, idempotencyKey, DIRECT_ACTIVATION_REDEMPTION_NOTE, adminId, now),
    // One notification to the CTV, tied to the B redemption row above (always written — B is
    // never 0 here, CUSTOMER_REWARD just landed).
    notifyCustomerActivated(db, redemptionBId, fullName, orderCode, paidB, paidC, now),
    // The referrer's own notification, unaffected by this flow — fires iff the +100 leg was paid.
    notifyCustomerReferralBonus(db, orderId, ctv.full_name, now),
  ]

  // Drain C too, but only if there's anything in it — point_ledger CHECKs points <> 0.
  if (paidC > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
           VALUES (?, ?, 'C', 'REDEMPTION', ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), userId, -paidC, idempotencyKey, DIRECT_ACTIVATION_REDEMPTION_NOTE, adminId, now),
    )
  }

  try {
    await db.batch(statements)
  } catch (err) {
    if (isDuplicateRedemption(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }

  return { ok: true, order: toOrder((await findOrderById(db, orderId))!), paid: { b: paidB, c: paidC } }
}
```

- [ ] **Step 2: Update the `ActivateCustomerResult` type**

Replace (currently lines 122-125):

```ts
export type ActivateCustomerResult =
  | { ok: true; order: Order; paid: { b: number; c: number } }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'DUPLICATE' }
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: remaining errors only in `src/lib/bonuses.ts`, `src/routes/points.ts`, `src/routes/admin.ts` — fixed in Tasks 11-13.

- [ ] **Step 4: Commit**

```bash
git add src/lib/orders.ts
git commit -m "feat(orders): activateCustomer settles wallets B/C only, wallet A is exempt"
```

---

### Task 11: `src/lib/bonuses.ts` — grant into wallet C

**Files:**
- Modify: `src/lib/bonuses.ts`

- [ ] **Step 1: Change the wallet literal**

In `grantBonus`, the per-recipient `INSERT INTO point_ledger` (currently around line 92-98):

```ts
        db
          .prepare(
            `INSERT INTO point_ledger (id, user_id, wallet, type, points, bonus_grant_id, note, created_by, created_at)
             VALUES (?, ?, 'C', 'ADMIN_BONUS', ?, ?, ?, ?, ?)`,
          )
          .bind(ledgerId, userId, input.amount, grantId, input.content, input.adminId, input.now),
```

Nothing else in the file changes — `countCtvUsers`, the idempotency/duplicate-grant handling, and the `ALL`/`PHONE` scoping are unaffected.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: remaining errors only in `src/routes/points.ts` and `src/routes/admin.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/bonuses.ts
git commit -m "feat(bonuses): admin grants land in wallet C"
```

---

### Task 12: `src/routes/points.ts` — wallet validation and ledger types

**Files:**
- Modify: `src/routes/points.ts`

- [ ] **Step 1: Update `LEDGER_TYPES` and the wallet check**

```ts
const LEDGER_TYPES: readonly LedgerType[] = [
  'REGISTRATION_BONUS', 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET',
  'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION',
]
```

In `pointsRoutes.get('/ledger', ...)`, replace the wallet-validation line:

```ts
  if (wallet !== undefined && wallet !== 'A' && wallet !== 'B' && wallet !== 'C') return c.json({ error: 'invalid wallet' }, 400)
```

`GET /balances` needs no code change — it spreads whatever `getBalances()` returns, so the response body becomes `{ a, b, c, redemptionUnlocked }` automatically.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: remaining errors only in `src/routes/admin.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/points.ts
git commit -m "feat(routes): points wallet filter accepts A/B/C"
```

---

### Task 13: `src/routes/admin.ts` — sort keys, wallet validation, ledger types

**Files:**
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Update `LEDGER_TYPES` and `USER_SORTS`**

```ts
const LEDGER_TYPES: readonly LedgerType[] = [
  'REGISTRATION_BONUS', 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS',
  'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION',
]

const USER_SORTS: readonly UserSort[] = ['a_asc', 'a_desc', 'b_asc', 'b_desc', 'c_asc', 'c_desc']
```

- [ ] **Step 2: Update the ledger wallet-validation line**

In `adminRoutes.get('/ledger', ...)`:

```ts
  if (wallet !== undefined && wallet !== 'A' && wallet !== 'B' && wallet !== 'C') return c.json({ error: 'invalid wallet' }, 400)
```

`GET /users/:id/balances` and `GET /users` need no further code change — both already just spread/map through `getBalances`/`toAuthUserWithBalances`.

- [ ] **Step 3: Verify the whole project compiles clean**

Run: `pnpm exec tsc --noEmit`
Expected: PASS, no errors anywhere.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(routes): admin ledger/users wallet filters and sort keys accept A/B/C"
```

---

### Task 14: `test/helpers.ts` — update the stale F/G doc comment

**Files:**
- Modify: `test/helpers.ts`

- [ ] **Step 1: Update the doc comment on `activateCustomerFor`**

Replace the comment block above `activateCustomerFor` (currently lines 68-76):

```ts
/**
 * Admin-activates one customer for `userId` — the only way an order comes into existence now
 * (POST /api/admin/orders/activate). Writes an already-APPROVED order plus CUSTOMER_REWARD, then
 * SETTLES the CTV's B and C wallets: every point they hold in those two wallets (not just this
 * order's reward) is drained to 0 in the same batch, exactly as production does. Wallet A (if the
 * CTV has any referral commission) is untouched. So the CTV ends up redemption-UNLOCKED but at
 * B = 0, C = 0 — any test that needs a real B/C balance afterwards has to add it back by hand (see
 * unlockedUser() in redemptions.test.ts for the pattern).
 */
```

- [ ] **Step 2: Verify no functional change**

This is a comment-only edit; run `pnpm exec tsc --noEmit` to confirm nothing else broke (should already be clean from Task 13).

- [ ] **Step 3: Commit**

```bash
git add test/helpers.ts
git commit -m "docs(test): update activateCustomerFor comment for wallet A/B/C"
```

---

### Task 15: `test/constraints.test.ts` — update remaining F/G-specific cases

**Files:**
- Modify: `test/constraints.test.ts`

Task 1 already added new A/B/C CHECK cases. This task fixes the *pre-existing* cases in the same file that still hard-code wallet `'F'`/`'G'` in setup SQL unrelated to what they're actually testing (the R4 idempotency test, and the two ADMIN_BONUS CHECK tests).

- [ ] **Step 1: Fix the R4 test's wallet literal**

In the `'R4 uq_ledger_idem: ...'` test, change the `INSERT INTO point_ledger` wallet literal from `'F'` to `'B'`:

```ts
    const row = (id: string) =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, created_at)
         VALUES (?, ?, 'B', 'REDEMPTION', -10, ?, '2026-01-01T00:00:00.000Z')`,
      ).bind(id, uid, key)
```

- [ ] **Step 2: Fix the two ADMIN_BONUS CHECK tests**

In `'rejects an ADMIN_BONUS row with no bonus_grant_id'`, change the wallet literal from `'G'` to `'C'`:

```ts
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, created_at)
         VALUES (?, ?, 'C', 'ADMIN_BONUS', 10, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid)
        .run(),
    )
```

Rename `'rejects an ADMIN_BONUS row in wallet F'` to `'rejects an ADMIN_BONUS row in wallet B'`, changing its `INSERT`'s wallet literal from `'F'` to `'B'`:

```ts
  it('rejects an ADMIN_BONUS row in wallet B', async () => {
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
         VALUES (?, ?, 'B', 'ADMIN_BONUS', 10, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, grantId)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })
```

- [ ] **Step 3: Run the full file**

Run: `pnpm test -- test/constraints.test.ts`
Expected: PASS, all cases including the ones added in Task 1.

- [ ] **Step 4: Commit**

```bash
git add test/constraints.test.ts
git commit -m "test: update constraints.test.ts wallet literals to A/B/C"
```

---

### Task 16: `test/points.test.ts` — rewrite for the removed referral-signup bonus and A/B/C

**Files:**
- Modify: `test/points.test.ts`

Several existing tests specifically exercise `REFERRAL_SIGNUP_BONUS`, which no longer exists — those are deleted rather than adapted (there's no replacement behavior to test). The rest are updated for wallet letters.

- [ ] **Step 1: Replace the full file**

```ts
import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, post, registerUser, seedAdmin } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

describe('registration bonuses', () => {
  it('credits only the registrant\'s own registration bonus — referring someone earns nothing on its own', async () => {
    const admin = await seedAdmin() // SUPER_ADMIN earns no points
    const a = await registerUser(admin.referralCode, '0912345678') // A +100
    const b = await registerUser(a.referralCode, '0987654321') // B +100, A earns nothing

    const aBal = await (await get('/api/points/balances', a.token)).json<{ a: number; b: number; c: number; redemptionUnlocked: boolean }>()
    expect(aBal).toEqual({ a: 0, b: 100, c: 0, redemptionUnlocked: false })

    const bBal = await (await get('/api/points/balances', b.token)).json<{ b: number }>()
    expect(bBal.b).toBe(100)
  })

  it('a duplicate-phone registration is a 409 and leaves no orphan ledger rows', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678')
    const before = await ledgerCount()

    const dup = await post('/api/auth/register', {
      fullName: 'Dup', phone: '0912345678', password: 'userpass123', referralCode: admin.referralCode,
    })
    expect(dup.status).toBe(409)
    expect(await ledgerCount()).toBe(before)
  })
})

describe('ledger listing', () => {
  it('is self-scoped — a user never sees another user\'s rows', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await registerUser(a.referralCode, '0987654321') // no longer gives A any row

    const res = await get('/api/points/ledger', a.token)
    const { entries, total } = await res.json<{ entries: { userId: string; type: string }[]; total: number }>()
    expect(total).toBe(1) // just A's own REGISTRATION_BONUS
    expect(entries.every((e) => e.userId === a.id)).toBe(true)
  })

  it('filters by wallet and rejects an invalid wallet', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    const cOnly = await get('/api/points/ledger?wallet=C', a.token)
    expect((await cOnly.json<{ total: number }>()).total).toBe(0) // registration rows are wallet B

    const bad = await get('/api/points/ledger?wallet=X', a.token)
    expect(bad.status).toBe(400)
  })

  it('filters by direction (credit/debit) and rejects an invalid one', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // REGISTRATION_BONUS, a credit

    const credits = await get('/api/points/ledger?direction=credit', a.token)
    expect((await credits.json<{ total: number }>()).total).toBe(1)
    const debits = await get('/api/points/ledger?direction=debit', a.token)
    expect((await debits.json<{ total: number }>()).total).toBe(0)

    const bad = await get('/api/points/ledger?direction=sideways', a.token)
    expect(bad.status).toBe(400)
  })

  it('a CUSTOMER_REWARD row traces back to the order (orderCode/orderFullName)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, a.id, { fullName: 'Nguyen Van Trace' })

    const res = await get('/api/points/ledger?type=CUSTOMER_REWARD', a.token)
    const { entries } = await res.json<{ entries: { orderCode: string | null; orderFullName: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderCode).toBe(order.orderCode)
    expect(entries[0].orderFullName).toBe('Nguyen Van Trace')
  })

  it('q searches by the linked order\'s name/phone/code, excluding rows with no order', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, a.id, { fullName: 'Findable Person' })

    const byName = await get('/api/points/ledger?q=Findable', a.token)
    expect((await byName.json<{ total: number }>()).total).toBe(1)

    const byCode = await get(`/api/points/ledger?q=${order.orderCode}`, a.token)
    expect((await byCode.json<{ total: number }>()).total).toBe(1)

    const noMatch = await get('/api/points/ledger?q=nope-nothing-here', a.token)
    expect((await noMatch.json<{ total: number }>()).total).toBe(0)
  })

  it('a CUSTOMER_REFERRAL_BONUS row exposes the name of the referred CTV who closed the customer, and lands in wallet A', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    const b = await registerUser(a.referralCode, '0987654321', 'CTV B Duoc Gioi Thieu')
    await activateCustomerFor(admin.token, b.id, { fullName: 'Khach Cua B' })

    const res = await get('/api/points/ledger?type=CUSTOMER_REFERRAL_BONUS', a.token)
    const { entries } = await res.json<{ entries: { orderOwnerFullName: string | null; wallet: string }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderOwnerFullName).toBe('CTV B Duoc Gioi Thieu')
    expect(entries[0].wallet).toBe('A')

    const aBal = await (await get('/api/points/balances', a.token)).json<{ a: number }>()
    expect(aBal.a).toBe(100)
  })
})
```

Removed relative to the previous file: the `'pays no REFERRAL_SIGNUP_BONUS when the referrer is the SUPER_ADMIN (A2)'` test, the `'a REFERRAL_SIGNUP_BONUS row exposes ...'` test, and the whole `'admin ledger: subjectUserFullName traceability'` describe block — all three exercised a bonus type that no longer exists, with no replacement behavior.

- [ ] **Step 2: Run the file**

Run: `pnpm test -- test/points.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/points.test.ts
git commit -m "test: rewrite points.test.ts for wallet A/B/C, drop REFERRAL_SIGNUP_BONUS coverage"
```

---

### Task 17: `test/admin-users.test.ts` — balance/sort fields rename

**Files:**
- Modify: `test/admin-users.test.ts`

- [ ] **Step 1: Update the `UserRow` interface**

```ts
interface UserRow {
  id: string
  fullName: string
  phone: string
  balanceA: number
  balanceB: number
  balanceC: number
}
```

- [ ] **Step 2: Replace the balance test**

Replace `'each row carries the real F/G balances'`:

```ts
  it('each row carries the real A/B/C balances', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // +100 B registration

    const res = await get('/api/admin/users?q=0912345678', admin.token)
    const { users } = await res.json<ListUsersResponse>()
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ balanceA: 0, balanceB: 100, balanceC: 0 })
  })
```

- [ ] **Step 3: Replace the two sort tests**

Replace `'sort=f_asc / f_desc orders by F balance'`:

```ts
  it('sort=b_asc / b_desc orders by B balance', async () => {
    const admin = await seedAdmin()
    const undrained = await registerUser(admin.referralCode, '0911111111', 'Undrained') // B = 100
    const drained = await registerUser(admin.referralCode, '0922222222', 'Drained') // B = 100, then settled to 0 by its own activation
    await activateCustomerFor(admin.token, drained.id)

    const asc = await (await get('/api/admin/users?sort=b_asc', admin.token)).json<ListUsersResponse>()
    const ascIds = asc.users.map((u) => u.id)
    expect(ascIds.indexOf(drained.id)).toBeLessThan(ascIds.indexOf(undrained.id)) // 0 sorts before 100

    const desc = await (await get('/api/admin/users?sort=b_desc', admin.token)).json<ListUsersResponse>()
    const descIds = desc.users.map((u) => u.id)
    expect(descIds.indexOf(undrained.id)).toBeLessThan(descIds.indexOf(drained.id))
  })
```

Replace `'sort=g_asc / g_desc orders by G balance'`:

```ts
  it('sort=c_asc / c_desc orders by C balance', async () => {
    const admin = await seedAdmin()
    const low = await registerUser(admin.referralCode, '0933333333', 'LowC')
    const high = await registerUser(admin.referralCode, '0944444444', 'HighC')
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
       VALUES (?, ?, 'C', 'MAINTENANCE_ACCRUAL', 100, 1, ?)`,
    )
      .bind(crypto.randomUUID(), high.id, new Date().toISOString())
      .run()

    const desc = await (await get('/api/admin/users?sort=c_desc', admin.token)).json<ListUsersResponse>()
    const descIds = desc.users.map((u) => u.id)
    expect(descIds.indexOf(high.id)).toBeLessThan(descIds.indexOf(low.id))
  })
```

Note: the `sort=b_asc/b_desc` test above uses `activateCustomerFor` (already imported by the file? check the top-of-file import list — it currently imports `{ get, registerUser, seedAdmin }` from `./helpers`; add `activateCustomerFor` to that import list) instead of hand-inserting a ledger row, because unlike the old F-wallet test (which added a `REFERRAL_SIGNUP_BONUS` row that doesn't exist anymore), B's balance can only meaningfully differ via a real registration + activation.

- [ ] **Step 3: Update the import line**

```ts
import { activateCustomerFor, get, registerUser, seedAdmin } from './helpers'
```

- [ ] **Step 4: Run the file**

Run: `pnpm test -- test/admin-users.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/admin-users.test.ts
git commit -m "test: rewrite admin-users.test.ts for wallet A/B/C balances and sort keys"
```

---

### Task 18: `test/admin-bonuses.test.ts` — wallet C

**Files:**
- Modify: `test/admin-bonuses.test.ts`

- [ ] **Step 1: Rename the balance helper**

Replace `gBalance`:

```ts
async function cBalance(userId: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COALESCE(SUM(points),0) AS c FROM point_ledger WHERE user_id = ? AND wallet = 'C'`)
    .bind(userId)
    .first<{ c: number }>()
  return row?.c ?? 0
}
```

- [ ] **Step 2: Replace every `gBalance(...)` call with `cBalance(...)`**

There are 5 call sites (in the `'credits every USER...'`, `'a repeated idempotencyKey...'`, and `'credits exactly the phone-matched CTV...'` tests) — rename each `gBalance(` to `cBalance(`. No other logic changes; the assertions (amounts, which user is/isn't credited) are unchanged, only the wallet the money lands in.

- [ ] **Step 3: Run the file**

Run: `pnpm test -- test/admin-bonuses.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/admin-bonuses.test.ts
git commit -m "test: rename gBalance to cBalance in admin-bonuses.test.ts"
```

---

### Task 19: `test/admin-activate-customer.test.ts` — full rewrite for B/C settlement + A exemption

**Files:**
- Modify: `test/admin-activate-customer.test.ts`

This is the test file most affected by the behavior change: the referrer's balance calculation changes (no more `REFERRAL_SIGNUP_BONUS` leg), and a **new** case is added proving wallet A survives the CTV's own activation.

- [ ] **Step 1: Replace the full file**

```ts
import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

async function balances(token: string): Promise<{ a: number; b: number; c: number }> {
  const res = await get('/api/points/balances', token)
  const { a, b, c } = await res.json<{ a: number; b: number; c: number }>()
  return { a, b, c }
}

interface ActivateResponse {
  order: { id: string; status: string; fullName: string; orderCode: string }
  paid: { b: number; c: number }
}

describe('POST /api/admin/orders/activate', () => {
  it('creates an APPROVED order and settles the CTV\'s B wallet to 0, paying the referrer\'s A wallet separately', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911111111') // +100 B registration
    const ctv = await registerUser(referrer.referralCode, '0922222222') // +100 B registration; referrer earns nothing yet

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'Nguyễn Văn Khách', phone: '0933333333', orderCode: 'DH-TEST-01', idempotencyKey: 'k1' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { order, paid } = await res.json<ActivateResponse>()
    expect(order.status).toBe('APPROVED')
    expect(order.fullName).toBe('Nguyễn Văn Khách')
    expect(order.orderCode).toBe('DH-TEST-01')
    // 100 registration + 500 reward = 600 paid out of B; C had nothing.
    expect(paid).toEqual({ b: 600, c: 0 })

    // CTV: B/C fully settled — every point they held there is gone.
    expect(await balances(ctv.token)).toEqual({ a: 0, b: 0, c: 0 })
    // Referrer: B untouched (just their own 100 registration bonus — no signup bonus exists
    // anymore). A gets exactly the 100 commission from the CTV's activation, and is NOT drained
    // (the referrer hasn't activated their own customer).
    expect(await balances(referrer.token)).toEqual({ a: 100, b: 100, c: 0 })

    const ctvNotifs = await (await get('/api/notifications', ctv.token)).json<{
      notifications: { type: string; title: string; body: string }[]
    }>()
    const activationNotifs = ctvNotifs.notifications.filter((n) => n.title === 'Khách hàng đã được kích hoạt')
    expect(activationNotifs).toHaveLength(1)
    expect(activationNotifs[0].type).toBe('REDEMPTION')
    expect(activationNotifs[0].body).toContain('600')

    const referrerNotifs = await (await get('/api/notifications', referrer.token)).json<{
      notifications: { type: string }[]
    }>()
    expect(referrerNotifs.notifications.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toHaveLength(1)
  })

  it('a CTV who already holds an A balance (commission from a CTV they referred) keeps it after activating their own customer', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911199991')
    const referredCtv = await registerUser(referrer.referralCode, '0911199992')

    // The referred CTV lands a customer — referrer earns +100 A.
    await post(
      '/api/admin/orders/activate',
      { userId: referredCtv.id, fullName: 'Khach A', phone: '0911199993', orderCode: 'DH-TEST-0A', idempotencyKey: 'ka' },
      admin.token,
    )
    expect(await balances(referrer.token)).toEqual({ a: 100, b: 100, c: 0 })

    // The referrer now lands their own customer — B settles, A must be untouched.
    const res = await post(
      '/api/admin/orders/activate',
      { userId: referrer.id, fullName: 'Khach B', phone: '0911199994', orderCode: 'DH-TEST-0B', idempotencyKey: 'kb' },
      admin.token,
    )
    const { paid } = await res.json<ActivateResponse>()
    expect(paid).toEqual({ b: 600, c: 0 }) // 100 registration + 500 reward
    expect(await balances(referrer.token)).toEqual({ a: 100, b: 0, c: 0 }) // A survives untouched
  })

  it('drains an existing C balance too, and skips the C ledger row entirely when C is 0', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0933000001')

    // Give the CTV a C balance the way maintenance accrual would, without waiting a month for it.
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
       VALUES (?, ?, 'C', 'MAINTENANCE_ACCRUAL', 100, 1, ?)`,
    )
      .bind(crypto.randomUUID(), ctv.id, new Date().toISOString())
      .run()
    expect((await balances(ctv.token)).c).toBe(100)

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-02', idempotencyKey: 'k2' },
      admin.token,
    )
    const { paid } = await res.json<ActivateResponse>()
    // 100 registration + 500 reward = 600 B; the 100 C accrued above.
    expect(paid).toEqual({ b: 600, c: 100 })
    expect(await balances(ctv.token)).toEqual({ a: 0, b: 0, c: 0 })

    const rows = await env.DB.prepare(`SELECT wallet, points FROM point_ledger WHERE user_id = ? AND type = 'REDEMPTION'`)
      .bind(ctv.id)
      .all<{ wallet: string; points: number }>()
    expect(rows.results).toHaveLength(2) // both B and C drained

    // A second activation with an empty C wallet must not write a 0-point C row (CHECK points<>0).
    const second = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'B', phone: '0955555556', orderCode: 'DH-TEST-02B', idempotencyKey: 'k2b' },
      admin.token,
    )
    expect(second.status).toBe(201)
    const rowsAfter = await env.DB.prepare(`SELECT wallet FROM point_ledger WHERE user_id = ? AND type = 'REDEMPTION'`)
      .bind(ctv.id)
      .all<{ wallet: string }>()
    expect(rowsAfter.results.map((r) => r.wallet).sort()).toEqual(['B', 'B', 'C']) // no new C row
  })

  it('pays no referrer bonus when the CTV\'s referrer is the admin (A2-style)', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0944444444')

    await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-03', idempotencyKey: 'k3' },
      admin.token,
    )
    expect(await balances(ctv.token)).toEqual({ a: 0, b: 0, c: 0 }) // settled, no referrer leg to pay

    const res = await get(`/api/admin/ledger?userId=${admin.id}&type=CUSTOMER_REFERRAL_BONUS`, admin.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)
  })

  it('rejects a replayed idempotencyKey with 409, no duplicate rows', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0966666666')
    const body = { userId: ctv.id, fullName: 'B', phone: '0977777777', orderCode: 'DH-TEST-04', idempotencyKey: 'k4' }

    const first = await post('/api/admin/orders/activate', body, admin.token)
    expect(first.status).toBe(201)
    const second = await post('/api/admin/orders/activate', body, admin.token)
    expect(second.status).toBe(409)

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE order_code = ?')
      .bind('DH-TEST-04')
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('404s for an unknown or non-USER userId', async () => {
    const admin = await seedAdmin()
    const body = { fullName: 'C', phone: '0988888888', orderCode: 'DH-TEST-05', idempotencyKey: 'k5' }

    expect((await post('/api/admin/orders/activate', { ...body, userId: 'does-not-exist' }, admin.token)).status).toBe(404)
    expect((await post('/api/admin/orders/activate', { ...body, userId: admin.id }, admin.token)).status).toBe(404)
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0999999999')
    const body = { userId: ctv.id, fullName: 'D', phone: '0900000009', orderCode: 'DH-TEST-06', idempotencyKey: 'k6' }

    expect((await post('/api/admin/orders/activate', body)).status).toBe(401)
    expect((await post('/api/admin/orders/activate', body, ctv.token)).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the file**

Run: `pnpm test -- test/admin-activate-customer.test.ts`
Expected: PASS, including the new "keeps wallet A after activating their own customer" case.

- [ ] **Step 3: Commit**

```bash
git add test/admin-activate-customer.test.ts
git commit -m "test: rewrite admin-activate-customer.test.ts for B/C settlement and A exemption"
```

---

### Task 20: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: PASS, every project (`domain` and `workers`), no skipped/failing tests.

- [ ] **Step 2: Typecheck the whole project**

Run: `pnpm exec tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Grep for anything missed**

Run: `grep -rn "'F'\|'G'\|REFERRAL_SIGNUP\|paidF\|paidG\|balanceF\|balanceG\|f_asc\|g_asc" src/ test/ --include="*.ts"`
Expected: no matches (or only matches that are clearly unrelated, e.g. a variable named `config` containing the letter sequence — inspect anything that shows up).

- [ ] **Step 4: Commit if the grep step required any fixes**

If Step 3 found something, fix it, re-run Steps 1-3, then:

```bash
git add -A
git commit -m "fix: address remaining F/G references found in final sweep"
```

If Step 3 found nothing, no commit is needed for this task.

---

### Task 21: Local DB — wipe and reseed

**Files:** none (operational)

This applies the new migration to your local D1 and starts local data from a clean slate, matching the design's "all data is wiped" precondition. Safe to run — this is your local dev database.

- [ ] **Step 1: Check what local migrations state exists**

Run: `pnpm db:migrate:local` (applies any migration not yet applied locally, including `0013_wallet_abc.sql`) — if this fails because old data violates the new CHECK constraints (expected, since local likely has old F/G rows from prior manual testing), proceed to Step 2.

- [ ] **Step 2: Wipe local data**

```bash
npx wrangler d1 execute xkld-db --local --command "
DELETE FROM notifications;
DELETE FROM point_ledger;
DELETE FROM orders;
DELETE FROM bonus_grants;
DELETE FROM password_reset_log;
DELETE FROM users;
"
```

- [ ] **Step 3: Re-apply migrations**

Run: `pnpm db:migrate:local`
Expected: succeeds — `0013_wallet_abc.sql` now rebuilds empty tables.

- [ ] **Step 4: Reseed the local SUPER_ADMIN**

Run: `pnpm seed:admin --phone <your-test-phone> --name 'Super Admin' --local` and enter a password when prompted.

- [ ] **Step 5: Smoke-test locally**

Run: `pnpm dev`, then in another terminal register a CTV and activate a customer for them via curl/Postman/the client app, confirming `GET /api/points/balances` returns `{ a, b, c, redemptionUnlocked }`.

No commit for this task — it's a local data operation, not a code change.

---

### Task 22: Production — wipe and reseed (MANUAL, requires live confirmation)

**Files:** none (operational — production, irreversible)

**Do not run this task's commands automatically as part of a scripted plan execution.** This deletes all production data (`users`, `orders`, `point_ledger`, `notifications`, `bonus_grants`, `password_reset_log` — every CTV account, every order, every point ever earned) and cannot be undone. Stop here and get an explicit, freshly-given go-ahead from the requester immediately before running Step 2 — approval given earlier in this project (e.g. when the design was approved) does not count as authorization for this specific irreversible action at execution time.

- [ ] **Step 1: Confirm all prior tasks are deployed**

Deploy the code from Tasks 1-20 (`pnpm deploy`) *before* wiping production — otherwise the old code (still expecting F/G) will run against a database whose schema Task 1's migration hasn't reached yet in production. Apply the migration: `wrangler d1 migrations apply xkld-db --remote` will fail against non-empty old-schema data (by design, per Task 1's safety-net comment) — this is expected; the wipe in Step 2 must happen first.

Actually apply in this order:
1. `pnpm deploy` (ships the new code — it will 500 on wallet-shaped requests until Step 2/3 land, so expect brief errors in production between this step and Step 3; do this at a low-traffic time)
2. Step 2 below (wipe)
3. Step 3 below (migrate)
4. Step 4 below (reseed)

- [ ] **Step 2: Wipe production data**

Get final confirmation, then run:

```bash
npx wrangler d1 execute xkld-db --remote --command "
DELETE FROM notifications;
DELETE FROM point_ledger;
DELETE FROM orders;
DELETE FROM bonus_grants;
DELETE FROM password_reset_log;
DELETE FROM users;
"
```

- [ ] **Step 3: Apply the migration to production**

```bash
npx wrangler d1 migrations apply xkld-db --remote
```

Expected: `0013_wallet_abc.sql` applies cleanly against the now-empty tables.

- [ ] **Step 4: Reseed the production SUPER_ADMIN**

```bash
pnpm seed:admin --phone <real-admin-phone> --name '<real-admin-name>'
```

(no `--local` flag — this targets production; enter the real admin password when prompted, interactively, never via shell history)

- [ ] **Step 5: Verify**

Log in as the reseeded admin against the production URL and confirm `GET /api/points/balances` and `POST /api/admin/users` (create a test root CTV) work end-to-end.

No commit for this task — it's a production data operation, not a code change.

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** every section of the design doc maps to a task — schema (Task 1), domain types/constants (Task 2), registration planner (Task 3), dead-code removal (Task 4), notification copy (Task 5), notification builders (Task 6), `getBalances` (Task 7), `createUser`/sort/list (Task 8), the auth route (Task 9), `activateCustomer` (Task 10), `bonuses.ts` (Task 11), both routes files (Tasks 12-13), the doc-comment cleanup (Task 14), and every affected test file (Tasks 15-19). The data-wipe precondition is Tasks 21-22.
- **Task ordering** follows the dependency chain surfaced by `tsc --noEmit` at each step (noted explicitly in each task's compile-check step) so an executor never has to guess whether a red compile is expected-red-for-now or a real regression.
- **Out of scope, confirmed with requester:** an admin endpoint to manually redeem wallet A, and any `xkld-tools-client` (frontend) changes — both explicitly deferred to a later round.
