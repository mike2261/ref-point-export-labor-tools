// System-wide point constants (PRD §8) — compile-time values, NOT per-transaction configurable
// and NOT env vars. Fixed amounts credited by each event.
export const POINTS = {
  REGISTRATION: 100, // F, to the new registrant
  REFERRAL_SIGNUP: 20, // F, to the direct referrer when someone they referred registers
  CUSTOMER_REWARD: 500, // F, to the order creator when the order is APPROVED
  CUSTOMER_REFERRAL: 100, // F, to the creator's direct referrer on APPROVED
} as const
