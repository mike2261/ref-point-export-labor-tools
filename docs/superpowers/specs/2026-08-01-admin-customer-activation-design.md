# Admin user-detail CTV-parity tiles + direct customer activation — design

**Date:** 2026-08-01
**Repos:** `xkld-tools` (backend, 1 new endpoint) + `xkld-tools-client` (4 new sub-pages,
1 new admin form, tile redesign)
**Builds on:** `docs/superpowers/specs/2026-08-01-admin-user-detail-design.md` (the admin
user-detail page this extends)

**Scope:** Two related changes:

1. Replace the 3 plain stat tiles on `/admin/users/:id` with 4 tiles visually and
   behaviorally identical to the CTV's own dashboard tiles — each navigates to a
   dedicated sub-page that mirrors the corresponding CTV page.
2. A new admin-only flow, "Kích hoạt khách hàng" (customer activation): admin creates an
   already-approved order on behalf of a CTV, for a customer who already paid the CTV in
   cash outside the system. The CTV's own earned points from this specific order are
   credited then immediately redeemed (net zero), and the CTV gets one clear notification
   instead of the two that a plain approve+redeem would produce.

## Why

- The admin user-detail page's 3 tiles (F, G, referred-CTV count) don't match the CTV's
  own 4-tile dashboard (which also has a "Giới thiệu khách hàng" tile), and clicking them
  did nothing beyond the always-visible full tables below. The CTV-side app already has
  well-built dedicated pages for each of these four numbers (`/points`, `/rewards`,
  `/referred-ctvs`, `/referred-customers`) — reusing that exact UX for admin (scoped to
  the viewed user) is more consistent than maintaining a second, different admin-only
  layout.
- The CTV app used to have a "Kích hoạt khách hàng" link on `/referred-customers` that
  sent the CTV to `/orders` to submit an order themselves. That link was removed
  (commit `3d08cfd`, already done by the user) because going forward, activation is
  something the admin does directly — the customer already paid the CTV in person, so
  there's no PENDING-approval step to wait on; the admin creates the record already
  approved and it's immediately netted to zero in the CTV's F wallet (since the cash
  was never routed through the redemption/payout process).

## Non-goals

- No changes to the *normal* order lifecycle (DRAFT → PENDING → APPROVED/REJECTED) or to
  `approveOrder()` / `redeem()` — both are left exactly as they are; this adds a new,
  separate code path.
- No new `NotificationType` — the consolidated notification reuses the existing
  `REDEMPTION` type with custom copy, so no DB migration or client-side
  icon/label-mapping change is needed.
