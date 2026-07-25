// Customers repository: CTV-scoped, found-or-created by (ctv_id, phone) so a retried submission
// for the same person reuses one row instead of spawning a duplicate (design decision #3,
// docs/superpowers/specs/2026-07-25-order-lifecycle-design.md). No stored "registration status" —
// derived from the customer's orders, same "derive, don't store" principle as ledger balances.

export interface CustomerRow {
  id: string
  ctv_id: string
  full_name: string
  phone: string
  date_of_birth: string | null
  market: string | null
  created_at: string
}

export interface Customer {
  id: string
  ctvId: string
  fullName: string
  phone: string
  dateOfBirth: string | null
  market: string | null
  createdAt: string
}

export function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    ctvId: row.ctv_id,
    fullName: row.full_name,
    phone: row.phone,
    dateOfBirth: row.date_of_birth,
    market: row.market,
    createdAt: row.created_at,
  }
}

export interface UpsertCustomerInput {
  ctvId: string
  fullName: string
  phone: string
  dateOfBirth?: string | null
  market?: string | null
}

/**
 * Find-or-update-and-return the CTV's customer by phone. An UPSERT (not a pre-check + insert):
 * a second submission for the same (ctv_id, phone) refreshes the mutable fields (name/dob/market
 * may have been corrected) and reuses the same row, so every order for that person links to one
 * customer — the invariant `approveOrder` relies on (design: "One approved order per customer").
 */
export async function upsertCustomer(
  db: D1Database,
  input: UpsertCustomerInput,
  now: string,
): Promise<Customer> {
  const row = await db
    .prepare(
      `INSERT INTO customers (id, ctv_id, full_name, phone, date_of_birth, market, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ctv_id, phone) DO UPDATE SET
         full_name = excluded.full_name,
         date_of_birth = excluded.date_of_birth,
         market = excluded.market
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      input.ctvId,
      input.fullName,
      input.phone,
      input.dateOfBirth ?? null,
      input.market ?? null,
      now,
    )
    .first<CustomerRow>()

  return toCustomer(row!)
}

export function findCustomerById(db: D1Database, id: string): Promise<CustomerRow | null> {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<CustomerRow>()
}

/** Ownership baked into SQL, same IDOR-safe pattern as findOrderByIdForUser. */
export function findCustomerByIdForCtv(db: D1Database, id: string, ctvId: string): Promise<CustomerRow | null> {
  return db.prepare('SELECT * FROM customers WHERE id = ? AND ctv_id = ?').bind(id, ctvId).first<CustomerRow>()
}
