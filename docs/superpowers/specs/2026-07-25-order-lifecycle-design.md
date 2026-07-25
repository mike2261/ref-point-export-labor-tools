# Order lifecycle: customer, order code, activation code, revision loop — design

**Date:** 2026-07-25
**Repo:** `xkld-tools`
**Scope:** Backend only. Replaces the current "note-only, PENDING-only" order with a
real state machine (`DRAFT → PENDING → NEEDS_REVISION → PENDING → APPROVED/REJECTED`),
a `customers` entity, a human-readable order code, and a per-order activation code —
per the gap report `bao-cao-phan-tich-bo-sung-xkld-tools` (mục 3, mục 4).

## Why

Today `orders` is one row: `user_id`, a free-text `note`, and PENDING/APPROVED/REJECTED.
That's enough to test the point math but nowhere near enough for a real CTV workflow:
there's no customer record (who actually went abroad?), no order the CTV or admin can
reference by a human-readable id, and no way for the admin to ask for a fix without
either approving or permanently rejecting. This spec closes those three gaps together
because they share one migration and one state machine.

**Out of scope for this change** (deferred — unrelated to the order flow itself, see
the gap report mục 9): phone-change OTP, whether admins can see old G-wallet cycles,
redemption drain-to-zero vs exact-amount. None of these touch `orders`.

## Decisions on the report's open questions (mục 9) that affect this schema

The report lists 7 unresolved questions. Four are order-schema-relevant; here's the
call for each, made to keep the model consistent with what's already built (immutable
history, DB-enforced invariants, single approval event):

1. **"Chốt khách hàng" = the existing "customer went abroad" event, unchanged.** The
   report also mentions a separate "Hóa đơn/chốt" (invoice/settlement) entity — that's
   real but independent of order approval and is **not** built here (P3 in the report's
   own priority table). Approval semantics stay exactly what they are today.
