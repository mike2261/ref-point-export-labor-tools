# Admin User Detail Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a row in the admin "Người dùng" table opens `/admin/users/:id`, a
read-only page showing that user's point balances, point history, number of CTVs they
referred, and their order history — the same information visible from the client side.

**Architecture:** One new backend endpoint (`GET /api/admin/users/:id`) plus three new/extended
client hooks that all funnel into one new TanStack Router page. Every other data source
(`balances`, `ledger`, `orders`) already exists and already accepts `userId` — no other
backend change is needed.

**Tech Stack:** Hono + D1 (`xkld-tools`, backend), React + TanStack Router + TanStack Query +
Tailwind (`xkld-tools-client`, frontend). Backend tests: Vitest with
`@cloudflare/vitest-pool-workers`. Frontend: no test framework exists in this repo — verification
is `tsc -b --noEmit` (via `pnpm build`) plus a manual dev-server check.

**Spec:** `docs/superpowers/specs/2026-08-01-admin-user-detail-design.md`

---

## Task 1: Backend — `GET /api/admin/users/:id`

**Repo:** `xkld-tools`

**Files:**
- Modify: `test/admin-users.test.ts`
- Modify: `src/routes/admin.ts:73-77` (right after the existing `GET /users` list route)

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to the end of `test/admin-users.test.ts` (after the existing
`describe('GET /api/admin/users', ...)` block, i.e. after line 80):

```ts
describe('GET /api/admin/users/:id', () => {
  it('returns the user', async () => {
    const admin = await seedAdmin()
    const alice = await registerUser(admin.referralCode, '0912345678', 'Alice')

    const res = await get(`/api/admin/users/${alice.id}`, admin.token)
    expect(res.status).toBe(200)
    const { user } = await res.json<{ user: UserRow }>()
    expect(user.id).toBe(alice.id)
    expect(user.fullName).toBe('Alice')
    expect(user.phone).toBe('0912345678')
  })

  it('returns 404 for an unknown id', async () => {
    const admin = await seedAdmin()
    const res = await get('/api/admin/users/does-not-exist', admin.token)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'user not found' })
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    expect((await get(`/api/admin/users/${user.id}`)).status).toBe(401)
    expect((await get(`/api/admin/users/${user.id}`, user.token)).status).toBe(403)
  })
})
```

