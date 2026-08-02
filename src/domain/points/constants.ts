// System-wide point constants (PRD §8) — compile-time values, NOT per-transaction configurable
// and NOT env vars. Fixed amounts credited by each event.
export const POINTS = {
  REGISTRATION: 100, // F, to the new registrant
  REFERRAL_SIGNUP: 20, // F, to the direct referrer when someone they referred registers
  MAINTENANCE: 100, // G, monthly accrual
  CUSTOMER_REWARD: 500, // F, to the order creator when the order is APPROVED
  CUSTOMER_REFERRAL: 100, // F, to the creator's direct referrer on APPROVED
} as const

// Maintenance windowing (PRD §6.4): a 3-month warm-up, then a rolling 3-month dryness check.
export const WARMUP_PERIODS = 3
export const WINDOW_PERIODS = 3