2. **Activation code: system-generated at order creation, 1:1 with the order.** Not
   admin-pre-provisioned. Simpler (no separate admin "issue codes" workflow to design),
   and matches how `order_code` already needs to be generated at creation time anyway.
   Expiry/usage-window is deferred (not in the report's P1 list) — the code's used/unused
   state is derived from the order's status (`APPROVED` = used), not stored separately.
3. **A customer may have multiple orders over time.** A rejected attempt shouldn't
   erase the customer record — the CTV may legitimately retry with the same person
   later (updated docs, different timing). Customers are found-or-created by
   `(ctv_id, phone)` so repeat submissions for the same person reuse one row.
4. **A rejected order is terminal; retrying means a new order (new code), same
   customer.** This matches the existing immutability principle ("khoá để bảo toàn
   căn cứ") — `REJECTED` rows are never edited or reopened. `NEEDS_REVISION` (new,
   distinct from `REJECTED`) is the editable path for "close, fix this."

Because a customer can now have several order attempts, a DB constraint is needed so
only one of them can ever pay out — see "One approved order per customer" below.

## State machine

```
DRAFT ──submit──▶ PENDING ──approve──▶ APPROVED (terminal, pays +50/+10)
  ▲                  │
  │                  ├──reject────▶ REJECTED (terminal, no payout)
  │                  │
  │                  └──request-revision──▶ NEEDS_REVISION ──submit──▶ PENDING
  └───────────────edit while DRAFT/NEEDS_REVISION──────────────────────┘
```

| Status | CTV can edit? | CTV can submit? | Admin action | Points |
| --- | --- | --- | --- | --- |
| `DRAFT` | Yes | Yes → `PENDING` | — | No |
| `PENDING` | No | — | approve / reject / request-revision | No |
| `NEEDS_REVISION` | Yes | Yes → `PENDING` | — | No |
| `APPROVED` | No | — | — (terminal) | **+50 creator / +10 referrer** |
| `REJECTED` | No | — | — (terminal) | No |

This is an exact match for the report's mục 4 table, with `NEEDS_REVISION` added as
its own state (the report calls it "Cần bổ sung").

## Data model

### `customers` (new)

```sql
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  ctv_id        TEXT NOT NULL REFERENCES users(id),   -- CTV phụ trách; customers are CTV-scoped
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL,
  date_of_birth TEXT,                                  -- ISO date, optional
  market        TEXT,                                  -- thị trường/ngành nghề, optional free text
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_customers_ctv_phone ON customers(ctv_id, phone);
CREATE INDEX idx_customers_ctv ON customers(ctv_id, created_at);
```

No stored "registration status" column (the report's mục 3 lists one) — it's derived
from the customer's orders (has an `APPROVED` order → confirmed; otherwise pending or
none), same "derive, don't store" principle the ledger balances already use. Admin
sees every customer (no `ctv_id` filter); a CTV only ever sees their own.

### `orders` (rebuilt — see migration notes)

```sql
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),     -- creator = beneficiary, unchanged
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  order_code      TEXT NOT NULL UNIQUE,                    -- XKLD-202607-000123
  activation_code TEXT NOT NULL UNIQUE,                     -- opaque token, used iff APPROVED
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PENDING','NEEDS_REVISION','APPROVED','REJECTED')),
  revision_reason TEXT,                                     -- admin's reason, set iff NEEDS_REVISION
  decided_by      TEXT REFERENCES users(id),
  decided_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((status = 'APPROVED' OR status = 'REJECTED') = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((status = 'NEEDS_REVISION') = (revision_reason IS NOT NULL))
);
```

- `order_code`: `XKLD-<YYYYMM>-<6-digit seq>`, sequence counted per calendar month from
  existing rows, generated in the same INSERT via a subquery (`COUNT(*) + 1 ... LIKE
  'XKLD-YYYYMM-%'`). Two concurrent creates in the same month can race to the same
  number; the `UNIQUE` index is the backstop and the app retries on collision (same
  "constraint is the enforcement layer, pre-check is not" pattern as `users.phone`).
- `activation_code`: random opaque token (`crypto.randomUUID()`-derived), no separate
  expiry/usage table for now (see decision #2 above).

### `order_events` (new — the change history the report requires)

```sql
CREATE TABLE order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  type       TEXT NOT NULL CHECK (type IN
               ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED')),
  actor_id   TEXT NOT NULL REFERENCES users(id),
  reason     TEXT,                                          -- REVISION_REQUESTED only
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
```

One row per transition (not per edit — draft edits themselves aren't audited, only
the state transitions are, since drafts aren't visible to anyone but their CTV).

### One approved order per customer

```sql
CREATE UNIQUE INDEX uq_orders_customer_approved
  ON orders(customer_id) WHERE status = 'APPROVED';
```

Because a customer can now have multiple order attempts (decision #3), this is the
new invariant that stops the same real person from paying out `CUSTOMER_REWARD`
twice via two different orders. `approveOrder` pre-checks for an existing approved
order for the same customer and returns a friendly `409` before touching the ledger;
this index is the last-resort backstop if two approvals race.

## API surface (backend only; client follow-up is a separate change)

CTV (`/api/orders`, unchanged prefix):
- `POST /` — create a `DRAFT`. Body: `{ customerName, customerPhone, customerDob?,
  customerMarket?, note? }`. Finds-or-creates the customer by `(ctv_id, phone)`,
  generates `order_code` + `activation_code`. Still capped at `MAX_PENDING_ORDERS`
  concurrent **non-draft** orders (drafts don't count — they're not in anyone's queue).
- `PATCH /:id` — edit `note`/customer fields. Only while `DRAFT` or `NEEDS_REVISION`.
- `POST /:id/submit` — `DRAFT|NEEDS_REVISION → PENDING`. Requires customer name+phone
  present (already guaranteed at creation, but re-checked defensively after edits).
- `GET /`, `GET /:id` — unchanged shape, now include `customer`, `orderCode`,
  `activationCode`, `revisionReason`.

Admin (`/api/admin/orders`, unchanged prefix):
- `POST /:id/approve` — unchanged trigger, now also guards the one-approved-per-customer
  invariant (409 `CUSTOMER_ALREADY_REWARDED`).
- `POST /:id/reject` — unchanged, terminal.
- `POST /:id/request-revision` — **new**. Body: `{ reason: string }`. `PENDING →
  NEEDS_REVISION`.
- `GET /` — unchanged, `status` filter now accepts the two new values too.

## Testing

TDD-adjacent (this repo's existing convention: implement, then a comprehensive rewrite
of `test/orders.test.ts` covering old + new behavior, run `pnpm test` to green). New
cases: draft creation, PATCH while draft, submit validation, revision round-trip
(request → edit → resubmit → approve), rejected-then-retry with a *new* order against
the *same* customer, one-approved-order-per-customer enforcement (two orders, same
customer, first approved, second approve attempt → 409), order/activation code
uniqueness, `PENDING_LIMIT` still counts only non-draft orders.

## Out of scope

- Frontend (`xkld-tools-client`) — its orders/admin-orders screens will need updating
  for the new create/submit split and the revision state, tracked separately.
- Invoice/settlement ("Hóa đơn/chốt") entity — report's P3, not built here.
- Activation-code expiry — deferred per decision #2.
- The 3 non-order open questions from the report's mục 9 (phone-change OTP, G-wallet
  history visibility for admin, redemption drain-to-zero) — untouched by this change.