The `UserRow` interface already declared at the top of this file (id/fullName/phone) covers
what we read here — no new type needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run test/admin-users.test.ts`
Expected: the new `GET /api/admin/users/:id` describe block FAILs — `returns the user`
fails on `expect(res.status).toBe(200)` (route doesn't exist yet, so Hono's catch-all
returns 404), and `returns 404 for an unknown id` fails on the body-equality assertion
(Hono's default 404 body isn't `{"error":"user not found"}`). The pre-existing
`GET /api/admin/users` block still passes.

- [ ] **Step 3: Implement the route**

In `src/routes/admin.ts`, insert this route immediately after the existing `GET /users`
handler (after line 77, before the `POST /users/:id/reset-password` handler at line 80).
`findById` and `toAuthUser` are already imported at the top of this file (line 4-13), so no
import changes are needed.

```ts
// Single user lookup — backs the admin user-detail page's header (name/phone/role/status).
adminRoutes.get('/users/:id', async (c) => {
  const row = await findById(c.env.DB, c.req.param('id'))
  if (!row) return c.json({ error: 'user not found' }, 404)
  return c.json({ user: toAuthUser(row) })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run test/admin-users.test.ts`
Expected: PASS, all tests in the file green (both `describe` blocks).

- [ ] **Step 5: Run the full backend test suite**

Run: `pnpm test`
Expected: PASS, no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add test/admin-users.test.ts src/routes/admin.ts
git commit -m "feat: add GET /api/admin/users/:id for the admin user detail page"
```

---

## Task 2: Backend — document the new endpoint

**Repo:** `xkld-tools`

**Files:**
- Modify: `docs/API.md:699-701` (between the `GET /api/admin/users` and
  `GET /api/admin/orders` sections)

- [ ] **Step 1: Add the doc section**

In `docs/API.md`, insert this new subsection immediately after the `GET /api/admin/users`
section's closing `---` (currently line 701) and before `#### GET /api/admin/orders`
(currently line 703):

```markdown
#### `GET /api/admin/users/:id`

A single user's identity fields (no balances — use `GET /api/admin/users/:id/balances`
for those).

**Success — `200`**

```json
{ "user": { "id": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "role": "USER", "referrerId": "a1d2...", "referralCode": "0912345678", "isActive": true, "createdAt": "2026-07-10T02:15:30.000Z" } }
```

**Errors:** `404 {"error":"user not found"}`.

---

```

- [ ] **Step 2: Commit**

```bash
git add docs/API.md
git commit -m "docs: document GET /api/admin/users/:id"
```

---

## Task 3: Frontend — `useAdminUser` and `useAdminUserBalances` hooks

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/lib/adminUsers.ts`

- [ ] **Step 1: Add the two hooks**

In `src/lib/adminUsers.ts`, change the top import line from:

```ts
import { req, type AuthUser, type Paginated } from './api'
```

to:

```ts
import { req, type AuthUser, type Balances, type Paginated } from './api'
```

Then add these two functions, placed after `useAdminUsers` (after its closing `}` around
line 17) and before the `useUserNameMap` comment block:

```ts
export function useAdminUser(id: string) {
  return useQuery<{ user: AuthUser }, AppError, AuthUser>({
    queryKey: ['admin', 'users', 'detail', id] as const,
    queryFn: () => req<{ user: AuthUser }>(`/api/admin/users/${id}`),
    select: (data) => data.user,
  })
}

export function useAdminUserBalances(id: string) {
  return useQuery<Balances, AppError>({
    queryKey: ['admin', 'users', 'balances', id] as const,
    queryFn: () => req<Balances>(`/api/admin/users/${id}/balances`),
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/adminUsers.ts
git commit -m "feat: add useAdminUser and useAdminUserBalances hooks"
```

---

## Task 4: Frontend — `useAdminLedgerCount` hook

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/lib/adminLedger.ts`

- [ ] **Step 1: Add the hook**

In `src/lib/adminLedger.ts`, change the top import line from:

```ts
import { req, type AdminLedgerEntry, type Paginated } from './api'
```

to:

```ts
import { req, type AdminLedgerEntry, type LedgerType, type Paginated, type Wallet } from './api'
```

Then add this function after `useAdminLedger` (after its closing `}`):

```ts
/** Mirrors `useLedgerCount` in `lib/points.ts` (the CTV's own view of this same number),
 * so an admin sees exactly what the CTV would see logging in themselves. */
export function useAdminLedgerCount(userId: string, wallet: Wallet, type: LedgerType) {
  return useQuery<number, AppError>({
    queryKey: ['admin', 'ledger-count', userId, wallet, type] as const,
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', limit: '1', wallet, type, userId })
      const { total } = await req<Paginated<AdminLedgerEntry, 'entries'>>(`/api/admin/ledger?${params}`)
      return total
    },
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/adminLedger.ts
git commit -m "feat: add useAdminLedgerCount hook"
```

---

## Task 5: Frontend — extend `useAdminOrders` with an optional `userId`

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/lib/adminOrders.ts:5-14`

- [ ] **Step 1: Change the signature**

Replace the current `useAdminOrders` function (lines 5-14):

```ts
export function useAdminOrders(page: number, status?: OrderStatus, q?: string) {
  return useQuery<Paginated<Order, 'orders'>, AppError>({
    queryKey: ['admin', 'orders', page, status, q] as const,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page) })
      if (status) params.set('status', status)
      if (q) params.set('q', q)
      return req<Paginated<Order, 'orders'>>(`/api/admin/orders?${params}`)
    },
  })
}
```

with:

```ts
export function useAdminOrders(page: number, status?: OrderStatus, q?: string, userId?: string) {
  return useQuery<Paginated<Order, 'orders'>, AppError>({
    queryKey: ['admin', 'orders', page, status, q, userId] as const,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page) })
      if (status) params.set('status', status)
      if (q) params.set('q', q)
      if (userId) params.set('userId', userId)
      return req<Paginated<Order, 'orders'>>(`/api/admin/orders?${params}`)
    },
  })
}
```

This is backward-compatible — every existing caller (`admin/orders.tsx`,
`admin/dashboard.tsx`) omits the 4th argument, so `userId` stays `undefined` for them and
their query keys/behavior are unchanged.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/adminOrders.ts
git commit -m "feat: add optional userId filter to useAdminOrders"
```

