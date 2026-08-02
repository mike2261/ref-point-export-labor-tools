// R4 (uq_ledger_idem) rejects a replayed idempotencyKey → whole batch rolls back (tech-spec §6.2).
// D1 reports the violation by columns ("...point_ledger.idempotency_key, point_ledger.wallet"), not
// the partial index name; match either form, scoped to a UNIQUE failure so the linkage CHECK on
// idempotency_key can't be misread as a replay. Pinned by test/constraints.test.ts. Used by
// activateCustomer() in orders.ts — the only writer of REDEMPTION rows left in the app now that
// the standalone admin "Đổi điểm" flow (manual, un-triggered redemption) has been removed;
// activation settles a CTV's whole balance itself, on every customer it activates.
export function isDuplicateRedemption(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('uq_ledger_idem') ||
    (msg.includes('UNIQUE constraint failed') && msg.includes('idempotency_key'))
  )
}
