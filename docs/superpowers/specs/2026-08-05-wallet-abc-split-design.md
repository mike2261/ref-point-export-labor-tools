# Point wallets A/B/C — split the referral-commission wallet, drop the CTV-signup bonus — design

## Purpose

Today every CTV holds two point wallets:

- **F**: `REGISTRATION_BONUS` (self, on signup), `REFERRAL_SIGNUP_BONUS` (referrer, when someone
  they referred signs up), `CUSTOMER_REWARD` (self, when their own customer is activated),
  `CUSTOMER_REFERRAL_BONUS` (referrer, when a CTV they referred activates a customer). All four
  types are undifferentiated in F, and F drains to 0 the moment the CTV activates their own
  customer (`activateCustomer()`).
- **G**: `ADMIN_BONUS` (ad-hoc admin grants). Also drains to 0 on the CTV's own activation.

This changes the earning model in two ways:

1. **`REFERRAL_SIGNUP_BONUS` is removed.** Referring someone who merely registers as a CTV no
   longer earns points — only referring a CTV who goes on to land a paying customer does.
2. **The referral commission (`CUSTOMER_REFERRAL_BONUS`) becomes its own wallet, A, that never
   auto-drains.** Everything else that used to live in F/G is regrouped into two wallets, B and C,
   which keep the existing auto-drain-on-activation behavior:

| New wallet | Meaning | Types | Auto-drains on own activation? |
|---|---|---|---|
| **A** ("điểm hoa hồng") | Commission from a CTV you referred landing a customer | `CUSTOMER_REFERRAL_BONUS` | **No** — settled only by an admin acting out-of-band (no in-app flow this round; CTV contacts admin) |
| **B** ("điểm cá nhân") | Your own signup bonus + your own customer reward | `REGISTRATION_BONUS`, `CUSTOMER_REWARD` | Yes (unchanged behavior) |
| **C** ("điểm thưởng") | Ad-hoc admin bonus grants | `ADMIN_BONUS` | Yes (unchanged behavior) |

`REFERRAL_SIGNUP_BONUS` is deleted from the type system entirely (not kept for history — see
"Data wipe" below, there is no history to keep).

Out of scope this round: an admin-facing endpoint to manually redeem/reset wallet A. Admin settles
it out-of-band for now; UI/UX for that is a future change.

## Data wipe (precondition, not a migration concern)

All application data — `users`, `orders`, `point_ledger`, `notifications`, `bonus_grants`,
`password_reset_log` — is wiped in both local and production before this ships. This means the
schema migration below needs **no data remapping**: it rebuilds `point_ledger`/`notifications`
with the new CHECK constraints against empty tables.

Order of operations:

1. Land all code + the migration (against a local D1 with fresh/empty data, or against the
   already-wiped local DB).
2. Wipe local: delete all rows respecting FK order — `notifications`, `point_ledger`, `orders`,
   `bonus_grants`, `password_reset_log`, then `users` — then apply the new migration if not already
   applied.
3. Wipe production the same way, only after an explicit final go-ahead at execution time (separate
   from design approval — this is irreversible).
4. Re-run `pnpm seed:admin --phone ... --name ...` (local and prod) to recreate the SUPER_ADMIN,
   since it was wiped too.

## Schema

`point_ledger` and `notifications` are rebuilt (SQLite can't ALTER a CHECK in place — same
technique as migrations 0006/0009/0011/0012).

### `point_ledger`

