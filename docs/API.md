# XKLD Tools — API Reference (Frontend Handoff)

REST API for the points/rewards system. Backend is Hono on Cloudflare Workers with a
D1 database. This document is the single source of truth for building the frontend
against the API: every endpoint, its request/response schema, and concrete examples.

- **Base URL:** all endpoints live under `/api` (e.g. `https://<host>/api/auth/login`).
- **Content type:** requests and responses are JSON (`Content-Type: application/json`).
- **Health check:** `GET /` → `200 {"ok":true,"service":"xkld-tools"}`.

Routers:

| Prefix | Purpose | Auth |
| --- | --- | --- |
| `/api/auth` | Register, login, logout, current user | Public (except `/me`) |
| `/api/points` | Your wallet balances & ledger history | Logged-in user |
| `/api/admin` | User seeding, order decisions, redemptions, ledger, social-proof posts | `SUPER_ADMIN` only |
| `/api/notifications` | Your notification inbox | Logged-in user |
| `/api/posts` | Public social-proof feed ("đã có người đổi thưởng rồi") | Public (read) |

---

## 1. Authentication

**Auth is a bearer token, not a cookie.** `POST /api/auth/login` and `POST
/api/auth/register` return `{ "user": {...}, "token": "<jwt>" }` in the JSON body. Send
that token back on every subsequent request as:

```
Authorization: Bearer <token>
```

- The token is a signed JWT (`HS256`), payload `{ sub, ver, exp }` — no role or name.
  The server reloads the user from the database on **every request**, so role and
  active-status changes take effect immediately.
- **No refresh token, TTL = 1 day.** Password reset/change increments `ver`, immediately
  revoking every older token. `POST /api/auth/logout` remains a client-side discard only.
- A missing/expired/invalid token is treated as **anonymous** (the request is not
  rejected at the auth-header layer); individual endpoints then enforce their own auth.
- CORS is wide open (`origin: '*'`) for now — there's no cookie in play, so this
  carries none of the CSRF/credentialed-CORS risk a cookie-based origin policy would.

### What the frontend must do

Store the token yourself after login/register (e.g. `localStorage`) and attach it to
every request:

```js
// API_URL is this backend's real deployed URL — the frontend calls it directly,
// there's no same-origin proxy to route through (see docs/auth-design.md Step 4).
const res = await fetch(`${API_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone, password }),
})
const { user, token } = await res.json()
localStorage.setItem('token', token)

