// Order code ("XKLD-<YYYYMM>-<6-digit seq>") and activation code generation. The sequence is
// computed inside the INSERT itself (see orders.ts) via a subquery keyed on `monthKey` — this
// stays a single round trip; the UNIQUE index on order_code is the collision backstop (design:
// docs/superpowers/specs/2026-07-25-order-lifecycle-design.md).

/** `2026-07-25T...` → `"202607"`, the month bucket an order code's sequence is scoped to. */
export function monthKey(now: string): string {
  return now.slice(0, 7).replace('-', '')
}

/** Opaque per-order activation token. No expiry (deferred — see design decision #2). */
export function randomActivationCode(): string {
  return `ACT-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

/** How many times to retry order creation on an order_code/activation_code collision. */
export const CODE_COLLISION_RETRIES = 3
