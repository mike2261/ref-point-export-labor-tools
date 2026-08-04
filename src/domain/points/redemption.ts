// Redemption pre-flight (admin manually deducts a CTV's points — same "Đổi điểm" mechanic that
// was removed when activation started auto-settling B/C, reintroduced because wallet A never
// auto-drains and otherwise has no payout path). Produces a friendly, specific error BEFORE the
// SQL guard runs. The SQL batch is the authority on balance sufficiency; this mirrors its checks
// for a good message but is never the sole gatekeeper.

export type RedemptionError = 'LOCKED' | 'INSUFFICIENT_A' | 'INSUFFICIENT_B' | 'INSUFFICIENT_C' | 'INVALID_AMOUNT'

export function validateRedemption(input: {
  hasCustomerReward: boolean // B/C unlock condition: user ever had an APPROVED order of their own
  balances: { a: number; b: number; c: number }
  amounts: { a?: number; b?: number; c?: number } // positive integers; at least one present
}): { ok: true } | { ok: false; error: RedemptionError } {
  const { hasCustomerReward, balances, amounts } = input
  const { a, b, c } = amounts

  // Shape first (mirrors the ArkType schema layer): at least one wallet, positive integers only.
  if (a === undefined && b === undefined && c === undefined) return { ok: false, error: 'INVALID_AMOUNT' }
  for (const amount of [a, b, c]) {
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      return { ok: false, error: 'INVALID_AMOUNT' }
    }
  }

  // Wallet A never requires the unlock — a CTV can earn commission purely from CTVs they referred
  // landing customers, without ever landing one themselves, so it must stay payable regardless.
  // B/C keep the original F/G unlock gate (settle-on-first-own-customer).
  if ((b !== undefined || c !== undefined) && !hasCustomerReward) return { ok: false, error: 'LOCKED' }
  if (a !== undefined && a > balances.a) return { ok: false, error: 'INSUFFICIENT_A' }
  if (b !== undefined && b > balances.b) return { ok: false, error: 'INSUFFICIENT_B' }
  if (c !== undefined && c > balances.c) return { ok: false, error: 'INSUFFICIENT_C' }

  return { ok: true }
}