// later requests
await fetch(`${API_URL}/api/points/balances`, {
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
})
```

`credentials: 'include'` is not needed — nothing here rides on cookies. "Am I logged
in?" is answered by calling `GET /api/auth/me` with the token attached.

### Auth failures

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `{"error":"unauthorized"}` | Endpoint needs a logged-in user; none present. |
| `403` | `{"error":"forbidden"}` | Logged in, but not a `SUPER_ADMIN` (admin routes). |

---

## 2. Conventions

### Error shapes

There are **two** distinct error formats:

1. **Handler errors** — everything the route logic returns:
   ```json
   { "error": "human-readable message" }
   ```
   Some also include a stable machine-readable `code` (and occasionally extra fields):
   ```json
   { "error": "order already decided", "code": "ALREADY_DECIDED", "status": "APPROVED" }
   ```
   Branch on `code` when present; treat `error` as display text.

2. **Body validation errors** — when a request body fails its schema (bad type,
   missing required field, unknown key, value out of range). Produced by
   `@hono/arktype-validator` and always returned as **HTTP 400**:
   ```json
   {
     "success": false,
     "errors": [
       { "message": "password must be at least length 8 (was 4)", "path": ["password"] }
     ]
   }
   ```
   The `errors` array is arktype's problem list. Do **not** expect the `{ "error": ... }`
   shape here — validation failures use `{ "success": false, "errors": [...] }`.

### Pagination

List endpoints accept two query params and return a **flat envelope** (no nested
`meta`):

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer | `20` | Clamped to `1`–`100`. |

Out-of-range or non-integer values are silently clamped/defaulted — they never error.

Response envelope (the data array key varies by endpoint):

```json
{ "orders": [ /* ... */ ], "page": 1, "limit": 20, "total": 137 }
```

`total` is the full count of matching rows (ignoring pagination), for building page
controls. Lists are ordered newest-first (`createdAt DESC`).

### Phone numbers

Phone is the login identity. It is normalized server-side: a leading `+84` becomes `0`,
then it must match `^0\d{9}$` — a Vietnamese mobile number, **10 digits total**
(e.g. `0912345678`). The normalized `0…` form is what gets stored and returned.

---

## 3. Enums

| Enum | Values |
| --- | --- |
| `Role` | `SUPER_ADMIN`, `USER` |
| `OrderStatus` | `APPROVED` in practice. (`DRAFT`, `PENDING`, `NEEDS_REVISION`, `REJECTED` remain in the DB CHECK constraint but are never written — see §4 Order.) |
| `Wallet` | `F`, `G` |
| `LedgerType` | `REGISTRATION_BONUS`, `REFERRAL_SIGNUP_BONUS`, `MAINTENANCE_ACCRUAL`, `MAINTENANCE_RESET`, `CUSTOMER_REWARD`, `CUSTOMER_REFERRAL_BONUS`, `REDEMPTION` |

---

## 4. Entity shapes

All response bodies use these camelCase shapes. Field order below matches the API output.

### User

Returned by register, login, `/me`, `PATCH /me`, and admin user creation. The password
hash is **never** included.

```json
{
  "id": "b3f1c8e2-...",
  "fullName": "Nguyễn Văn A",
  "phone": "0912345678",
  "role": "USER",
  "referrerId": "a1d2...",
  "referralCode": "0912345678",
  "isActive": true,
  "requiresPasswordChange": false,
  "createdAt": "2026-07-10T02:15:30.000Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string (UUID) | |
| `fullName` | string | |
| `phone` | string | Normalized `0…` form. |
| `role` | `Role` | |
| `referrerId` | string \| null | `null` for admin/root users. |
| `referralCode` | string | Defaults to the user's phone. |
| `isActive` | boolean | Deactivated users can't log in. |
| `requiresPasswordChange` | boolean | A temporary-password session must change password before using business routes. |
| `createdAt` | string | ISO 8601. |

### Order

One order = one activated customer going abroad for labor export — `fullName`/`phone` are
**that customer's**, not the CTV's own account. There is no state machine left: an order is
created already-`APPROVED` by the admin (`POST /api/admin/orders/activate`) and never changes
status. `status` is always `"APPROVED"`, `revisionReason` always `null`. The old
`DRAFT → PENDING → NEEDS_REVISION → APPROVED/REJECTED` lifecycle and its endpoints were removed
(see §6.2); the other four enum values survive only in the column's CHECK constraint.

```json
{
  "id": "0c9a...",
  "userId": "b3f1...",
  "fullName": "Trần Thị B",
  "phone": "0900000001",
  "orderCode": "XKLD-2026-0731",
  "activationCode": "KH-88213",
  "note": "Order for client X",
  "status": "APPROVED",
  "revisionReason": null,
  "decidedBy": "a1d2...",
  "decidedAt": "2026-07-10T02:20:00.000Z",
  "createdAt": "2026-07-10T02:20:00.000Z",
  "updatedAt": "2026-07-10T02:20:00.000Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string (UUID) | |
| `userId` | string | The CTV this customer is credited to. |
| `fullName` | string | The customer going abroad. |
| `phone` | string | That customer's phone — VN mobile, normalized to `0XXXXXXXXX`. |
| `orderCode` | string | **Typed in by the admin**, not system-generated. Free text — no format check, not required to be unique. |
| `activationCode` | string | Mirrors `orderCode` — no longer asked for separately. |
| `note` | string \| null | Set by the system to a fixed "activated by admin" marker. |
| `status` | `OrderStatus` | Always `APPROVED`. |
| `revisionReason` | string \| null | Always `null` (vestigial — the revision loop is gone). |
| `decidedBy` | string \| null | The admin who activated this customer. |
| `decidedAt` | string \| null | ISO 8601 — the activation time (same as `createdAt`). |
| `createdAt` | string | ISO 8601. |
| `updatedAt` | string | ISO 8601; bumped on every edit/transition. |

### LedgerEntry (user-facing)

Returned by `GET /api/points/ledger`.

```json
{
  "id": "9f2b...",
  "userId": "b3f1...",
  "wallet": "F",
  "type": "CUSTOMER_REWARD",
  "points": 50,
  "orderId": "0c9a...",
  "orderFullName": "Trần Thị B",
  "orderCode": "XKLD-2026-0731",
  "periodIndex": null,
  "note": null,
  "createdBy": null,
  "createdAt": "2026-07-10T03:00:00.000Z"
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string (UUID) | |
| `userId` | string | Wallet owner / beneficiary. |
| `wallet` | `Wallet` | |
| `type` | `LedgerType` | |
| `points` | number | Signed: credits positive, debits (`REDEMPTION`, `MAINTENANCE_RESET`) negative. |
| `orderId` | string \| null | Set for `CUSTOMER_REWARD` / `CUSTOMER_REFERRAL_BONUS`. |
| `orderFullName` | string \| null | The linked order's `fullName` (the person going abroad) — set whenever `orderId` is. Lets the UI trace a reward back to who earned it without a second request. |
| `orderCode` | string \| null | The linked order's `orderCode` — set whenever `orderId` is. |
| `periodIndex` | number \| null | Set for `MAINTENANCE_*`. |
| `note` | string \| null | |
| `createdBy` | string \| null | Admin id for `REDEMPTION`; `null` = system-generated. |
| `createdAt` | string | ISO 8601. |

### AdminLedgerEntry

Returned by the admin ledger/redemption endpoints. Same as `LedgerEntry` **plus**:

| Field | Type | Notes |
| --- | --- | --- |
| `subjectUserId` | string \| null | The registrant, for `REGISTRATION_BONUS` / `REFERRAL_SIGNUP_BONUS`. |
| `subjectUserFullName` | string \| null | That registrant's name — set whenever `subjectUserId` is. |
| `subjectUserPhone` | string \| null | That registrant's phone — set whenever `subjectUserId` is. |
| `idempotencyKey` | string \| null | For `REDEMPTION` rows. |

---

## 5. Domain rules (for UI expectations)

Point amounts are fixed (not configurable):

| Event | Points | Wallet | To whom |
| --- | --- | --- | --- |
| Registration | +100 | F | The new user |
| Referral signup | +20 | F | The direct referrer |
| Maintenance accrual | +100 / month | G | The user |
| Customer reward (customer activated) | +500 | F | The CTV — **netted straight back out**, see below |
| Customer referral bonus (customer activated) | +100 | F | The CTV's direct referrer |

Other rules:

- **The CTV's own customer reward nets to zero.** Activation credits `CUSTOMER_REWARD` +500
  and writes a `REDEMPTION` −500 in the same batch, because the customer paid the CTV in cash
  in person — the money never went through payout. What a CTV actually accumulates is the
  registration bonus, referral signup bonuses, and the +100 `CUSTOMER_REFERRAL_BONUS` from
  their downline's activations (that one is **not** netted).
- **`orderCode` is not validated by the system.** The admin types it in freely (no format
  check, no uniqueness — two orders may share the same code) and cross-checks it against
  records outside this system (e.g. the labor-export company's own paperwork).
  `activationCode` is no longer asked for separately — it mirrors `orderCode`.
- **Redemption is locked** until a user has earned at least one `CUSTOMER_REWARD`
  (i.e. had a customer activated). Once unlocked it stays unlocked — including after the
  netting above, which does not undo the unlock. Expose this via the `redemptionUnlocked`
  flag on the balances endpoints.
- **Maintenance windowing:** 3-month warm-up, then a rolling 3-month activity check
  (backend cron; read-only visibility via `GET /api/admin/points/at-risk`, §6.4).

---

## 6. Endpoints

### 6.1 `/api/auth`

---

#### `POST /api/auth/register`

Create a `USER`. **A referral code is mandatory** — from the body, or from a `?ref=`
query param on an invite link. On success, returns a bearer token along with the user
(see §1) — the caller stores it and attaches it to subsequent requests.

**Auth:** public.

**Query params:** `ref` (optional) — referral code fallback if `referralCode` is not in the body.

**Request body**

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `fullName` | string | yes | Non-empty after trim. |
| `phone` | string | yes | VN mobile, normalized to `0XXXXXXXXX`. |
| `password` | string | yes | Min length 8. |
| `referralCode` | string | no | Min length 1. Falls back to `?ref=`. |

```json
{
  "fullName": "Nguyễn Văn A",
  "phone": "0912345678",
  "password": "s3cretpw",
  "referralCode": "0900000000"
}
```

**Success — `201`**

```json
{ "user": { "id": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "role": "USER", "referrerId": "a1d2...", "referralCode": "0912345678", "isActive": true, "createdAt": "2026-07-10T02:15:30.000Z" }, "token": "eyJhbGciOiJIUzI1NiIs..." }
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"error":"a referral code is required"}` | No code in body or `?ref=`. |
| `400` | `{"error":"unknown referral code"}` | Code doesn't match any user. |
| `409` | `{"error":"phone already registered"}` | Phone in use. |
| `400` | `{"success":false,"errors":[...]}` | Body failed validation. |

---

#### `POST /api/auth/login`

**Auth:** public.

**Request body**

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `phone` | string | yes | VN mobile. |
| `password` | string | yes | Min length 1. |

```json
{ "phone": "0912345678", "password": "s3cretpw" }
```

**Success — `200`**

```json
{ "user": { "id": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "role": "USER", "referrerId": "a1d2...", "referralCode": "0912345678", "isActive": true, "createdAt": "2026-07-10T02:15:30.000Z" }, "token": "eyJhbGciOiJIUzI1NiIs..." }
```

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `401` | `{"error":"invalid phone or password"}` | Unknown phone, wrong password, **or** deactivated account (deliberately indistinguishable). |
| `400` | `{"success":false,"errors":[...]}` | Body failed validation. |

---

#### `POST /api/auth/logout`

**Auth:** public. Stateless no-op (see §1) — nothing to clear server-side; the caller discards its own stored token. No body.

**Success — `200`**

```json
{ "ok": true }
```

---

#### `GET /api/auth/me`

Return the currently logged-in user. Use this to bootstrap session state on app load.

**Auth:** logged-in.

**Success — `200`**

```json
{ "user": { "id": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "role": "USER", "referrerId": "a1d2...", "referralCode": "0912345678", "isActive": true, "createdAt": "2026-07-10T02:15:30.000Z" } }
```

**Errors:** `401 {"error":"unauthorized"}`.

---

#### `PATCH /api/auth/me`

Update your own profile. Only `fullName` is editable in this phase.

**Auth:** logged-in.

**Request body**

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `fullName` | string | yes | Non-empty after trim. |

```json
{ "fullName": "Nguyễn Văn B" }
```

**Success — `200`** — the updated `{ "user": ... }`.

**Errors:** `401 {"error":"unauthorized"}`; `400 {"success":false,"errors":[...]}`.

---

#### `GET /api/auth/password-help`

Public contact data for the forgot-password screen. `zaloQrValue` is encoded as a QR code by the frontend. Values are `null` until `ZALO_ADMIN_URL` and `ZALO_ADMIN_PHONE` are configured.

#### `POST /api/auth/change-password`

Changes the current password for a normal or temporary session. The new password must be at least 8 characters. Success returns `{ "ok": true, "reauthenticationRequired": true }` and revokes all existing tokens.

#### `POST /api/admin/users/:id/reset-password`

Super Admin only. After manual Zalo identity checking, installs temporary password `12345678` for a `USER`, valid for 15 minutes. Existing tokens are revoked, the action is audited, and the temporary session may only change password or log out. Super Admin accounts cannot be reset here.

### 6.2 `/api/orders` — **removed**

There is no CTV-facing order router any more. CTVs never create, edit, submit or list orders:
the customer pays the CTV in cash in person, and the **admin** records that directly via
[`POST /api/admin/orders/activate`](#post-apiadminordersactivate), which writes the order
already-`APPROVED`. Requests to `/api/orders*` return `404`.

Removed with it: the `DRAFT → PENDING → NEEDS_REVISION → APPROVED/REJECTED` state machine, the
5-pending-order cap, and the admin's approve / reject / request-revision endpoints. The
`orders.status` column keeps its 5-value CHECK constraint (no migration was run), but only
`'APPROVED'` is ever written now.

---

### 6.3 `/api/points`

All points routes require a logged-in user and are self-scoped to that user.

---

#### `GET /api/points/balances`

Current wallet balances plus the redemption-unlock flag. No params.

**Auth:** logged-in.

**Success — `200`**

```json
{ "f": 110, "g": 30, "redemptionUnlocked": true }
```

| Field | Type | Notes |
| --- | --- | --- |
| `f` | number | F-wallet balance (0 if none). |
| `g` | number | G-wallet balance (0 if none). |
| `redemptionUnlocked` | boolean | `true` once the user has ever earned a `CUSTOMER_REWARD`. |

**Errors:** `401 {"error":"unauthorized"}`.

---

#### `GET /api/points/ledger`

Paginated ledger history for the logged-in user, newest first.

**Auth:** logged-in.

**Query params**

| Param | Type | Notes |
| --- | --- | --- |
| `wallet` | `F` \| `G` | Optional. Invalid → 400. |
| `type` | `LedgerType` | Optional. Invalid → 400. |
| `direction` | `credit` \| `debit` | Optional — `credit` = `points > 0`, `debit` = `points < 0`. Invalid → 400. |
| `from` | ISO datetime | Optional, **inclusive** lower bound on `createdAt`. |
| `to` | ISO datetime | Optional, **exclusive** upper bound on `createdAt`. |
| `q` | string | Optional substring match against the **linked order's** `fullName`/`phone`/`orderCode`. Rows with no `orderId` never match. |
| `page`, `limit` | pagination | See §2. |

**Success — `200`** — `entries` are user-facing `LedgerEntry` objects (no `subjectUserId` / `idempotencyKey`).

```json
{
  "entries": [
    { "id": "9f2b...", "userId": "b3f1...", "wallet": "F", "type": "CUSTOMER_REWARD", "points": 50, "orderId": "0c9a...", "orderFullName": "Trần Thị B", "orderCode": "XKLD-2026-0731", "periodIndex": null, "note": null, "createdBy": null, "createdAt": "2026-07-10T05:00:00.000Z" }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

**Errors:** `400 {"error":"invalid wallet"}`; `400 {"error":"invalid type"}`; `400 {"error":"invalid direction"}`; `401 {"error":"unauthorized"}`.

---

### 6.4 `/api/admin`

**Every** admin route requires `SUPER_ADMIN`. All can return
`401 {"error":"unauthorized"}` (anonymous) or `403 {"error":"forbidden"}` (logged-in
non-admin); these are omitted from the per-endpoint error tables below.

---

#### `POST /api/admin/users`

Create a referrer-less "root" `USER` to seed the referral network. (Normal
`/register` requires a referrer, so the first users must come from here.)

**Request body**

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `fullName` | string | yes | Non-empty after trim. |
| `phone` | string | yes | VN mobile. |
| `password` | string | yes | Min length 8. |

```json
{ "fullName": "Root User", "phone": "0900000000", "password": "rootpass1" }
```

**Success — `201`** — `{ "user": ... }` with `referrerId: null`.

**Errors:** `409 {"error":"phone already registered"}`; `400 {"success":false,"errors":[...]}`.

---

#### `GET /api/admin/users`

Browse/search all users (both roles), newest first. No balances included — use
`GET /api/admin/users/:id/balances` for a specific user's balances.

**Query params**

| Param | Type | Notes |
| --- | --- | --- |
| `q` | string | Optional. Substring match against `fullName` **or** `phone`. ASCII-only case-insensitive (accented names are case-sensitive; phone search is unaffected). |
| `page`, `limit` | pagination | See §2. |

**Success — `200`**

```json
{
  "users": [
    { "id": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "role": "USER", "referrerId": "a1d2...", "referralCode": "0912345678", "isActive": true, "createdAt": "2026-07-10T02:15:30.000Z" }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

---

#### `GET /api/admin/users/:id`

A single user's identity fields (no balances — use `GET /api/admin/users/:id/balances`
for those).

**Success — `200`**

```json
{ "user": { "id": "b3f1...", "fullName": "Nguyễn Văn A", "phone": "0912345678", "role": "USER", "referrerId": "a1d2...", "referralCode": "0912345678", "isActive": true, "createdAt": "2026-07-10T02:15:30.000Z" } }
```

**Errors:** `404 {"error":"user not found"}`.

---

#### `GET /api/admin/orders`

List orders across all users (the admin approval queue), newest first.

**Query params**

| Param | Type | Notes |
| --- | --- | --- |
| `status` | `OrderStatus` | Optional. Invalid → 400. |
| `userId` | string | Optional filter to one user. |
| `q` | string | Optional substring match against `fullName`/`phone`/`orderCode`/`activationCode`. |
| `page`, `limit` | pagination | See §2. |

**Success — `200`** — `{ orders, page, limit, total }`. Every row is an activated customer
(`status: "APPROVED"`); this is the admin's customer list.

**Errors:** `400 {"error":"invalid status"}`.

---

#### `POST /api/admin/redemptions`

Deduct points for cash paid out to a user outside the system. Debits the F and/or G
wallet. Idempotent via `idempotencyKey`.

**Request body** — at least one of `f` / `g` is required; **any other key hard-fails with 400**.

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `userId` | string | yes | Min length 1. |
| `f` | number | conditional | Positive integer. F-wallet amount to deduct. |
| `g` | number | conditional | Positive integer. G-wallet amount to deduct. |
| `note` | string | no | ≤ 500 chars. |
| `idempotencyKey` | string | yes | Min length 1. Replaying the same key is rejected. |

At least one of `f` or `g` must be present, else `400` with `"at least one of f or g"`.

```json
{ "userId": "b3f1...", "f": 50, "note": "Paid 500k cash", "idempotencyKey": "redeem-2026-07-10-001" }
```

**Success — `201`**

```json
{
  "entries": [
    { "id": "e1...", "userId": "b3f1...", "wallet": "F", "type": "REDEMPTION", "points": -50, "orderId": null, "periodIndex": null, "note": "Paid 500k cash", "createdBy": "a1d2...", "createdAt": "2026-07-10T06:00:00.000Z", "subjectUserId": null, "idempotencyKey": "redeem-2026-07-10-001" }
  ],
  "balances": { "f": 60, "g": 30 }
}
```

- `entries` — one `AdminLedgerEntry` per wallet redeemed, `points` negative.
- `balances` — the user's derived F/G balances **after** the redemption.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"user not found"}` | `userId` doesn't exist. |
| `409` | `{"error":"duplicate redemption","code":"DUPLICATE_REDEMPTION"}` | `idempotencyKey` already used. |
| `422` | `{"error":"redemption locked","code":"REDEMPTION_LOCKED"}` | User has never earned a `CUSTOMER_REWARD`. |
| `422` | `{"error":"insufficient balance","code":"INSUFFICIENT_BALANCE"}` | Not enough points in a targeted wallet. |
| `400` | `{"success":false,"errors":[...]}` | Bad body / unknown key / neither f nor g. |

---

#### `POST /api/admin/orders/activate`

Create an already-`APPROVED` order for a customer who already paid the CTV in cash outside
the system, and **settle the CTV in full**: pays the +500 F reward, pays the referrer's +100 F
(if any, left untouched), then drains the CTV's *entire* F and G balances to 0 — not just this
order's own reward, everything they were holding. The CTV gets exactly one notification
listing both drained amounts (not separate "approved" + "redeemed" notifications).

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

**Success — `201`**

```json
{ "order": { "...": "...", "status": "APPROVED" }, "paid": { "f": 600, "g": 100 } }
```

`paid` is what got drained from the CTV — their pre-existing balance in each wallet plus this
order's own +500 F reward. The CTV's balances are 0/0 immediately after.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"user not found"}` | No such `USER`. |
| `409` | `{"error":"duplicate activation","code":"DUPLICATE"}` | Replayed `idempotencyKey`. |
| `400` | `{"success":false,"errors":[...]}` | Bad body. |

---

#### `PATCH /api/admin/orders/:id`

Fix the customer details the admin typed in when activating (wrong name, wrong number, wrong
order code). Data-entry repair only: the CTV, the point ledger and the notifications already
sent are all left exactly as they were — reassigning an order to another CTV is not possible
here. `activationCode` is rewritten to match the new `orderCode`, the same mirroring
activation does.

**Request body** — all three required; **any other key hard-fails with 400** (notably `userId`).

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `fullName` | string | yes | Same validator as activation. |
| `phone` | string | yes | Same validator as activation (free text, 1–20 chars). |
| `orderCode` | string | yes | 1–100 chars. Also stored as the order's `activationCode`. |

```json
{ "fullName": "Nguyễn Văn A", "phone": "0912345678", "orderCode": "DH-2026-0900" }
```

**Success — `200`** — `{ "order": { "...": "...", "status": "APPROVED" } }`, the updated row.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `404` | `{"error":"order not found"}` | No such order. |
| `400` | `{"success":false,"errors":[...]}` | Bad body / unknown key. |

---

#### `GET /api/admin/users/:id/balances`

Balances for any user (admin view of §6.3's balances).

**Success — `200`**

```json
{ "f": 110, "g": 30, "redemptionUnlocked": true }
```

**Errors:** `404 {"error":"user not found"}`.

---

#### `GET /api/admin/ledger`

Ledger across all users, newest first. Returns `AdminLedgerEntry` objects (with
`subjectUserId` / `idempotencyKey`).

**Query params**

| Param | Type | Notes |
| --- | --- | --- |
| `wallet` | `F` \| `G` | Optional. Invalid → 400. |
| `type` | `LedgerType` | Optional. Invalid → 400. |
| `direction` | `credit` \| `debit` | Optional — `credit` = `points > 0`, `debit` = `points < 0`. Invalid → 400. |
| `userId` | string | Optional filter to one user. |
| `from` | ISO datetime | Optional, inclusive lower bound. |
| `to` | ISO datetime | Optional, exclusive upper bound. |
| `q` | string | Optional substring match against the linked order's `fullName`/`phone`/`orderCode`. Rows with no `orderId` never match. |
| `page`, `limit` | pagination | See §2. |

**Success — `200`**

```json
{
  "entries": [
    { "id": "9f2b...", "userId": "b3f1...", "wallet": "F", "type": "REGISTRATION_BONUS", "points": 10, "orderId": null, "orderFullName": null, "orderCode": null, "periodIndex": null, "note": null, "createdBy": null, "createdAt": "2026-07-10T02:15:30.000Z", "subjectUserId": "b3f1...", "subjectUserFullName": "Nguyễn Văn A", "subjectUserPhone": "0912345678", "idempotencyKey": null }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

**Errors:** `400 {"error":"invalid wallet"}`; `400 {"error":"invalid type"}`; `400 {"error":"invalid direction"}`.

---

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

## Social-proof posts

A curated feed of "đã có người đổi thưởng rồi" cards (image + title + description) shown to CTVs.
Images are uploaded through the Worker to the WordPress media library (the WP Application Password
is a Worker secret and never reaches the browser); D1 stores only the resulting URL.

A `Post` is: `{ id, title, description, imageUrl, published, createdAt }`.

### `GET /api/posts` — public feed

Published posts, newest first. Public (no auth). Supports `?page=&limit=`.

```json
{ "posts": [ { "id": "…", "title": "Chị Lan đã đổi 2.000.000đ", "description": "CTV Hà Nội", "imageUrl": "https://xklddieuduong.vn/wp-content/uploads/…jpg", "published": true, "createdAt": "2026-07-27T…Z" } ], "page": 1, "limit": 20, "total": 1 }
```

### `GET /api/admin/posts` — admin list (`SUPER_ADMIN`)

Same shape as the public feed. There's no hide/show: every post created is published, permanently
(`published` stays in the payload for now but nothing sets it to `false` any more).

### `GET /api/admin/posts/:id` — single post, for the edit page (`SUPER_ADMIN`)

**`200`** `{ "post": {…} }`, or `404` if unknown.

### `POST /api/admin/posts` — create (`SUPER_ADMIN`)

`multipart/form-data`: `image` (File — jpeg/png/webp, ≤ 8 MB), `title` (≤ 200), `description` (≤ 1000, optional).
The Worker uploads the image to WordPress, then stores the post. **Success — `201`** `{ "post": {…} }`.

**Errors:** `400` (missing/invalid image, missing title, over-length); `413` (image > 8 MB);
`502 {"error":"image upload to WordPress failed","code":"WP_UPLOAD_FAILED"}`.

### `PATCH /api/admin/posts/:id` — edit (`SUPER_ADMIN`)

`multipart/form-data`, all fields optional: `title` (≤ 200), `description` (≤ 1000), `image` (File —
jpeg/png/webp, ≤ 8 MB). Omitted fields are left unchanged; supplying `image` uploads it to WordPress
and replaces the stored URL, exactly like create. **`200`** `{ "post": {…} }`, or `404` if unknown.

### `DELETE /api/admin/posts/:id` — delete (`SUPER_ADMIN`)

**`200`** `{ "ok": true }`, or `404` if unknown.

### Configuration (WordPress media)

- `WP_API_BASE` — public var in `wrangler.jsonc` (`https://xklddieuduong.vn/index.php?rest_route=`,
  the permalink-independent form — the site runs Plain permalinks, so the pretty `/wp-json/` path 404s).
- `WP_MEDIA_USER`, `WP_MEDIA_APP_PASSWORD` — **secrets**. Local: `.dev.vars` (git-ignored).
  Production: `wrangler secret put WP_MEDIA_USER` and `wrangler secret put WP_MEDIA_APP_PASSWORD`.
- Rotate in wp-admin → Users → `media-api` → Application Passwords, then update the secret.
