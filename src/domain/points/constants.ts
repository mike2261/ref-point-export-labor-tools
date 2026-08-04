// System-wide point constants (PRD §8) — compile-time values, NOT per-transaction configurable
// and NOT env vars. Fixed amounts credited by each event.
export const POINTS = {
  REGISTRATION: 100, // B, to the new registrant
  CUSTOMER_REWARD: 500, // B, to the order creator when the order is APPROVED
  CUSTOMER_REFERRAL: 100, // A, to the creator's direct referrer on APPROVED
} as const
