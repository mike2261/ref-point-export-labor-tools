# Admin: user detail page — design

**Date:** 2026-08-01
**Repos:** `xkld-tools` (backend, 1 new endpoint) + `xkld-tools-client` (new page + hooks)
**Scope:** Clicking a row in the admin "Người dùng" table (`admin/users.tsx`) opens
`/admin/users/:id`, a read-only page showing the same information a CTV sees about
themselves: point balances, point history, number of CTVs referred, and order history.

## Why

The admin users list (`GET /api/admin/users`) only shows `fullName, phone, role,
isActive, createdAt`. To see anything else about a specific user — their balances, point
history, who they referred, their orders — an admin currently has to cross-reference
`/admin/ledger` and `/admin/orders` by hand (both support `?userId=` but the users list
has no link into either). This adds the missing detail view.

## Non-goals

- No admin actions on this page (reset password, lock/unlock, approve/reject orders).
  Those stay exactly where they are today (`admin/users.tsx` row actions,
  `admin/orders.tsx` for order decisions).
- No new filter UI on the point-history/order tables on this page — they're pre-scoped
  to one user via `userId`; a user can still go to `/admin/ledger` or `/admin/orders` for
  cross-user filtering.
- No referrer name / referral network display — not part of what was asked for (balances,
  history, referred-CTV count, order count).

## Backend — 1 new endpoint

`GET /api/admin/users/:id` in `src/routes/admin.ts`, mounted alongside the existing
`GET /api/admin/users/:id/balances` (same `requireSuperAdmin` guard).

- Reuses `findById()` + `toAuthUser()` from `src/lib/users.ts` — no new query logic.
- **Response `200`:** `{ "user": User }` (same `User` shape as the list endpoint).
- **Response `404`:** `{ "error": "not_found" }` if no user with that id — same shape as
  the balances endpoint's 404.
- `docs/API.md`: add this under §6.4, next to the balances entry.

Everything else the page needs already exists and already accepts `userId`:
`GET /api/admin/users/:id/balances`, `GET /api/admin/ledger?userId=`,
`GET /api/admin/orders?userId=`.

## Frontend

### New route: `src/routes/admin/users.$id.tsx`

`AdminShell` with `backTo="/admin/users"`, laid out top to bottom:

1. **Header** — name, phone, role badge, active/locked badge, ngày tham gia. From
   `useAdminUser(id)`.
2. **3 stat tiles** — Ví F, Ví G (from `useAdminUserBalances(id)`), and "CTV đã giới
   thiệu" (from `useAdminLedgerCount(id, 'F', 'REFERRAL_SIGNUP_BONUS')`). The CTV count
   uses the exact same ledger-type-count trick the client app uses on the CTV's own
   dashboard (`useLedgerCount` in `xkld-tools-client/src/lib/points.ts`), so the number
   always matches what the CTV would see logging in themselves.
3. **"Lịch sử điểm" table** — same columns as `admin/ledger.tsx` minus the "Người dùng"
   column (redundant — the whole table is one user), paginated, via
   `useAdminLedger(page, { userId })` (hook already supports `userId`, unused until now).
4. **"Đơn hàng" table** — same columns as `admin/orders.tsx` minus the "CTV" column
   (same reason) and minus the action column (page is read-only — no approve/reject
   here), paginated, via `useAdminOrders(page, undefined, undefined, userId)`.

### New/changed hooks

- `useAdminUser(id)` — `lib/adminUsers.ts` — `GET /api/admin/users/:id`.
- `useAdminUserBalances(id)` — `lib/adminUsers.ts` — `GET /api/admin/users/:id/balances`
  (existing endpoint, first client hook for it).
- `useAdminLedgerCount(userId, wallet, type)` — `lib/adminLedger.ts` — mirrors
  `useLedgerCount` from `lib/points.ts`: `GET /api/admin/ledger?userId=&wallet=&type=&limit=1`
  → reads `.total`.
- `useAdminOrders` — `lib/adminOrders.ts` — add an optional trailing `userId` param,
  forwarded as `?userId=` (backend already accepts it).

### Changed: `src/routes/admin/users.tsx`

Each `TableRow` becomes clickable (`Link` to `/admin/users/$id`, or an `onClick` navigate)
— rows are currently static. The existing reset-password action button stays as-is and
must keep working without triggering the row navigation (e.g. `stopPropagation` or keep
it a `Link`-wrapped row with the button excluded from the link area).

## Testing

- Backend: TDD per repo convention (`test/admin-users.test.ts` — extend). New cases:
  `GET /api/admin/users/:id` returns the user; `404` for unknown id; `401`/`403` for
  non-admin.
- Frontend: no existing test suite pattern to extend against found during research —
  match whatever convention `admin/orders.tsx`/`admin/ledger.tsx` use today (manual
  verification via dev server if no component tests exist for sibling admin pages).

## Out of scope

- Bulk/aggregate admin dashboards (e.g., "top CTVs by referrals") — this is a per-user
  drill-down only.
- Editing user fields (name, phone) from this page.
- Referred-customer count / referred-CTV list (only the *count* was asked for).
