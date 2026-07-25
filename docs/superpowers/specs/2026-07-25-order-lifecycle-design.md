# Order lifecycle: revision loop, order code, activation code — design

**Date:** 2026-07-25 (revised same day — see "Revision note" below)
**Repo:** `xkld-tools`
**Scope:** Backend only. Replaces the current "note-only, PENDING-only" order with a
real state machine (`DRAFT → PENDING → NEEDS_REVISION → PENDING → APPROVED/REJECTED`)
and adds the fields a real CTV submission needs: the person's name/phone, and a
typed-in order code + activation code — per the gap report
`bao-cao-phan-tich-bo-sung-xkld-tools` (mục 3, mục 4).

## Revision note

The first version of this spec added a separate `customers` table (found-or-created by
CTV+phone) on the theory that a customer could have multiple order attempts over time.
That was wrong for this business: **one order = one real person going abroad, full
stop.** There's no cross-order identity to reuse or dedupe against, so normalizing
into a second table bought nothing but a JOIN. This revision collapses everything back
onto `orders`. It also corrects a second assumption: `order_code`/`activation_code`
are **typed in by the CTV**, not system-generated — the admin manually cross-checks
them against records outside this system before approving, the same way they already
verify "did this person actually go abroad." The system doesn't validate their format
or uniqueness.

## Why

Today `orders` is one row: `user_id`, a free-text `note`, and PENDING/APPROVED/REJECTED.
That's enough to test the point math but not a real CTV workflow: no name/phone for the
person the order is about, no order code the CTV and admin can both reference, and no
way for the admin to ask for a fix without either approving or permanently rejecting.

**Out of scope for this change** (deferred — unrelated to the order flow itself, see
the gap report mục 9): phone-change OTP, whether admins can see old G-wallet cycles,
redemption drain-to-zero vs exact-amount. None of these touch `orders`.

## Decision on the report's "rejected order" question (mục 9)

**A rejected order is terminal; retrying means creating a brand new order.** Matches
the existing immutability principle ("khoá để bảo toàn căn cứ") — `REJECTED` rows are
never edited or reopened. `NEEDS_REVISION` (distinct from `REJECTED`) is the editable
path for "close, just fix this" instead of a hard no.

(Activation-code provisioning and "can one person have multiple orders" — the other
two order-adjacent questions from mục 9 — are moot under the corrected model: codes are
typed in by the CTV, not issued by the system, and there's no customer identity to
count multiple orders against.)

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

### `orders` (rebuilt — see migration notes)

```sql
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),  -- creator (CTV), unchanged
  full_name       TEXT NOT NULL,                        -- the person going abroad
  phone           TEXT NOT NULL,
  order_code      TEXT NOT NULL,                        -- typed by the CTV; not unique/generated
  activation_code TEXT NOT NULL,                        -- typed by the CTV; not unique/generated
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PENDING','NEEDS_REVISION','APPROVED','REJECTED')),
  revision_reason TEXT,                                  -- admin's reason, set iff NEEDS_REVISION
  decided_by      TEXT REFERENCES users(id),
  decided_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((status IN ('APPROVED','REJECTED')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((status = 'NEEDS_REVISION') = (revision_reason IS NOT NULL))
);
```

No format check, no `UNIQUE` on `order_code`/`activation_code` — they're free text the
CTV types in; the admin is the validator, by checking them against whatever external
system (DOLAB, the labor-export company's own records) actually issues them.

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
```

One row per **transition** (not per edit — draft edits aren't audited, only the state
transitions are, since drafts aren't visible to anyone but their CTV).

## API surface (backend only; client follow-up is a separate change)

CTV (`/api/orders`, unchanged prefix):
- `POST /` — create a `DRAFT`. Body: `{ fullName, phone, orderCode, activationCode,
  note? }`.
- `PATCH /:id` — edit any of those fields. Only while `DRAFT` or `NEEDS_REVISION`.
- `POST /:id/submit` — `DRAFT|NEEDS_REVISION → PENDING`, capped at `MAX_PENDING_ORDERS`
  concurrent **`PENDING`** orders (drafts don't count).
- `GET /`, `GET /:id` — unchanged shape, now include `fullName`, `phone`, `orderCode`,
  `activationCode`, `revisionReason`.

Admin (`/api/admin/orders`, unchanged prefix):
- `POST /:id/approve` — unchanged trigger and payout. The admin is trusted to have
  manually verified `fullName`/`phone`/`orderCode`/`activationCode` before calling
  this; the system enforces none of it.
- `POST /:id/reject` — unchanged, terminal.
- `POST /:id/request-revision` — **new**. Body: `{ reason: string }`. `PENDING →
  NEEDS_REVISION`.
- `GET /` — unchanged, `status` filter now accepts the two new values too.

## Testing

TDD-adjacent (this repo's existing convention: implement, then a comprehensive rewrite
of `test/orders.test.ts` covering old + new behavior, run `pnpm test` to green). New
cases: draft creation, PATCH while draft, submit validation, revision round-trip
(request → edit → resubmit → approve), rejected-then-retry via a brand new order,
duplicate order/activation codes across two different orders being allowed (no
uniqueness constraint), `PENDING_LIMIT` still counts only non-draft orders.

## Out of scope

- Frontend (`xkld-tools-client`) — its orders/admin-orders screens will need updating
  for the new create/submit split and the revision state, tracked separately.
- Invoice/settlement ("Hóa đơn/chốt") entity — report's P3, not built here.
- The 3 non-order open questions from the report's mục 9 (phone-change OTP, G-wallet
  history visibility for admin, redemption drain-to-zero) — untouched by this change.
