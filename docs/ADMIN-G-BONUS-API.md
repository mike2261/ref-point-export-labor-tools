# Admin Wallet G Bonus

## Purpose

The feature allows a Super Admin to manually award points to a CTV's wallet G.
The award is stored as an append-only ledger entry instead of directly changing
a cached balance.

The awarded points follow the existing wallet G lifecycle. They can be redeemed
with other G points and are included when the three-month maintenance process
resets wallet G.

## API

```http
POST /api/admin/users/:userId/g-bonus
Authorization: Bearer <super-admin-token>
Content-Type: application/json
```

Example request:

```json
{
  "points": 20,
  "reason": "Monthly activity bonus",
  "idempotencyKey": "bonus-user-2026-07-001"
}
```

Validation rules:

- The caller must be a Super Admin.
- The target account must exist and must have the `USER` role.
- `points` must be a positive integer.
- `reason` is required, trimmed before storage, and limited to 500 characters.
- `idempotencyKey` is required and limited to 200 characters.
- Undeclared request fields are rejected.

Successful response:

```json
{
  "entry": {
    "wallet": "G",
    "type": "ADMIN_BONUS",
    "points": 20,
    "note": "Monthly activity bonus"
  },
  "balances": {
    "before": {
      "f": 10,
      "g": 20
    },
    "after": {
      "f": 10,
      "g": 40
    }
  }
}
```

## Error behavior

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | Validation response | Invalid points, reason, idempotency key, or extra fields |
| `401` | `UNAUTHORIZED` | No valid login session |
| `403` | `FORBIDDEN` | A CTV attempted to call the Admin API |
| `403` | `SUPER_ADMIN_BONUS_FORBIDDEN` | The target is the Super Admin account |
| `404` | — | The target user does not exist |
| `409` | `DUPLICATE_ADMIN_BONUS` | The idempotency key was already committed |

## Data and traceability

The migration adds `ADMIN_BONUS` as a positive, wallet-G-only ledger type.
Each entry records:

- Target CTV
- Awarded points
- Reason
- Super Admin who performed the action
- Creation timestamp
- Idempotency key

Both the Admin ledger and the CTV's own point history can filter by
`type=ADMIN_BONUS`.

No notification is generated in this version.

## Admin frontend

The existing Admin CTV list has a **Cộng điểm G** action. The dialog:

1. Loads the CTV's current wallet G balance.
2. Requires a positive integer and a reason.
3. Generates a unique idempotency key for the request.
4. Calls the bonus API.
5. Shows the balance before and after a successful award.

The frontend is maintained in the nested `frontend` repository. Its local
implementation commit is `c894af7`.

## Verification

The backend test suite covers:

- Successful wallet G credit
- Ledger traceability
- Authentication and Super Admin authorization
- Rejection of Super Admin as a target
- Input validation
- Duplicate request protection
- Three-month wallet G reset behavior

At implementation time, all 133 backend tests and the frontend production build
completed successfully.
