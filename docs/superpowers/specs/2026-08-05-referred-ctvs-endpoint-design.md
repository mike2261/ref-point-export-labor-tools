# Referred-CTVs listing endpoint — design

## Purpose

The A/B/C wallet split (see `2026-08-05-wallet-abc-split-design.md`) removed `REFERRAL_SIGNUP_BONUS`
— referring someone who merely registers no longer earns points or a ledger row. The client used
that ledger row as its only way to answer "which/how many CTVs has this person referred?" (a
dashboard tile, a dedicated page, and the referral-invite page's stats). With the ledger row gone,
that count/list needs a direct, non-ledger source: `users.referrer_id`.

## Backend change

### `src/lib/users.ts`

```ts
export interface ReferredUserRow {
  id: string
  full_name: string
  phone: string
  created_at: string
}

export interface ReferredUser {
  id: string
  fullName: string
  phone: string
  createdAt: string
}

export function toReferredUser(row: ReferredUserRow): ReferredUser {
  return { id: row.id, fullName: row.full_name, phone: row.phone, createdAt: row.created_at }
}

/** Users directly referred by `referrerId` (users.referrer_id = referrerId), newest first. No
 *  point/ledger involvement — this is a pure users-table relationship, independent of whether
 *  referring ever earned anything. */
export async function listReferredUsers(
  db: D1Database,
  referrerId: string,
  filter: { page: number; limit: number },
): Promise<{ rows: ReferredUserRow[]; total: number }> {
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?`)
    .bind(referrerId)
    .first<{ n: number }>()
  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(
      `SELECT id, full_name, phone, created_at FROM users
       WHERE referrer_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(referrerId, filter.limit, offset)
    .all<ReferredUserRow>()
  return { rows: results, total: totalRow?.n ?? 0 }
}
```

### `src/routes/points.ts` (self-scoped)

```
GET /api/points/referred-ctvs?page=&limit=
  → { users: ReferredUser[], page, limit, total }
```

`referrerId` is always `user.id` from the session — never a client-supplied param (same
self-scoping rule as every other `/api/points/*` route).

### `src/routes/admin.ts` (admin, any CTV)

```
GET /api/admin/users/:id/referred-ctvs?page=&limit=
  → { users: ReferredUser[], page, limit, total }
  → 404 { error: 'user not found' }   (unknown :id, same shape as GET /users/:id/balances)
```

## Testing

- `test/points.test.ts` (or a new small `test/referred-ctvs.test.ts`): a CTV sees exactly the
  users whose `referrer_id` is them, newest first, paginated; sees none of another CTV's referrals;
  requires auth.
- `test/admin-users.test.ts`: admin sees a given user's referred CTVs; 404 for unknown id.

## Out of scope

No points, no ledger involvement, no new `LedgerType`/`NotificationType`. This is purely a listing
endpoint mirroring `users.referrer_id`, consumed by the FE spec
`xkld-tools-client/docs/superpowers/specs/2026-08-05-wallet-abc-frontend-design.md`.