---

## Task 6: Frontend — widen `AdminShell`'s `backTo` type

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/components/shell/AdminShell.tsx:12`

- [ ] **Step 1: Widen the type**

The new detail page needs to link back to `/admin/users`, but `backTo` currently only
accepts the single literal `'/admin/dashboard'`. Change line 12 from:

```ts
  backTo?: '/admin/dashboard'
```

to:

```ts
  backTo?: '/admin/dashboard' | '/admin/users'
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/shell/AdminShell.tsx
git commit -m "feat: allow AdminShell backTo to target /admin/users"
```

---

## Task 7: Frontend — the new `/admin/users/$id` page

**Repo:** `xkld-tools-client`

**Files:**
- Create: `src/routes/admin/users.$id.tsx`

This is the first dynamic (`$param`) route file in this codebase — `admin/users.$id.tsx`
is TanStack Router's file-naming convention for a `/admin/users/:id` route with a
`Route.useParams()` returning `{ id: string }`, consistent with how the file-based router
plugin already names every other route in `src/routeTree.gen.ts`.

- [ ] **Step 1: Create the page**

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AdminShell, AdminCard } from '@/components/shell/AdminShell'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { useAdminUser, useAdminUserBalances } from '@/lib/adminUsers'
import { useAdminLedger, useAdminLedgerCount } from '@/lib/adminLedger'
import { useAdminOrders } from '@/lib/adminOrders'
import { LEDGER_TYPE_LABELS, WALLET_LABELS } from '@/lib/points'
import { STATUS_LABEL, STATUS_VARIANT } from '@/lib/orders'

export const Route = createFileRoute('/admin/users/$id')({
  component: AdminUserDetailPage,
})

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <AdminCard className="px-5 py-4">
      <div className="text-[28px] font-extrabold leading-none text-slate-900">{value}</div>
      <div className="mt-1 text-[12.5px] font-medium text-slate-500">{label}</div>
    </AdminCard>
  )
}

function AdminUserDetailPage() {
  const { id } = Route.useParams()
  const [ledgerPage, setLedgerPage] = useState(1)
  const [ordersPage, setOrdersPage] = useState(1)

  const { data: user } = useAdminUser(id)
  const { data: balances } = useAdminUserBalances(id)
  const { data: referredCtvCount } = useAdminLedgerCount(id, 'F', 'REFERRAL_SIGNUP_BONUS')
  const { data: ledger } = useAdminLedger(ledgerPage, { userId: id })
  const { data: orders } = useAdminOrders(ordersPage, undefined, undefined, id)

  return (
    <AdminShell title={user?.fullName ?? 'Chi tiết người dùng'} subtitle={user?.phone} backTo="/admin/users">
      <AdminCard className="mb-6 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-extrabold text-slate-900">{user?.fullName ?? '—'}</div>
            <div className="font-mono text-sm text-slate-500">{user?.phone ?? '—'}</div>
          </div>
          {user && (
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  user.role === 'SUPER_ADMIN' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {user.role === 'SUPER_ADMIN' ? 'Super Admin' : 'CTV'}
              </span>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  user.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                }`}
              >
                {user.isActive ? 'Hoạt động' : 'Vô hiệu hoá'}
              </span>
            </div>
          )}
        </div>
        {user && (
          <div className="mt-3 text-[12.5px] text-slate-500">
            Tham gia {new Date(user.createdAt).toLocaleDateString('vi-VN')}
          </div>
        )}
      </AdminCard>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Điểm cá nhân (Ví F)" value={balances?.f ?? '—'} />
        <StatTile label="Điểm thưởng (Ví G)" value={balances?.g ?? '—'} />
        <StatTile label="CTV đã giới thiệu" value={referredCtvCount ?? '—'} />
      </div>

      <div className="mb-3 text-[15px] font-bold text-slate-900">Lịch sử điểm</div>
      <AdminCard className="mb-3">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="px-5 font-bold text-slate-600">Ngày</TableHead>
              <TableHead className="font-bold text-slate-600">Loại điểm</TableHead>
              <TableHead className="font-bold text-slate-600">Loại</TableHead>
              <TableHead className="text-right font-bold text-slate-600">Điểm</TableHead>
              <TableHead className="px-5 font-bold text-slate-600">Liên quan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger && ledger.entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-slate-500">
                  Chưa có giao dịch điểm nào.
                </TableCell>
              </TableRow>
            )}
            {ledger?.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="px-5 text-slate-500">
                  {new Date(entry.createdAt).toLocaleDateString('vi-VN')}
                </TableCell>
                <TableCell className="whitespace-nowrap">{WALLET_LABELS[entry.wallet]}</TableCell>
                <TableCell>{LEDGER_TYPE_LABELS[entry.type]}</TableCell>
                <TableCell
                  className={`text-right font-bold ${entry.points >= 0 ? 'text-blue-700' : 'text-red-600'}`}
                >
                  {entry.points >= 0 ? '+' : ''}
                  {entry.points}
                </TableCell>
                <TableCell className="px-5 whitespace-normal">
                  {entry.orderCode ? (
                    <>
                      <div>{entry.orderFullName}</div>
                      <div className="text-xs text-slate-500">{entry.orderCode}</div>
                    </>
                  ) : entry.subjectUserFullName ? (
                    <div className="text-xs text-slate-500">
                      Người được giới thiệu: {entry.subjectUserFullName}
                    </div>
                  ) : (
                    (entry.note ?? '—')
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AdminCard>
      {ledger && (
        <div className="mb-6">
          <Pagination page={ledger.page} limit={ledger.limit} total={ledger.total} onPageChange={setLedgerPage} />
        </div>
      )}

      <div className="mb-3 text-[15px] font-bold text-slate-900">Đơn hàng</div>
      <AdminCard>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="px-5 font-bold text-slate-600">Ngày tạo</TableHead>
              <TableHead className="font-bold text-slate-600">Người đi XKLĐ</TableHead>
              <TableHead className="font-bold text-slate-600">Mã đơn / kích hoạt</TableHead>
              <TableHead className="px-5 font-bold text-slate-600">Trạng thái</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders && orders.orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-slate-500">
                  Chưa có đơn hàng nào.
                </TableCell>
              </TableRow>
            )}
            {orders?.orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="px-5 text-slate-500">
                  {new Date(order.createdAt).toLocaleDateString('vi-VN')}
                </TableCell>
                <TableCell>
                  <div>{order.fullName}</div>
                  <div className="text-xs text-slate-500">{order.phone}</div>
                </TableCell>
                <TableCell>
                  <div>{order.orderCode}</div>
                  <div className="text-xs text-slate-500">{order.activationCode}</div>
                </TableCell>
                <TableCell className="px-5">
                  <Badge variant={STATUS_VARIANT[order.status]}>{STATUS_LABEL[order.status]}</Badge>
                  {order.status === 'NEEDS_REVISION' && order.revisionReason && (
                    <div className="mt-1 max-w-48 text-xs text-slate-500">{order.revisionReason}</div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AdminCard>
      {orders && (
        <div className="mt-3">
          <Pagination page={orders.page} limit={orders.limit} total={orders.total} onPageChange={setOrdersPage} />
        </div>
      )}
    </AdminShell>
  )
}
```

- [ ] **Step 2: Regenerate the route tree**

`src/routeTree.gen.ts` is auto-generated by the `@tanstack/router-plugin` Vite plugin and
is gitignored — it must be regenerated locally before typechecking will see the new route.
`pnpm build` runs `tsc -b --noEmit` *before* `vite build`, so running it directly now would
fail on a stale route tree. Regenerate first with a plain Vite build:

Run: `pnpm exec vite build`
Expected: succeeds (ignore the `dist/` output — it's gitignored and unused here). This
regenerates `src/routeTree.gen.ts` to include a `AdminUsersIdRouteImport`-style entry for
`/admin/users/$id`.

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: `tsc -b --noEmit` passes with no errors, `vite build` succeeds.

- [ ] **Step 4: Commit**

`src/routeTree.gen.ts` is gitignored, so only the new page is added:

```bash
git add src/routes/admin/users.\$id.tsx
git commit -m "feat: add admin user detail page"
```

---

## Task 8: Frontend — make user rows clickable

**Repo:** `xkld-tools-client`

**Files:**
- Modify: `src/routes/admin/users.tsx`

- [ ] **Step 1: Add navigation to each row**

In `src/routes/admin/users.tsx`, add `useNavigate` to the `@tanstack/react-router` import
(line 1) — change:

```ts
import { createFileRoute } from '@tanstack/react-router'
```

to:

```ts
import { createFileRoute, useNavigate } from '@tanstack/react-router'
```

Then in the `UserRow` component (starting at line 109), add a `navigate` call and wire up
the row's `onClick`, while stopping the reset-password cell from also triggering it. Replace:

```tsx
function UserRow({ u }: { u: AuthUser }) {
  const resetPassword = useResetPassword()

  return (
    <>
      <TableRow>
```

with:

```tsx
function UserRow({ u }: { u: AuthUser }) {
  const navigate = useNavigate()
  const resetPassword = useResetPassword()

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={() => navigate({ to: '/admin/users/$id', params: { id: u.id } })}
      >
```

And change the action `<TableCell>` (currently `<TableCell className="px-5">` right before
the reset-password `Button`, around line 138) to stop the click from bubbling up to the row:

```tsx
        <TableCell className="px-5" onClick={(e) => e.stopPropagation()}>
```

- [ ] **Step 2: Regenerate the route tree and typecheck**

Run: `pnpm exec vite build`
Expected: succeeds (no new routes here, but keeps the tree fresh for the next step).

Run: `pnpm build`
Expected: `tsc -b --noEmit` passes — this confirms `{ to: '/admin/users/$id', params: { id: u.id } }`
type-checks against the route added in Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/users.tsx
git commit -m "feat: make admin user rows clickable to open the detail page"
```

---

## Task 9: Manual verification in the browser

**Repos:** both

- [ ] **Step 1: Start the backend**

Run (in `xkld-tools`, background/separate terminal): `pnpm dev`
Expected: Wrangler dev server starts on `http://localhost:8787`.

- [ ] **Step 2: Start the frontend**

Run (in `xkld-tools-client`, background/separate terminal): `pnpm dev`
Expected: Vite dev server starts (default `http://localhost:5173`).

- [ ] **Step 3: Click through the feature**

In a browser, log in as the super admin, go to **Người dùng**, and click a CTV row with
some order/point history (e.g. a DEMO account per `docs/DEMO-ACCOUNTS.md` if seeded
locally, or any real user with activity). Confirm:
- URL changes to `/admin/users/<id>` and the back button returns to `/admin/users`.
- Header shows the correct name/phone/role/status.
- The 3 stat tiles show F balance, G balance, and referred-CTV count matching what
  `/admin/ledger?userId=<id>` and `/admin/users/<id>/balances` return.
- "Lịch sử điểm" table lists only this user's ledger entries, paginated.
- "Đơn hàng" table lists only this user's orders, paginated, with no approve/reject buttons.
- Clicking the "Reset mật khẩu" button on the list page still works and does **not**
  navigate to the detail page.

- [ ] **Step 4: Report results**

If anything doesn't match, note exactly what's wrong (which section, expected vs. actual)
for the next task iteration. If everything matches, this task is done — no commit (nothing
changes here beyond what Tasks 1-8 already committed).