- `wallet CHECK (wallet IN ('A', 'B', 'C'))` — was `('F', 'G')`.
- `type CHECK (type IN ('REGISTRATION_BONUS', 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET',
  'ADMIN_BONUS', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION'))` — drops
  `'REFERRAL_SIGNUP_BONUS'`. (`MAINTENANCE_ACCRUAL`/`MAINTENANCE_RESET` are left alone — dead since
  the 0012 migration, not part of this change, and wiping doesn't force touching them.)
- Sign discipline: `(points > 0) = (type IN ('REGISTRATION_BONUS', 'MAINTENANCE_ACCRUAL',
  'ADMIN_BONUS', 'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS'))` — drops `REFERRAL_SIGNUP_BONUS`.
- Wallet discipline:
  ```sql
  CHECK (CASE
    WHEN type = 'CUSTOMER_REFERRAL_BONUS' THEN wallet = 'A'
    WHEN type IN ('REGISTRATION_BONUS', 'CUSTOMER_REWARD') THEN wallet = 'B'
    WHEN type IN ('MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS') THEN wallet = 'C'
    WHEN type = 'REDEMPTION' THEN 1
    END)
  ```
- Linkage discipline: `(subject_user_id IS NOT NULL) = (type = 'REGISTRATION_BONUS')` — drops
  `REFERRAL_SIGNUP_BONUS` from that list (it was the only other type that used
  `subject_user_id`; the column stays on the table, just never set by any type but
  `REGISTRATION_BONUS` now).
- Everything else (`order_id`, `period_index`, `bonus_grant_id`, `idempotency_key` linkage
  CHECKs) is unchanged.

### `notifications`

- `type CHECK` drops `'REFERRAL_SIGNUP_BONUS'`.
- `ledger_id`-required list drops `'REFERRAL_SIGNUP_BONUS'`.
- Everything else unchanged.

### Indexes

All existing indexes on `point_ledger`/`notifications` are recreated as-is (no index touches
`wallet` or `type` by value, only by column).

## Domain layer

### `src/domain/points/types.ts`

- `Wallet = 'A' | 'B' | 'C'`.
- `LedgerType` drops `'REFERRAL_SIGNUP_BONUS'`.

### `src/domain/points/constants.ts`

- Drop `REFERRAL_SIGNUP: 20`.
- `REGISTRATION`, `CUSTOMER_REWARD`, `CUSTOMER_REFERRAL` amounts are unchanged — only the wallet
  they land in changes.

### `src/domain/points/registration.ts`

`planRegistrationBonuses` simplifies to always emit exactly one draft (the self
`REGISTRATION_BONUS`, wallet `B`). The `referrerId` parameter and the referral-leg branch are
deleted entirely — there is no second draft anymore.

```ts
export function planRegistrationBonuses(input: { userId: string }): LedgerDraft[] {
  return [
    { userId: input.userId, wallet: 'B', type: 'REGISTRATION_BONUS', points: POINTS.REGISTRATION, subjectUserId: input.userId },
  ]
}
```

### `src/domain/points/orderApproval.ts` + `orderApproval.test.ts`

Deleted. This planner has had no caller since the order lifecycle was removed (`orders.ts`'s
`activateCustomer()` duplicates its logic inline instead) — confirmed dead via grep. Leaving it
would mean unused code hard-coding the old wallet `'F'` for both drafts, silently wrong under the
new scheme.

## `src/lib` layer

### `src/lib/ledger.ts`

`getBalances()` returns `{ a: number; b: number; c: number }` instead of `{ f, g }`. Same query
shape, `GROUP BY wallet` now produces up to 3 rows instead of 2.

### `src/lib/users.ts`

- `createUser()`: drop the `referrerEarnsBonus` input field and its branch. `planRegistrationBonuses`
  is called with just `{ userId: id }`. The `notifyReferralSignupBonus(...)` statement is removed
  from the batch. `referrer_id` is still written to the `users` row unconditionally (still needed
  to resolve `CUSTOMER_REFERRAL_BONUS` later, and for admin/referral-tree visibility) — only the
  *bonus* side effect is gone.
- `UserSort`: `'a_asc' | 'a_desc' | 'b_asc' | 'b_desc' | 'c_asc' | 'c_desc'` (was
  `f_asc/f_desc/g_asc/g_desc`). `SORT_CLAUSES` maps to `balance_a/balance_b/balance_c ASC/DESC`.
- `UserRowWithBalances`/`AuthUserWithBalances`: `balance_a/balance_b/balance_c` /
  `balanceA/balanceB/balanceC`.
- `listUsers()`: three correlated `SUM(points) ... AND wallet = 'A'/'B'/'C'` subqueries instead of
  two. Wallet A is included here (not just B/C) so the admin table can show and sort by it — it's
  the balance admins need to see to know when a CTV should be paid out.

### `src/lib/orders.ts` — `activateCustomer()`

- `CUSTOMER_REWARD` row: `wallet` literal `'F' → 'B'`.
- `CUSTOMER_REFERRAL_BONUS` row (to the referrer): `wallet` literal `'F' → 'A'`. Still fires under
  the same condition (referrer exists and `role = 'USER'`) and is still **not** part of the
  settlement below — unchanged intent, new wallet.
- Settlement (the "drain to 0" part): renamed `paidF/paidG → paidB/paidC`.
  - `paidB = before.b + POINTS.CUSTOMER_REWARD` (was `before.f + ...`).
  - `paidC = before.c` (was `before.g`).
  - The `REDEMPTION` row for B is written unconditionally (mirrors the old F row — B is never 0
    here, `CUSTOMER_REWARD` just landed). The `REDEMPTION` row for C is written only if `paidC > 0`
    (mirrors the old conditional G row).
  - Wallet A is **never** touched by this function — no redemption row, no draining, regardless of
    balance.
- `notifyCustomerActivated(...)` call: pass `paidB, paidC` (param names update accordingly in
  `src/domain/notifications/messages.ts` and `src/lib/notifications.ts`).
- Doc comment at the top of `activateCustomer()` updates to describe B/C settlement and A's
  exemption explicitly (the current comment says "both wallets ending at 0" — now only true for
  B/C).

### `src/lib/bonuses.ts`

`grantBonus()`: the `INSERT INTO point_ledger (..., wallet, type, ...) VALUES (..., 'G',
'ADMIN_BONUS', ...)` literal becomes `'C'`. Nothing else changes — `countCtvUsers`, the
idempotency/duplicate-grant logic, and the broadcast/individual scoping are unaffected.

### `src/lib/notifications.ts` / `src/domain/notifications/messages.ts`

- Delete `notifyReferralSignupBonus` and `referralSignupBonusMessage` — no caller left.
- `customerReferralBonusMessage` (wallet A): copy stays framed around "điểm hoa hồng" (already is,
  via its title) — body wording confirmed as "điểm hoa hồng" rather than "điểm cá nhân" to make the
  no-auto-drain distinction legible to the CTV.
- `registrationBonusMessage`/the `CUSTOMER_REWARD` half of `customerActivatedMessage` (wallet B):
  "điểm cá nhân" (already the in-flight wording in the uncommitted `messages.ts` diff — this design
  continues that direction rather than reverting it).
- `adminBonusMessage` (wallet C): "điểm thưởng" (already in-flight).
- `redemptionMessage(f, g)` → `redemptionMessage(b, c)`: same "chỉ liệt kê ví thực sự bị trừ" logic,
  wording "điểm cá nhân" / "điểm thưởng" (already in-flight, just param names follow).
- `customerActivatedMessage(..., paidF, paidG)` → `(..., paidB, paidC)`, same wording swap.

## Routes

### `src/routes/points.ts`

- `LEDGER_TYPES` drops `'REFERRAL_SIGNUP_BONUS'`.
- `wallet` query validation: `wallet !== 'A' && wallet !== 'B' && wallet !== 'C'` (was `'F'`/`'G'`).
- `GET /balances`: no code change needed — it spreads whatever `getBalances()` returns, so `a`
  appears automatically alongside `b`/`c`.

### `src/routes/admin.ts`

- `USER_SORTS` becomes `['a_asc', 'a_desc', 'b_asc', 'b_desc', 'c_asc', 'c_desc']`.
- The ledger `wallet` query validation (mirrors `points.ts`) updates to `'A'/'B'/'C'`.
- `LEDGER_TYPES` (admin's copy, line ~31) drops `'REFERRAL_SIGNUP_BONUS'`.

## Testing

- `src/domain/points/registration.test.ts`: rewrite for the simplified single-draft planner (drop
  the "with a referrer" case entirely, keep only the self-bonus case, drop the `referrerId` param
  from the call).
- Delete `src/domain/points/orderApproval.test.ts` (source deleted).
- `src/domain/notifications/messages.test.ts`: update wallet-letter assertions to the new copy;
  the already-uncommitted diff in this file is a subset of this — finish it out.
- `test/constraints.test.ts`: update/replace F/G-specific CHECK cases with A/B/C equivalents
  (wallet-discipline case branch, sign discipline, linkage discipline for the dropped
  `REFERRAL_SIGNUP_BONUS`/`subject_user_id` pairing).
- `test/points.test.ts`: wallet filter validation (`'A'/'B'/'C'` accepted, `'F'` rejected),
  `/balances` shape (`{ a, b, c, redemptionUnlocked }`).
- `test/admin-users.test.ts`: sort keys, `balanceA/balanceB/balanceC` in list responses.
- `test/admin-bonuses.test.ts`: `ADMIN_BONUS` rows land in wallet `C`.
- `test/admin-activate-customer.test.ts`: `CUSTOMER_REWARD` → B, `CUSTOMER_REFERRAL_BONUS` → A,
  settlement drains B/C only. **New case**: a CTV with an existing A balance (from a prior
  referred-CTV activation) activates their own customer — A balance is unchanged afterward.
- `test/notifications.test.ts`: drop `REFERRAL_SIGNUP_BONUS` case, update wallet-letter wording
  assertions.

## Frontend (`xkld-tools-client`)

Explicitly out of scope this round (per requester: "UI/UX chỗ này t sẽ update sau"). The API
response shape changes (`balances` gains `a`/loses `f`/`g` naming, `listUsers` sort keys, ledger
`wallet` filter values) are breaking for the current client, but the client will be updated
separately.