- No schema migration — `orders.activation_code` stays `NOT NULL`; this flow just sets it
  equal to `orderCode` under the hood (the field isn't asked for in the admin form).
- No admin ability to edit/reject a directly-activated order differently from a normal
  approved order — once created it behaves like any other `APPROVED` order.

## Part 1 — CTV-parity tiles on `/admin/users/:id`

### Tiles

Replace the current `StatTile` grid with 4 `PointTile`-style cards (reusing the exact
visual design from `xkld-tools-client/src/components/ctv-home/PointTile.tsx` — icon,
gradient badge, arrow, tint), each a `Link` instead of a plain div:

| Tile | Icon | Tint | Value | Links to |
| --- | --- | --- | --- | --- |
| Điểm cá nhân | `BarChart3` | blue | `balances.f` | `/admin/users/$id/points` |
| Điểm thưởng | `Gift` | amber | `balances.g` | `/admin/users/$id/rewards` |
| CTV đã giới thiệu | `Users` | green | `referredCtvCount` | `/admin/users/$id/referred-ctvs` |
| Giới thiệu khách hàng | `Handshake` | purple | `referredCustomerCount` | `/admin/users/$id/referred-customers` |

`referredCustomerCount` is new: `useAdminLedgerCount(id, 'F', 'CUSTOMER_REWARD')` (the
hook built for the user-detail page already generalizes to any type — this is just
another call with `CUSTOMER_REWARD` instead of `REFERRAL_SIGNUP_BONUS`).

Since `PointTile`'s `to` prop is typed to the 4 CTV routes only, the admin sub-pages need
their own tile variant (a copy with a widened `to` type, or a small wrapper) — see
Implementation below.

The header card (name/phone/role/status/joined-date) and the two full tables ("Lịch sử
điểm", "Đơn hàng") already on `/admin/users/:id` are unchanged — those stay as the
one-page overview; the 4 tiles are what now drill down into per-category CTV-style views,
same relationship the CTV's own dashboard has to `/points` etc.

### The 4 new sub-pages

Each is a near-verbatim copy of its CTV counterpart, swapping self-scoped hooks for
admin/`userId`-scoped ones, and dropping the self-service "redeem" shortcut (admin
already has a dedicated redemption screen):

**`DetailHeaderCard` needs widening first** (`components/ctv-home/DetailHeaderCard.tsx`):
today it hardcodes `useAuth()`'s own `user.fullName`/`user.phone` and a hardcoded
`to="/redeem"` link — both wrong for an admin viewing someone else. Add two optional
props, both defaulting to today's behavior so every existing CTV call site is untouched:
- `user?: { fullName: string; phone: string }` — falls back to `useAuth()` when omitted.
- `redeemTo?: string` — falls back to `'/redeem'` when omitted.

The 4 admin sub-pages below pass `user={user}` (from `useAdminUser(id)`) and
`redeemTo="/admin/redemption"`.

- **`/admin/users/$id/points`** — copy of `_user/points.tsx`. Same 3-source breakdown
  (`?source=customer|ctv|referred`), same `DetailHeaderCard` + `DetailTableCard` +
  paginated table. `useBalances`/`useMyLedger`/`useLedgerSubtotal` → admin equivalents
  scoped by `id`.
- **`/admin/users/$id/rewards`** — copy of `_user/rewards.tsx`. Same G-wallet monthly
  list (`MAINTENANCE_ACCRUAL`/`MAINTENANCE_RESET`, `REDEMPTION` rows filtered out
  client-side, same as today), same redemption-summary caption.
- **`/admin/users/$id/referred-ctvs`** — copy of `_user/referred-ctvs.tsx`. Flat list of
  `REFERRAL_SIGNUP_BONUS` entries.
- **`/admin/users/$id/referred-customers`** — copy of `_user/referred-customers.tsx`.
  Flat list of `CUSTOMER_REWARD` entries. (No "Kích hoạt khách hàng" link here either —
  that's gone from both the CTV and admin sides now; see Part 2 for where it lives.)

Each page's `onBack` goes to `/admin/users/$id` (the overview), not `/admin/users`.

### New hooks needed (`xkld-tools-client/src/lib/adminLedger.ts`, `adminUsers.ts`)

- `useAdminLedgerSubtotal(userId, wallet, type)` — mirrors `useLedgerSubtotal` in
  `lib/points.ts` (sums up to 100 entries client-side, same documented cap).
- `useAdminRedemptionSummary(userId, wallet, netBalance)` — mirrors
  `useRedemptionSummary` in `lib/points.ts`.

`useAdminLedger` and `useAdminLedgerCount` already exist and already take `userId` —
reused as-is.

## Part 2 — Admin "Kích hoạt khách hàng"

### Entry point

A "+ Kích hoạt khách hàng" button on `/admin/orders` (same placement pattern as
`admin/users.tsx`'s "+ Tạo tài khoản"), opening a modal (reusing `AdminModal`, same as
`RedeemModal` in `admin/redemption.tsx`).

**Form fields:**

| Field | Widget | Notes |
| --- | --- | --- |
| CTV | `UserPicker` (reused from `admin/redemption.tsx`) | Resolves to `userId`. |
| Tên khách hàng | text input | → `fullName` |
| SĐT khách hàng | text input | → `phone` |
| Đơn hàng | text input | → `orderCode` (also stored as `activationCode`, not shown) |

Client generates a `idempotencyKey` per modal instance (`useState(randomId)`, same
pattern as `RedeemModal`), guarding double-submit.

### Backend — `POST /api/admin/orders/activate`

New route in `src/routes/admin.ts`, `SUPER_ADMIN` only (existing `adminRoutes.use('*',
requireSuperAdmin)`).

**Request body**

```json
{ "userId": "...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "orderCode": "DH-2026-0900", "idempotencyKey": "..." }
```

Validated with the existing `fullName`/`phone` validators (`src/lib/validators.ts`) and
`orderCode: '1 <= string <= 100'` (same bounds as the normal order schema).

**Errors:** `404 {"error":"user not found"}` if `userId` doesn't resolve to an existing
`USER`; `409 {"error":"duplicate activation","code":"DUPLICATE"}` on a replayed
`idempotencyKey` (same convention as `redeem()`'s `DUPLICATE`).

**Implementation — new function `activateCustomer()` in `src/lib/orders.ts`.** This is
deliberately a *new* function, not a composition of `approveOrder()` + `redeem()`: both
of those unconditionally fire their own notification (`ORDER_APPROVED`, `REDEMPTION`),
and the whole point of this flow is exactly one, differently-worded notification. Calling
either function and suppressing its notification after the fact isn't possible (they're
single atomic batches), so this writes its own batch directly, following the same
guarded-`db.batch()` style as `approveOrder()`:

1. Idempotency check first (mirrors `redeem()`'s replay check): if `idempotencyKey`
   already exists on any `point_ledger` row, return `DUPLICATE`.
2. One `db.batch()`:
   - Insert the order directly as `status = 'APPROVED'`, `activation_code = orderCode`,
     `decided_by = adminId`, `decided_at = now`, `note = 'Kích hoạt trực tiếp bởi admin —
     khách đã thanh toán tiền mặt'`.
   - Insert an `order_events` row, `type = 'APPROVED'`, `actor_id = adminId` (audit
     parity with a normal approval).
   - Insert `CUSTOMER_REWARD` +50 F for the CTV, `order_id` = the new order's id.
   - Insert `CUSTOMER_REFERRAL_BONUS` +10 F for the CTV's referrer, guarded on the
     referrer existing and being role `USER` — **identical condition to `approveOrder()`'s
     S3** (copy that JOIN, don't diverge).
   - Insert `REDEMPTION` −50 F for the CTV, `idempotency_key` = the client-supplied key,
     `note = 'Khách đã thanh toán trực tiếp — admin kích hoạt'`, `created_by = adminId`.
   - Insert **one** notification for the CTV: new message builder
     `customerActivatedMessage(fullName, orderCode)` in
     `src/domain/notifications/messages.ts` (title "Khách hàng đã được kích hoạt", body
     mentions the customer name, order code, and that the 50 points were credited and
     redeemed immediately), inserted via a new `notifyCustomerActivated()` builder in
     `src/lib/notifications.ts` (same `ledgerNotif()` shape as `notifyRedemption`, type
     `'REDEMPTION'`, tied to the redemption row's id).
   - Insert the existing `notifyCustomerReferralBonus(db, orderId, now)` unchanged — the
     referrer's own notification is unaffected by this flow (they still just see "+10").
3. Return `{ order }` (same shape as `approveOrder()`'s success response).

No `LOCKED`/`INSUFFICIENT_BALANCE` checks are needed here (unlike `redeem()`): the +50
and −50 happen in the same batch for the same wallet, so the balance is structurally
never negative and "redemption unlocked" is irrelevant — the `CUSTOMER_REWARD` row that
unlocks it is created in this very batch.

### Frontend

- `src/lib/adminOrders.ts`: new `useActivateCustomer()` mutation hook, `POST
  /api/admin/orders/activate`, invalidates `['admin', 'orders']` (and, since the
  visited-user's ledger/balances/orders may be showing, also invalidate
  `['admin', 'ledger']`, `['admin', 'users', 'balances']`, `['admin', 'users', 'detail']`
  query key prefixes broadly enough to refresh an open user-detail page).
- `src/routes/admin/orders.tsx`: add the button + modal (new component, e.g.
  `ActivateCustomerModal`, sibling to how `RedeemModal` lives inline in
  `admin/redemption.tsx`).

## Testing

- Backend (`test/`, TDD per repo convention): new `test/admin-activate-customer.test.ts`.
  Cases: happy path (order created APPROVED, CTV F unchanged net, referrer +10, exactly
  one `REDEMPTION`-type notification for the CTV, one `CUSTOMER_REFERRAL_BONUS`
  notification for the referrer if any); no-referrer case (only the CTV-side rows/notif);
  duplicate `idempotencyKey` → `409`; unknown `userId` → `404`; `401`/`403` for
  non-admin.
- Frontend: no test framework in this repo (established in the prior plan) — manual
  dev-server verification, same as the existing admin user-detail page's Task 9.

## Out of scope

- Bulk/CSV import of multiple customer activations at once.
- Editing or reversing a direct activation after creation (use the normal
  redemption/adjustment tools if a mistake needs correcting).
- Any change to how the CTV's own `/orders` self-service flow works — untouched.
