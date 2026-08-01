# Admin CTV-Parity Tiles + Customer Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin user-detail page's 3 plain tiles with 4 tiles + dedicated
sub-pages identical to the CTV's own dashboard/points/rewards/referred-* screens, and add
a new admin-only "Kích hoạt khách hàng" flow that creates an already-approved,
already-netted-to-zero order on behalf of a CTV whose customer already paid in cash.

**Architecture:** Backend adds exactly one new function (`activateCustomer()` in
`orders.ts`) and one new route (`POST /api/admin/orders/activate`) that writes its own
`db.batch()` — deliberately not a composition of the existing `approveOrder()`/`redeem()`,
because both of those fire their own notification and this flow needs exactly one.
Frontend adds 4 new route files mirroring the CTV's `_user/{points,rewards,referred-ctvs,
referred-customers}.tsx` almost verbatim (swapping self-scoped hooks for
admin/`userId`-scoped ones), widens two shared components (`DetailHeaderCard`,
`AdminShell`) to support being used outside the CTV's own self-view, and adds an
activation form to `/admin/orders`.

**Tech Stack:** Hono + D1 (backend), React + TanStack Router + TanStack Query + Tailwind
(frontend). Backend: TDD with Vitest. Frontend: no test framework in this repo — verified
via `tsc -b --noEmit` (`pnpm build`) plus manual dev-server check.

**Spec:** `docs/superpowers/specs/2026-08-01-admin-customer-activation-design.md`

---

## Task 1: Backend — message + notification builder foundation

**Repo:** `xkld-tools`

**Files:**
- Modify: `src/domain/notifications/messages.ts`
- Modify: `src/domain/notifications/messages.test.ts`
- Modify: `src/lib/notifications.ts`
- Modify: `src/lib/redemptions.ts`

- [ ] **Step 1: Write the failing test for the new message**

Add to `src/domain/notifications/messages.test.ts`, inside the existing `describe`
block (after the `'referral + customer referral bonuses...'` test):

```ts
  it('customer activated states the customer, order code, and the netted amount', () => {
    const { title, body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900')
    expect(title).toBe('Khách hàng đã được kích hoạt')
    expect(body).toContain('Trần Thị B')
    expect(body).toContain('DH-2026-0900')
    expect(body).toContain(String(POINTS.CUSTOMER_REWARD))
  })
```

And add `customerActivatedMessage` to the import list at the top of the file (alongside
`redemptionMessage`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/domain/notifications/messages.test.ts`
Expected: FAIL — `customerActivatedMessage` is not exported.

- [ ] **Step 3: Implement the message builder**

Add to `src/domain/notifications/messages.ts`, after `redemptionMessage` (end of file):

```ts
// Admin created an already-paid customer's order directly: the CTV's own share is credited
// then immediately redeemed (net zero) since the cash never went through the payout process.
export function customerActivatedMessage(fullName: string, orderCode: string): NotificationContent {
  return {
    title: 'Khách hàng đã được kích hoạt',
    body:
      `Khách hàng ${fullName} (đơn ${orderCode}) đã được kích hoạt. ${POINTS.CUSTOMER_REWARD} điểm ` +
      `ví F đã được cộng và quy đổi ngay vì bạn đã nhận tiền mặt trực tiếp.`,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/domain/notifications/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the notification builder**

In `src/lib/notifications.ts`, add `customerActivatedMessage` to the existing import from
`../domain/notifications/messages` (alongside `redemptionMessage`), then add this function
after `notifyRedemption` (which already demonstrates the exact `ledgerNotif` shape to
follow):

```ts
/** REDEMPTION (custom copy) → the CTV, linked to the redemption row `activateCustomer()`
 *  creates. Reuses the REDEMPTION type deliberately — no new NotificationType needed, and
 *  the CTV's own client already renders REDEMPTION notifications correctly. */
export function notifyCustomerActivated(
  db: D1Database,
  redemptionLedgerId: string,
  fullName: string,
  orderCode: string,
  now: string,
): D1PreparedStatement {
  return ledgerNotif(
    db,
    { type: 'REDEMPTION', content: customerActivatedMessage(fullName, orderCode), whereSql: `l.id = ?`, binds: [redemptionLedgerId] },
    now,
  )
}
```

- [ ] **Step 6: Export the duplicate-check helper from redemptions.ts**

In `src/lib/redemptions.ts`, change the private helper at the bottom of the file from:

```ts
function isDuplicateRedemption(err: unknown): boolean {
```

to:

```ts
export function isDuplicateRedemption(err: unknown): boolean {
```

(`activateCustomer()` in Task 2 reuses this instead of duplicating the D1 error-message
matching logic.)

- [ ] **Step 7: Typecheck and run the full suite**

Run: `pnpm test`
Expected: PASS, no regressions (the new export/functions aren't wired up to any route yet,
so nothing else changes behavior).

- [ ] **Step 8: Commit**

```bash
git add src/domain/notifications/messages.ts src/domain/notifications/messages.test.ts src/lib/notifications.ts src/lib/redemptions.ts
git commit -m "feat: add customer-activation notification message and builder"
```

---

## Task 2: Backend — `activateCustomer()` + `POST /api/admin/orders/activate`

**Repo:** `xkld-tools`

**Files:**
- Create: `test/admin-activate-customer.test.ts`
- Modify: `src/lib/orders.ts`
- Modify: `src/routes/admin.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/admin-activate-customer.test.ts`:

```ts
import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

async function balanceF(token: string): Promise<number> {
  const res = await get('/api/points/balances', token)
  const { f } = await res.json<{ f: number }>()
  return f
}

interface ActivateResponse {
  order: { id: string; status: string; fullName: string; orderCode: string }
}

describe('POST /api/admin/orders/activate', () => {
  it('creates an APPROVED order, nets the CTV F wallet to 0 for this order, pays the referrer, and sends one notification', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911111111') // +10 registration
    const ctv = await registerUser(referrer.referralCode, '0922222222') // +10 registration; referrer +2

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'Nguyễn Văn Khách', phone: '0933333333', orderCode: 'DH-TEST-01', idempotencyKey: 'k1' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { order } = await res.json<ActivateResponse>()
    expect(order.status).toBe('APPROVED')
    expect(order.fullName).toBe('Nguyễn Văn Khách')
    expect(order.orderCode).toBe('DH-TEST-01')

    // CTV: +10 registration, +50 reward, -50 redemption → net 10.
    expect(await balanceF(ctv.token)).toBe(10)
    // Referrer: +10 registration, +2 referral-signup, +10 customer-referral → 22.
    expect(await balanceF(referrer.token)).toBe(22)

    const ctvNotifs = await (await get('/api/notifications', ctv.token)).json<{
      notifications: { type: string; title: string }[]
    }>()
    const activationNotifs = ctvNotifs.notifications.filter((n) => n.title === 'Khách hàng đã được kích hoạt')
    expect(activationNotifs).toHaveLength(1)
    expect(activationNotifs[0].type).toBe('REDEMPTION')

    const referrerNotifs = await (await get('/api/notifications', referrer.token)).json<{
      notifications: { type: string }[]
    }>()
    expect(referrerNotifs.notifications.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toHaveLength(1)
  })

  it('pays no referrer bonus when the CTV\'s referrer is the admin (A2-style)', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0944444444')

    await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-02', idempotencyKey: 'k2' },
      admin.token,
    )
    expect(await balanceF(ctv.token)).toBe(10) // 10 registration only — net zero from activation

    const res = await get(`/api/admin/ledger?userId=${admin.id}&type=CUSTOMER_REFERRAL_BONUS`, admin.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)
  })

  it('rejects a replayed idempotencyKey with 409, no duplicate rows', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0966666666')
    const body = { userId: ctv.id, fullName: 'B', phone: '0977777777', orderCode: 'DH-TEST-03', idempotencyKey: 'k3' }

    const first = await post('/api/admin/orders/activate', body, admin.token)
    expect(first.status).toBe(201)
    const second = await post('/api/admin/orders/activate', body, admin.token)
    expect(second.status).toBe(409)

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE order_code = ?')
      .bind('DH-TEST-03')
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('404s for an unknown or non-USER userId', async () => {
    const admin = await seedAdmin()
    const body = { fullName: 'C', phone: '0988888888', orderCode: 'DH-TEST-04', idempotencyKey: 'k4' }

    expect((await post('/api/admin/orders/activate', { ...body, userId: 'does-not-exist' }, admin.token)).status).toBe(404)
    expect((await post('/api/admin/orders/activate', { ...body, userId: admin.id }, admin.token)).status).toBe(404)
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0999999999')
    const body = { userId: ctv.id, fullName: 'D', phone: '0900000009', orderCode: 'DH-TEST-05', idempotencyKey: 'k5' }

    expect((await post('/api/admin/orders/activate', body)).status).toBe(401)
    expect((await post('/api/admin/orders/activate', body, ctv.token)).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run test/admin-activate-customer.test.ts`
Expected: FAIL — route doesn't exist, all requests 404 (or the first assertion after,
`expect(res.status).toBe(201)`, fails since the catch-all 404 body doesn't match).

- [ ] **Step 3: Implement `activateCustomer()`**

In `src/lib/orders.ts`, add to the top import from `./notifications`:

```ts
import { notifyCustomerActivated, notifyCustomerReferralBonus, notifyOrderApproved, notifyOrderNeedsRevision, notifyOrderRejected } from './notifications'
```

Add a new import line:

```ts
import { isDuplicateRedemption } from './redemptions'
```

Then add, after `approveOrder()` (end of file):

```ts
export interface ActivateCustomerInput {
  userId: string // the CTV
  fullName: string // the customer
  phone: string // the customer
  orderCode: string
  idempotencyKey: string
  adminId: string
  now: string
}

export type ActivateCustomerResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'NOT_FOUND' }
  | { ok: false; error: 'DUPLICATE' }

const DIRECT_ACTIVATION_ORDER_NOTE = 'Kích hoạt trực tiếp bởi admin — khách đã thanh toán tiền mặt'
const DIRECT_ACTIVATION_REDEMPTION_NOTE = 'Khách đã thanh toán trực tiếp — admin kích hoạt'

/**
 * Admin creates an already-approved order for a customer who already paid the CTV in cash
 * outside the system. One batch: order (APPROVED from creation, no PENDING step) + its
 * order_events audit row + the same +50/+10 bonuses approveOrder() pays + an immediate -50
 * redemption of the CTV's own share (net zero — the cash never went through payout) + exactly
 * one notification to the CTV (not the two a plain approve-then-redeem would fire) + the
 * referrer's normal CUSTOMER_REFERRAL_BONUS notification, unchanged.
 *
 * Deliberately NOT a composition of approveOrder() + redeem() — both fire their own
 * notification unconditionally as part of their own atomic batch, so there's no way to reuse
 * them and still end up with one notification.
 */
export async function activateCustomer(db: D1Database, input: ActivateCustomerInput): Promise<ActivateCustomerResult> {
  const { userId, fullName, phone, orderCode, idempotencyKey, adminId, now } = input

  const ctv = await db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'USER'`).bind(userId).first()
  if (!ctv) return { ok: false, error: 'NOT_FOUND' }

  const replay = await db.prepare(`SELECT 1 AS x FROM point_ledger WHERE idempotency_key = ? LIMIT 1`).bind(idempotencyKey).first()
  if (replay) return { ok: false, error: 'DUPLICATE' }

  const orderId = crypto.randomUUID()
  const redemptionId = crypto.randomUUID()

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
    // +50 F to the CTV.
    db
      .prepare(`INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at) VALUES (?, ?, 'F', 'CUSTOMER_REWARD', ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, POINTS.CUSTOMER_REWARD, orderId, now),
    // +10 F to the direct referrer — same condition as approveOrder()'s S3 (referrer is a USER).
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         SELECT ?, r.id, 'F', 'CUSTOMER_REFERRAL_BONUS', ?, ?, ?
         FROM users u JOIN users r ON r.id = u.referrer_id
         WHERE u.id = ? AND r.role = 'USER'`,
      )
      .bind(crypto.randomUUID(), POINTS.CUSTOMER_REFERRAL, orderId, now, userId),
    // -50 F, netting the CTV's own share to zero immediately.
    db
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, note, created_by, created_at)
         VALUES (?, ?, 'F', 'REDEMPTION', ?, ?, ?, ?, ?)`,
      )
      .bind(redemptionId, userId, -POINTS.CUSTOMER_REWARD, idempotencyKey, DIRECT_ACTIVATION_REDEMPTION_NOTE, adminId, now),
    // One notification to the CTV, tied to the redemption row above.
    notifyCustomerActivated(db, redemptionId, fullName, orderCode, now),
    // The referrer's own notification, unaffected by this flow — fires iff the +10 leg was paid.
    notifyCustomerReferralBonus(db, orderId, now),
  ]

  let results: D1Result[]
  try {
    results = await db.batch(statements)
  } catch (err) {
    if (isDuplicateRedemption(err)) return { ok: false, error: 'DUPLICATE' }
    throw err
  }
  void results // batch results aren't individually inspected — every statement here is unconditional or self-guarded

  return { ok: true, order: toOrder((await findOrderById(db, orderId))!) }
}
```

(`customerActivatedMessage` itself is only needed inside `notifyCustomerActivated` —
already wired up in Task 1 — so `orders.ts` doesn't need to import it directly.)

- [ ] **Step 4: Add the route**

In `src/routes/admin.ts`, add `activateCustomer` to the import from `../lib/orders`
(alongside `approveOrder`, `listOrders`, etc.), and add this schema near the other
schemas at the top of the file (after `redemptionSchema`):

```ts
const activateCustomerSchema = type({
  userId: 'string >= 1',
  fullName,
  phone,
  orderCode: '1 <= string <= 100',
  idempotencyKey: 'string >= 1',
}).onUndeclaredKey('reject')
```

Then add the route, after the existing `POST /redemptions` route (end of the "Redemption"
section, before "Balances & ledger"):

```ts
// Admin creates an already-approved order for a customer who already paid the CTV in cash —
// the CTV's own share is credited then immediately netted to zero (tech-spec: customer
// activation). See activateCustomer() for the full batch.
adminRoutes.post('/orders/activate', arktypeValidator('json', activateCustomerSchema), async (c) => {
  const admin = c.get('user')!
  const { userId, fullName, phone, orderCode, idempotencyKey } = c.req.valid('json')
  const result = await activateCustomer(c.env.DB, { userId, fullName, phone, orderCode, idempotencyKey, adminId: admin.id, now: new Date().toISOString() })
  if (result.ok) return c.json({ order: result.order }, 201)
  if (result.error === 'NOT_FOUND') return c.json({ error: 'user not found' }, 404)
  return c.json({ error: 'duplicate activation', code: 'DUPLICATE' }, 409)
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run test/admin-activate-customer.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full backend test suite**

Run: `pnpm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add test/admin-activate-customer.test.ts src/lib/orders.ts src/routes/admin.ts
git commit -m "feat: add POST /api/admin/orders/activate (direct customer activation)"
```

---

## Task 3: Backend — document the new endpoint

**Repo:** `xkld-tools`

**Files:**
- Modify: `docs/API.md`

- [ ] **Step 1: Add the doc section**

Insert a new subsection right after `#### POST /api/admin/redemptions` (find it by
searching for `admin/redemptions` in `docs/API.md`) and before the next `---`:

```markdown
#### `POST /api/admin/orders/activate`

Create an already-`APPROVED` order for a customer who already paid the CTV in cash outside
the system. Pays the same +50 F (creator) / +10 F (referrer) bonuses `POST
/api/admin/orders/:id/approve` does, then immediately redeems the CTV's own +50 back to
zero in the same batch — the CTV's net F balance from this call is 0; only the referrer's
+10 (if any) is a real, non-redeemed credit. The CTV gets exactly one notification (not the
separate "approved" + "redeemed" notifications a manual approve-then-redeem would produce).

**Request body**

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `userId` | string | yes | Must resolve to an existing `USER` (not the super admin). |
| `fullName` | string | yes | The customer — same validator as order creation. |
| `phone` | string | yes | The customer's phone — same validator as order creation. |
| `orderCode` | string | yes | 1–100 chars. Also stored as the order's `activationCode`. |
| `idempotencyKey` | string | yes | Client-generated; a replay returns `409 DUPLICATE`. |

```json
{ "userId": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "orderCode": "DH-2026-0900", "idempotencyKey": "..." }
```

**Success — `201`** — `{ "order": ... }`, `status: "APPROVED"`.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"user not found"}` | No such `USER`. |
| `409` | `{"error":"duplicate activation","code":"DUPLICATE"}` | Replayed `idempotencyKey`. |
| `400` | `{"success":false,"errors":[...]}` | Bad body. |

---
```

- [ ] **Step 2: Commit**

```bash
git add docs/API.md
git commit -m "docs: document POST /api/admin/orders/activate"
```

---

## Task 4: Frontend — widen `DetailHeaderCard`

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/components/ctv-home/DetailHeaderCard.tsx`

- [ ] **Step 1: Add the two optional props**

Change the props interface from:

```ts
interface DetailHeaderCardProps {
  tint: DetailTint
  total: number | string
  totalCaption?: string
  /** Shows a small "Đổi điểm" chip linking to /redeem — used by the points-bearing screens. */
  redeemLink?: boolean
}
```

to:

```ts
interface DetailHeaderCardProps {
  tint: DetailTint
  total: number | string
  totalCaption?: string
  /** Shows a small "Đổi điểm" chip linking to /redeem — used by the points-bearing screens. */
  redeemLink?: boolean
  /** Overrides the "Đổi điểm" chip's destination — used by the admin views, which link to
   *  /admin/redemption instead of the CTV's own self-redeem flow. Kept as a literal union
   *  (not a bare `string`) so TanStack Router's typed `Link` can still validate/type the
   *  route — a widened `string` type would fail typecheck against `<Link to={...}>`. */
  redeemTo?: '/redeem' | '/admin/redemption'
  /** Whose name/phone to show. Defaults to the logged-in user (useAuth()) — the CTV's own
   *  screens never pass this. The admin views pass the *viewed* CTV instead. */
  user?: { fullName: string; phone: string }
}
```

- [ ] **Step 2: Use the new props**

Change the component signature and body. From:

```tsx
export function DetailHeaderCard({ tint, total, totalCaption, redeemLink }: DetailHeaderCardProps) {
  const { user } = useAuth()
  const t = DETAIL_TINT[tint]
```

to:

```tsx
export function DetailHeaderCard({ tint, total, totalCaption, redeemLink, redeemTo, user: userProp }: DetailHeaderCardProps) {
  const { user: authUser } = useAuth()
  const user = userProp ?? authUser
  const t = DETAIL_TINT[tint]
```

And change the redeem link's hardcoded destination from:

```tsx
          <Link
            to="/redeem"
```

to:

```tsx
          <Link
            to={redeemTo ?? '/redeem'}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors. (Every existing CTV call site omits both new props, so `user` still
falls back to `useAuth()` and the redeem link still goes to `/redeem` — unchanged
behavior.)

- [ ] **Step 4: Commit**

```bash
git add src/components/ctv-home/DetailHeaderCard.tsx
git commit -m "feat: let DetailHeaderCard show a specific user and a custom redeem link"
```

---

## Task 5: Frontend — `AdminShell` gets an `onBack` escape hatch

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/components/shell/AdminShell.tsx`

`backTo` only supports a fixed set of literal, param-less routes. The 4 new sub-pages
need to go back to `/admin/users/$id` (dynamic) or, from a `?source=` drill-down, back to
`/admin/users/$id/points` (also dynamic) — trying to thread typed `params` through
`backTo` isn't worth the type-gymnastics. Add a second, independent way to specify the
back button: a plain callback, exactly like `CtvShell`'s existing `onBack` prop.

- [ ] **Step 1: Add the `onBack` prop**

Change the props interface from:

```ts
interface AdminShellProps {
  title: string
  subtitle?: string
  /** Omitted on the admin home, which has nowhere to go back to. */
  backTo?: '/admin/dashboard' | '/admin/users'
  /** Rendered on the right of the header — typically the page's primary "create" button. */
  action?: ReactNode
  children: ReactNode
}
```

to:

```ts
interface AdminShellProps {
  title: string
  subtitle?: string
  /** Omitted on the admin home, which has nowhere to go back to. */
  backTo?: '/admin/dashboard' | '/admin/users'
  /** Alternative to backTo for destinations backTo can't type (dynamic params, conditional
   *  targets) — e.g. `() => navigate({ to: '/admin/users/$id', params: { id } })`. */
  onBack?: () => void
  /** Rendered on the right of the header — typically the page's primary "create" button. */
  action?: ReactNode
  children: ReactNode
}
```

- [ ] **Step 2: Render it**

Change the component signature from:

```tsx
export function AdminShell({ title, subtitle, backTo, action, children }: AdminShellProps) {
```

to:

```tsx
export function AdminShell({ title, subtitle, backTo, onBack, action, children }: AdminShellProps) {
```

And change the back-button block from:

```tsx
          {backTo && (
            <Link
              to={backTo}
              aria-label="Quay lại"
              className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-white/60 bg-white shadow-md shadow-slate-900/10 active:translate-y-px"
            >
              <ChevronLeft className="h-4 w-4 text-slate-600" />
            </Link>
          )}
```

to:

```tsx
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Quay lại"
              className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-white/60 bg-white shadow-md shadow-slate-900/10 active:translate-y-px"
            >
              <ChevronLeft className="h-4 w-4 text-slate-600" />
            </button>
          ) : (
            backTo && (
              <Link
                to={backTo}
                aria-label="Quay lại"
                className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-white/60 bg-white shadow-md shadow-slate-900/10 active:translate-y-px"
              >
                <ChevronLeft className="h-4 w-4 text-slate-600" />
              </Link>
            )
          )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/shell/AdminShell.tsx
git commit -m "feat: add AdminShell onBack for dynamic back destinations"
```

---

## Task 6: Frontend — admin ledger-subtotal and redemption-summary hooks

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/lib/adminLedger.ts`

- [ ] **Step 1: Add the two hooks**

Add to `src/lib/adminLedger.ts`, after `useAdminLedgerCount` (end of file):

```ts
/** Mirrors `useLedgerSubtotal` in `lib/points.ts` — same 100-row best-effort cap. */
export function useAdminLedgerSubtotal(userId: string, wallet: Wallet, type: LedgerType) {
  return useQuery<number, AppError>({
    queryKey: ['admin', 'ledger-subtotal', userId, wallet, type] as const,
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', limit: '100', wallet, type, userId })
      const { entries } = await req<Paginated<AdminLedgerEntry, 'entries'>>(`/api/admin/ledger?${params}`)
      return entries.reduce((sum, e) => sum + e.points, 0)
    },
  })
}

export interface AdminRedemptionSummary {
  grossEarned: number
  lastRedeemedPoints: number
  lastRedeemedAt: string
}

/** Mirrors `useRedemptionSummary` in `lib/points.ts`, scoped to one user by admin. */
export function useAdminRedemptionSummary(userId: string, wallet: Wallet, netBalance: number | undefined) {
  return useQuery<AdminRedemptionSummary | null, AppError>({
    queryKey: ['admin', 'redemption-summary', userId, wallet, netBalance] as const,
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', limit: '100', wallet, type: 'REDEMPTION', userId })
      const { entries } = await req<Paginated<AdminLedgerEntry, 'entries'>>(`/api/admin/ledger?${params}`)
      if (entries.length === 0) return null
      const totalRedeemedAbs = entries.reduce((sum, e) => sum + Math.abs(e.points), 0)
      const last = entries[0]
      return {
        grossEarned: (netBalance ?? 0) + totalRedeemedAbs,
        lastRedeemedPoints: Math.abs(last.points),
        lastRedeemedAt: last.createdAt,
      }
    },
    enabled: netBalance !== undefined,
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/adminLedger.ts
git commit -m "feat: add useAdminLedgerSubtotal and useAdminRedemptionSummary hooks"
```

---

## Task 7: Frontend — rename the overview page and redesign its tiles

**Repo:** `xkld-tools-client`

**Files:**
- Rename: `src/routes/admin/users.$id.tsx` → `src/routes/admin/users.$id.index.tsx`
- Modify: the renamed file

Adding `users.$id.points.tsx` etc. in Task 8-11 would otherwise nest under
`users.$id.tsx` as an unintended layout parent (the exact same bug fixed for
`admin/users.tsx` vs `admin/users.$id.tsx` earlier) — `users.$id.tsx` has no `<Outlet/>`,
so the child routes would silently fail to render. Renaming to the `.index.tsx`
convention first avoids this.

- [ ] **Step 1: Rename the file**

```bash
git mv src/routes/admin/users.\$id.tsx src/routes/admin/users.\$id.index.tsx
```

- [ ] **Step 2: Fix the route id**

In the renamed file, change:

```ts
export const Route = createFileRoute('/admin/users/$id')({
```

to:

```ts
export const Route = createFileRoute('/admin/users/$id/')({
```

(Trailing slash — same `index` convention already used by `admin/users.index.tsx`.)

- [ ] **Step 3: Regenerate the route tree and verify the fix**

Run: `pnpm exec vite build`

Then verify no unintended nesting:

```bash
grep -n "AdminUsersIdIndexRoute = AdminUsersIdIndexRouteImport.update" -A3 src/routeTree.gen.ts
```

Expected: `getParentRoute: () => AdminRoute` (NOT some `AdminUsersId...` route) — i.e. it's
parented directly under `/admin`, a sibling of everything else under `/admin/users`, not
nested under a non-existent layout.

- [ ] **Step 4: Replace the 3 stat tiles with 4 CTV-style tiles**

In the renamed file, add these imports (alongside the existing ones) — `Link` joins the
existing `createFileRoute` import, and the icon/tile imports are new:

```tsx
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { ComponentType } from 'react'
import { ArrowRight, BarChart3, Gift, Handshake, Users } from 'lucide-react'
```

(`useState` was already imported — keep the single import line; don't duplicate it.)

Replace the `StatTile` function (and its one usage below) entirely. From:

```tsx
function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <AdminCard className="px-5 py-4">
      <div className="text-[28px] font-extrabold leading-none text-slate-900">{value}</div>
      <div className="mt-1 text-[12.5px] font-medium text-slate-500">{label}</div>
    </AdminCard>
  )
}
```

to:

```tsx
type Tint = 'blue' | 'amber' | 'green' | 'purple'

// Same tint language as the CTV dashboard's PointTile — kept as a local copy (not imported
// from PointTile.tsx) because that component's `to` prop is typed to the 4 CTV-only routes.
const TINT: Record<Tint, { card: string; icon: string; value: string; label: string; ring: string; arrow: string }> = {
  blue: { card: 'bg-blue-50 border-blue-100', icon: 'from-blue-500 to-blue-700 shadow-blue-600/40', value: 'text-blue-700', label: 'text-blue-950/75', ring: 'shadow-blue-900/10', arrow: 'bg-white text-blue-700' },
  amber: { card: 'bg-amber-50 border-amber-100', icon: 'from-amber-400 to-amber-600 shadow-amber-500/40', value: 'text-amber-600', label: 'text-amber-950/75', ring: 'shadow-amber-900/10', arrow: 'bg-white text-amber-600' },
  green: { card: 'bg-green-50 border-green-100', icon: 'from-green-500 to-green-700 shadow-green-600/40', value: 'text-green-700', label: 'text-green-950/75', ring: 'shadow-green-900/10', arrow: 'bg-white text-green-700' },
  purple: { card: 'bg-purple-50 border-purple-100', icon: 'from-purple-500 to-purple-700 shadow-purple-600/40', value: 'text-purple-700', label: 'text-purple-950/75', ring: 'shadow-purple-900/10', arrow: 'bg-white text-purple-700' },
}

function tileClass(tint: Tint): string {
  return `flex flex-col justify-around gap-3 rounded-[20px] border p-3.5 shadow-lg ${TINT[tint].card} ${TINT[tint].ring} active:translate-y-px`
}

function TileVisual({
  icon: Icon,
  value,
  label,
  tint,
}: {
  icon: ComponentType<{ className?: string }>
  value: number | string
  label: string
  tint: Tint
}) {
  const t = TINT[tint]
  return (
    <>
      <div className="flex items-start justify-between">
        <span className={`flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br ring-4 ring-white ${t.icon} shadow-lg`}>
          <Icon className="h-5 w-5 text-white" />
        </span>
        <span className={`flex h-7 w-7 items-center justify-center rounded-full ${t.arrow} shadow-sm`}>
          <ArrowRight className="h-4 w-4" />
        </span>
      </div>
      <div>
        <div className={`text-[28px] font-extrabold leading-none tracking-tight ${t.value}`}>{value}</div>
        <div className={`mt-1.5 text-[13px] font-semibold leading-tight ${t.label}`}>{label}</div>
      </div>
    </>
  )
}
```

Then, inside the page component, add `referredCustomerCount` alongside the existing
`referredCtvCount`:

```tsx
  const { data: referredCtvCount } = useAdminLedgerCount(id, 'F', 'REFERRAL_SIGNUP_BONUS')
  const { data: referredCustomerCount } = useAdminLedgerCount(id, 'F', 'CUSTOMER_REWARD')
```

And replace the tile grid — from:

```tsx
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Điểm cá nhân (Ví F)" value={balances?.f ?? '—'} />
        <StatTile label="Điểm thưởng (Ví G)" value={balances?.g ?? '—'} />
        <StatTile label="CTV đã giới thiệu" value={referredCtvCount ?? '—'} />
      </div>
```

to:

```tsx
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Link to="/admin/users/$id/points" params={{ id }} className={tileClass('blue')}>
          <TileVisual icon={BarChart3} value={balances?.f ?? '—'} label="Điểm cá nhân" tint="blue" />
        </Link>
        <Link to="/admin/users/$id/rewards" params={{ id }} className={tileClass('amber')}>
          <TileVisual icon={Gift} value={balances?.g ?? '—'} label="Điểm thưởng" tint="amber" />
        </Link>
        <Link to="/admin/users/$id/referred-ctvs" params={{ id }} className={tileClass('green')}>
          <TileVisual icon={Users} value={referredCtvCount ?? '—'} label="CTV đã giới thiệu" tint="green" />
        </Link>
        <Link to="/admin/users/$id/referred-customers" params={{ id }} className={tileClass('purple')}>
          <TileVisual icon={Handshake} value={referredCustomerCount ?? '—'} label="Giới thiệu khách hàng" tint="purple" />
        </Link>
      </div>
```

`AdminCard` stays imported and used elsewhere in the file (header card, tables) — only its
use inside the old `StatTile` is gone.

- [ ] **Step 5: Typecheck**

This will fail until Tasks 8-11 create the 4 target routes — that's expected. Just
confirm the *specific* errors are exactly "route `/admin/users/$id/points` doesn't exist"
(and the 3 siblings), not something else:

Run: `pnpm exec tsc -b --noEmit`
Expected: 4 errors, one per new `Link to=...`, each about an unresolvable route literal.
No other errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/users.\$id.tsx src/routes/admin/users.\$id.index.tsx
git commit -m "feat: redesign admin user-detail tiles to match the CTV dashboard"
```

(`git mv` was already staged in Step 1; this captures both the rename and the edits as one
commit. If Step 1's `git mv` was already committed separately by an earlier partial run,
`git add src/routes/admin/users.\$id.index.tsx` alone is enough.)

---

## Task 8: Frontend — `/admin/users/$id/points`

**Repo:** `xkld-tools-client`

**Files:**
- Create: `src/routes/admin/users.$id.points.tsx`

Near-verbatim copy of `src/routes/_user/points.tsx`, scoped by `userId` and using
`AdminShell`/`onBack` instead of `CtvShell`/`onBack` (CtvShell already has a matching
`onBack` prop — only the shell component and the data hooks change).

- [ ] **Step 1: Create the page**

```tsx
import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { AdminShell } from '@/components/shell/AdminShell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { DetailHeaderCard, DETAIL_TINT } from '@/components/ctv-home/DetailHeaderCard'
import { DetailTableCard } from '@/components/ctv-home/DetailTableCard'
import { useAdminUser, useAdminUserBalances } from '@/lib/adminUsers'
import { useAdminLedger, useAdminLedgerSubtotal, useAdminRedemptionSummary } from '@/lib/adminLedger'
import type { LedgerType } from '@/lib/api'

type Source = 'customer' | 'ctv' | 'referred'

const SOURCE_TYPE: Record<Source, LedgerType> = {
  customer: 'CUSTOMER_REWARD',
  ctv: 'REFERRAL_SIGNUP_BONUS',
  referred: 'CUSTOMER_REFERRAL_BONUS',
}
const SOURCE_LABEL: Record<Source, string> = {
  customer: 'Giới thiệu khách hàng',
  ctv: 'Giới thiệu CTV',
  referred: 'Từ CTV giới thiệu',
}
const SOURCE_KEYS = Object.keys(SOURCE_LABEL) as Source[]
const THEME = DETAIL_TINT.blue

function isSource(value: unknown): value is Source {
  return value === 'customer' || value === 'ctv' || value === 'referred'
}

export const Route = createFileRoute('/admin/users/$id/points')({
  validateSearch: (search: Record<string, unknown>): { source?: Source } => ({
    source: isSource(search.source) ? search.source : undefined,
  }),
  component: AdminUserPointsPage,
})

function SourceDetail({ id, source }: { id: string; source: Source }) {
  const [page, setPage] = useState(1)
  const subtotal = useAdminLedgerSubtotal(id, 'F', SOURCE_TYPE[source])
  const { data } = useAdminLedger(page, { userId: id, wallet: 'F', type: SOURCE_TYPE[source] })

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5">
      <DetailHeaderCard tint="blue" total={subtotal.data === undefined ? '—' : `+${subtotal.data}`} />

      <DetailTableCard>
        <Table>
          <TableHeader>
            <TableRow className={THEME.softBg}>
              <TableHead className={`px-3 font-bold ${THEME.text}`}>Ngày</TableHead>
              <TableHead className={`px-3 font-bold ${THEME.text}`}>Liên quan</TableHead>
              <TableHead className={`px-3 text-right font-bold ${THEME.text}`}>Điểm</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data && data.entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                  Chưa có bản ghi nào.
                </TableCell>
              </TableRow>
            )}
            {data?.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="px-3 text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleDateString('vi-VN')}
                </TableCell>
                <TableCell className="px-3">
                  <div className="text-[13px] font-medium">
                    {entry.orderFullName ?? entry.subjectUserFullName ?? entry.note ?? '—'}
                  </div>
                  {entry.orderCode && (
                    <div className="text-[10.5px] text-muted-foreground">{entry.orderCode}</div>
                  )}
                </TableCell>
                <TableCell className={`px-3 text-right text-[13px] font-bold ${THEME.text}`}>
                  +{entry.points}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailTableCard>

      {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPageChange={setPage} />}
    </div>
  )
}

function AdminUserPointsPage() {
  const { id } = Route.useParams()
  const { source } = Route.useSearch()
  const navigate = useNavigate()
  const { data: user } = useAdminUser(id)
  const { data: balances } = useAdminUserBalances(id)
  const customerTotal = useAdminLedgerSubtotal(id, 'F', 'CUSTOMER_REWARD')
  const ctvTotal = useAdminLedgerSubtotal(id, 'F', 'REFERRAL_SIGNUP_BONUS')
  const referredTotal = useAdminLedgerSubtotal(id, 'F', 'CUSTOMER_REFERRAL_BONUS')
  const redemption = useAdminRedemptionSummary(id, 'F', balances?.f)
  const subtotals: Record<Source, number | undefined> = {
    customer: customerTotal.data,
    ctv: ctvTotal.data,
    referred: referredTotal.data,
  }

  if (source) {
    return (
      <AdminShell
        title={SOURCE_LABEL[source]}
        onBack={() => navigate({ to: '/admin/users/$id/points', params: { id } })}
      >
        <SourceDetail key={source} id={id} source={source} />
      </AdminShell>
    )
  }

  return (
    <AdminShell
      title="Điểm cá nhân"
      subtitle={user?.fullName}
      onBack={() => navigate({ to: '/admin/users/$id', params: { id } })}
    >
      <div className="mx-auto flex max-w-md flex-col gap-5">
        <DetailHeaderCard
          user={user}
          redeemTo="/admin/redemption"
          tint="blue"
          total={balances?.f ?? '—'}
          totalCaption={
            redemption.data
              ? `Đã cộng ${redemption.data.grossEarned} · đã đổi ${redemption.data.lastRedeemedPoints ?? 0}`
              : undefined
          }
        />

        {redemption.data?.lastRedeemedAt && redemption.data?.lastRedeemedPoints !== undefined && (
          <div className="rounded-xl bg-amber-50 px-4 py-2.5 text-center text-xs font-medium text-amber-800">
            🎁 Đã đổi {redemption.data.lastRedeemedPoints} điểm vào{' '}
            {new Date(redemption.data.lastRedeemedAt).toLocaleDateString('vi-VN')}
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {SOURCE_KEYS.map((key) => (
            <Link
              key={key}
              to="/admin/users/$id/points"
              params={{ id }}
              search={{ source: key }}
              className="flex items-center justify-between gap-2 rounded-2xl bg-card px-4 py-3.5 text-left shadow-sm"
            >
              <span className="text-[13.5px] font-bold">{SOURCE_LABEL[key]}</span>
              <span className="flex items-center gap-1.5">
                <span className={`text-[15px] font-extrabold ${THEME.text}`}>
                  {subtotals[key] === undefined ? '—' : `+${subtotals[key]}`}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </AdminShell>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/admin/users.\$id.points.tsx
git commit -m "feat: add admin CTV-parity points sub-page"
```

---

## Task 9: Frontend — `/admin/users/$id/rewards`

**Repo:** `xkld-tools-client`

**Files:**
- Create: `src/routes/admin/users.$id.rewards.tsx`

Near-verbatim copy of `src/routes/_user/rewards.tsx`.

- [ ] **Step 1: Create the page**

```tsx
import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AdminShell } from '@/components/shell/AdminShell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { DetailHeaderCard, DETAIL_TINT } from '@/components/ctv-home/DetailHeaderCard'
import { DetailTableCard } from '@/components/ctv-home/DetailTableCard'
import { useAdminUser, useAdminUserBalances } from '@/lib/adminUsers'
import { useAdminLedger, useAdminRedemptionSummary } from '@/lib/adminLedger'

export const Route = createFileRoute('/admin/users/$id/rewards')({
  component: AdminUserRewardsPage,
})

const THEME = DETAIL_TINT.amber

function AdminUserRewardsPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const { data: user } = useAdminUser(id)
  const { data: balances } = useAdminUserBalances(id)
  const redemption = useAdminRedemptionSummary(id, 'G', balances?.g)
  // G only ever holds MAINTENANCE_ACCRUAL/MAINTENANCE_RESET/REDEMPTION rows — filter out
  // REDEMPTION client-side, same as the CTV's own /rewards page.
  const { data } = useAdminLedger(page, { userId: id, wallet: 'G' })
  const monthlyRows = data?.entries.filter((e) => e.type !== 'REDEMPTION') ?? []

  return (
    <AdminShell
      title="Điểm thưởng"
      subtitle={user?.fullName}
      onBack={() => navigate({ to: '/admin/users/$id', params: { id } })}
    >
      <div className="mx-auto flex max-w-md flex-col gap-5">
        <DetailHeaderCard
          user={user}
          redeemTo="/admin/redemption"
          tint="amber"
          total={balances?.g ?? '—'}
          totalCaption={
            redemption.data
              ? `Đã cộng ${redemption.data.grossEarned} · đã đổi ${redemption.data.lastRedeemedPoints ?? 0}`
              : undefined
          }
        />

        {redemption.data?.lastRedeemedAt && redemption.data?.lastRedeemedPoints !== undefined && (
          <div className="rounded-xl bg-amber-50 px-4 py-2.5 text-center text-xs font-medium text-amber-800">
            🎁 Đã đổi {redemption.data.lastRedeemedPoints} điểm vào{' '}
            {new Date(redemption.data.lastRedeemedAt).toLocaleDateString('vi-VN')}
          </div>
        )}

        <DetailTableCard>
          <Table>
            <TableHeader>
              <TableRow className={THEME.softBg}>
                <TableHead className={`px-3 font-bold ${THEME.text}`}>Ngày</TableHead>
                <TableHead className={`px-3 font-bold ${THEME.text}`}>Tháng</TableHead>
                <TableHead className={`px-3 text-right font-bold ${THEME.text}`}>Điểm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthlyRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    Chưa có bản ghi nào.
                  </TableCell>
                </TableRow>
              )}
              {monthlyRows.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="px-3 text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleDateString('vi-VN')}
                  </TableCell>
                  <TableCell className="px-3 text-[13px] font-medium">
                    {new Date(entry.createdAt).toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' })}
                  </TableCell>
                  <TableCell
                    className={`px-3 text-right text-[13px] font-bold ${entry.points >= 0 ? THEME.text : 'text-destructive'}`}
                  >
                    {entry.points >= 0 ? '+' : ''}
                    {entry.points}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailTableCard>

        {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPageChange={setPage} />}
      </div>
    </AdminShell>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/admin/users.\$id.rewards.tsx
git commit -m "feat: add admin CTV-parity rewards sub-page"
```

---

## Task 10: Frontend — `/admin/users/$id/referred-ctvs`

**Repo:** `xkld-tools-client`

**Files:**
- Create: `src/routes/admin/users.$id.referred-ctvs.tsx`

Near-verbatim copy of `src/routes/_user/referred-ctvs.tsx`.

- [ ] **Step 1: Create the page**

```tsx
import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AdminShell } from '@/components/shell/AdminShell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { DetailHeaderCard, DETAIL_TINT } from '@/components/ctv-home/DetailHeaderCard'
import { DetailTableCard } from '@/components/ctv-home/DetailTableCard'
import { useAdminUser } from '@/lib/adminUsers'
import { useAdminLedger, useAdminLedgerCount } from '@/lib/adminLedger'

export const Route = createFileRoute('/admin/users/$id/referred-ctvs')({
  component: AdminReferredCtvsPage,
})

const THEME = DETAIL_TINT.green

function AdminReferredCtvsPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const { data: user } = useAdminUser(id)
  const { data: count } = useAdminLedgerCount(id, 'F', 'REFERRAL_SIGNUP_BONUS')
  const { data } = useAdminLedger(page, { userId: id, wallet: 'F', type: 'REFERRAL_SIGNUP_BONUS' })

  return (
    <AdminShell
      title="CTV đã giới thiệu"
      subtitle={user?.fullName}
      onBack={() => navigate({ to: '/admin/users/$id', params: { id } })}
    >
      <div className="mx-auto flex max-w-md flex-col gap-5">
        <DetailHeaderCard user={user} tint="green" total={count ?? '—'} />

        <DetailTableCard>
          <Table>
            <TableHeader>
              <TableRow className={THEME.softBg}>
                <TableHead className={`px-3 font-bold ${THEME.text}`}>Ngày</TableHead>
                <TableHead className={`px-3 font-bold ${THEME.text}`}>CTV</TableHead>
                <TableHead className={`px-3 text-right font-bold ${THEME.text}`}>Điểm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data && data.entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    Chưa giới thiệu CTV nào.
                  </TableCell>
                </TableRow>
              )}
              {data?.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="px-3 text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleDateString('vi-VN')}
                  </TableCell>
                  <TableCell className="px-3">
                    <div className="text-[13px] font-medium">{entry.subjectUserFullName ?? '—'}</div>
                    {entry.subjectUserId && (
                      <div className="font-mono text-[10.5px] text-muted-foreground">
                        {entry.subjectUserId.slice(0, 8)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={`px-3 text-right text-[13px] font-bold ${THEME.text}`}>
                    +{entry.points}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailTableCard>

        {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPageChange={setPage} />}
      </div>
    </AdminShell>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/admin/users.\$id.referred-ctvs.tsx
git commit -m "feat: add admin CTV-parity referred-ctvs sub-page"
```

---

## Task 11: Frontend — `/admin/users/$id/referred-customers`

**Repo:** `xkld-tools-client`

**Files:**
- Create: `src/routes/admin/users.$id.referred-customers.tsx`

Near-verbatim copy of `src/routes/_user/referred-customers.tsx` (already stripped of the
"Kích hoạt khách hàng" link on the CTV side — this admin copy never had it).

- [ ] **Step 1: Create the page**

```tsx
import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AdminShell } from '@/components/shell/AdminShell'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { DetailHeaderCard, DETAIL_TINT } from '@/components/ctv-home/DetailHeaderCard'
import { DetailTableCard } from '@/components/ctv-home/DetailTableCard'
import { useAdminUser } from '@/lib/adminUsers'
import { useAdminLedger, useAdminLedgerCount } from '@/lib/adminLedger'

export const Route = createFileRoute('/admin/users/$id/referred-customers')({
  component: AdminReferredCustomersPage,
})

const THEME = DETAIL_TINT.purple

function AdminReferredCustomersPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const { data: user } = useAdminUser(id)
  const { data: count } = useAdminLedgerCount(id, 'F', 'CUSTOMER_REWARD')
  const { data } = useAdminLedger(page, { userId: id, wallet: 'F', type: 'CUSTOMER_REWARD' })

  return (
    <AdminShell
      title="Giới thiệu khách hàng"
      subtitle={user?.fullName}
      onBack={() => navigate({ to: '/admin/users/$id', params: { id } })}
    >
      <div className="mx-auto flex max-w-md flex-col gap-5">
        <DetailHeaderCard user={user} tint="purple" total={count ?? '—'} />

        <DetailTableCard>
          <Table>
            <TableHeader>
              <TableRow className={THEME.softBg}>
                <TableHead className={`px-3 font-bold ${THEME.text}`}>Ngày</TableHead>
                <TableHead className={`px-3 font-bold ${THEME.text}`}>Khách hàng</TableHead>
                <TableHead className={`px-3 text-right font-bold ${THEME.text}`}>Điểm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data && data.entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                    Chưa có khách hàng nào được duyệt.
                  </TableCell>
                </TableRow>
              )}
              {data?.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="px-3 align-top text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleDateString('vi-VN')}
                  </TableCell>
                  <TableCell className="px-3 whitespace-normal">
                    <div className="text-[13px] font-medium">{entry.orderFullName ?? '—'}</div>
                    {entry.orderCode && (
                      <div className="text-[10.5px] text-muted-foreground">{entry.orderCode}</div>
                    )}
                  </TableCell>
                  <TableCell className={`px-3 align-top text-right text-[13px] font-bold ${THEME.text}`}>
                    +{entry.points}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailTableCard>

        {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPageChange={setPage} />}
      </div>
    </AdminShell>
  )
}
```

- [ ] **Step 2: Regenerate the route tree and typecheck everything from Task 7 onward**

Run: `pnpm exec vite build`
Expected: succeeds, `src/routeTree.gen.ts` now has all 4 new sub-routes plus the renamed
index route.

Run: `pnpm build`
Expected: `tsc -b --noEmit` passes with **zero** errors now (the 4 `Link to=...` errors
from Task 7 Step 5 are gone), `vite build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/users.\$id.referred-customers.tsx
git commit -m "feat: add admin CTV-parity referred-customers sub-page"
```

---

## Task 12: Frontend — `useActivateCustomer` hook

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/lib/adminOrders.ts`

- [ ] **Step 1: Add the mutation hook**

Add to `src/lib/adminOrders.ts`, after `useAdminOrderCount` (end of file):

```ts
export interface ActivateCustomerInput {
  userId: string
  fullName: string
  phone: string
  orderCode: string
  idempotencyKey: string
}

/** Admin-direct customer activation (see docs/API.md POST /api/admin/orders/activate).
 *  Invalidates every admin query that could be showing this user's stats. */
export function useActivateCustomer() {
  const queryClient = useQueryClient()
  return useMutation<{ order: Order }, AppError, ActivateCustomerInput>({
    mutationFn: (body) => req<{ order: Order }>('/api/admin/orders/activate', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'ledger'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'ledger-count'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'ledger-subtotal'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'users', 'balances'] })
    },
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/adminOrders.ts
git commit -m "feat: add useActivateCustomer hook"
```

---

## Task 13: Frontend — "Kích hoạt khách hàng" button + modal on `/admin/orders`

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/routes/admin/orders.tsx`

- [ ] **Step 1: Add the modal component and wire it up**

In `src/routes/admin/orders.tsx`, add to the imports:

```tsx
import { UserPicker } from '@/components/admin/UserPicker'
import { AdminModal } from '@/components/shell/AdminModal'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActivateCustomer } from '@/lib/adminOrders'
import { randomId } from '@/lib/randomId'
import type { AuthUser } from '@/lib/api'
```

(`useState`, `useAdminOrders`, `useApproveOrder`, `useRejectOrder`, `useRequestRevision`
stay in the existing `@/lib/adminOrders` import line — just add `useActivateCustomer` to
it rather than a second import line from the same module.)

Add a new component, right after the `RevisionPrompt` function and before `OrderRow`:

```tsx
function ActivateCustomerModal({ onClose }: { onClose: () => void }) {
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null)
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [idempotencyKey] = useState(randomId)
  const activate = useActivateCustomer()

  const canSubmit = Boolean(selectedUser) && fullName.trim().length > 0 && phone.trim().length > 0 && orderCode.trim().length > 0

  const submit = () => {
    if (!selectedUser) return
    activate.mutate(
      { userId: selectedUser.id, fullName: fullName.trim(), phone: phone.trim(), orderCode: orderCode.trim(), idempotencyKey },
      { onSuccess: onClose },
    )
  }

  return (
    <AdminModal
      title="Kích hoạt khách hàng"
      description="Dùng khi khách đã thanh toán trực tiếp cho CTV — điểm được cộng rồi quy đổi ngay, không cần chờ duyệt."
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Hủy
          </Button>
          <Button disabled={!canSubmit || activate.isPending} onClick={submit}>
            {activate.isPending ? 'Đang xử lý…' : 'Kích hoạt'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <Label className="mb-2 block">CTV</Label>
          <UserPicker selected={selectedUser} onSelect={setSelectedUser} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customerName">Tên khách hàng</Label>
          <Input id="customerName" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="customerPhone">SĐT khách hàng</Label>
          <Input id="customerPhone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="orderCode">Đơn hàng</Label>
          <Input id="orderCode" value={orderCode} onChange={(e) => setOrderCode(e.target.value)} />
        </div>

        {activate.isError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{activate.error.message}</p>
        )}
      </div>
    </AdminModal>
  )
}
```

- [ ] **Step 2: Add the button and modal state to the page**

In `AdminOrdersPage`, add state (alongside the existing `useState` calls):

```tsx
  const [showActivate, setShowActivate] = useState(false)
```

Add an `action` prop to the `AdminShell` call — from:

```tsx
    <AdminShell
      title="Đơn hàng"
      subtitle={data ? `${data.total} đơn` : undefined}
      backTo="/admin/dashboard"
    >
```

to:

```tsx
    <AdminShell
      title="Đơn hàng"
      subtitle={data ? `${data.total} đơn` : undefined}
      backTo="/admin/dashboard"
      action={
        <Button className="gap-1.5" onClick={() => setShowActivate(true)}>
          <Plus className="h-4 w-4" />
          Kích hoạt khách hàng
        </Button>
      }
    >
```

`Button` is already imported in this file. `Plus` is not — this file has no existing
`lucide-react` import, so add a new import line for it:

```tsx
import { Plus } from 'lucide-react'
```

Render the modal at the end of the returned JSX, right before the closing `</AdminShell>`:

```tsx
      {showActivate && <ActivateCustomerModal onClose={() => setShowActivate(false)} />}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin/orders.tsx
git commit -m "feat: add customer activation button and modal to admin orders"
```

---

## Task 14: Full verification

**Repos:** both

- [ ] **Step 1: Backend full suite**

Run (in `xkld-tools`): `pnpm test`
Expected: PASS, all files.

- [ ] **Step 2: Frontend full build**

Run (in `xkld-tools-client`): `pnpm build`
Expected: `tsc -b --noEmit` passes, `vite build` succeeds.

- [ ] **Step 3: Manual browser verification**

Start both dev servers (`pnpm dev` in each repo). Log in as the super admin. On
`/admin/users`, click into a CTV with existing history (e.g. a seeded DEMO account).
Confirm:
- 4 tiles render in the CTV's visual style (icon badge, arrow, big number) and each
  navigates to its own sub-page.
- `/admin/users/:id/points` shows the F balance, the 3-source breakdown list, and each
  source drills into its own filtered table; the "Đổi điểm" chip goes to
  `/admin/redemption`.
- `/admin/users/:id/rewards` shows the G balance and monthly accrual/reset rows.
- `/admin/users/:id/referred-ctvs` and `/admin/users/:id/referred-customers` show their
  flat filtered lists.
- Every sub-page's back button returns to `/admin/users/:id` (or, from a `/points`
  source-detail view, back to `/admin/users/:id/points`).
- On `/admin/orders`, click **Kích hoạt khách hàng**, pick a CTV, fill the 3 fields,
  submit. Confirm: a `201`, the modal closes, a new `APPROVED` order appears in the list
  for that CTV with today's date, and (checking the CTV's own login, or the ledger/
  notifications tables directly) their F balance is unchanged net while they received
  exactly one "Khách hàng đã được kích hoạt" notification.

- [ ] **Step 4: Report results**

If anything doesn't match, note exactly what's wrong for a follow-up fix. If everything
matches, this task (and the plan) is done.
