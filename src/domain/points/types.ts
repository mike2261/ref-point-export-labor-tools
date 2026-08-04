// Shared domain types for the points core. No framework, no I/O — plain data only.

export type Wallet = 'A' | 'B' | 'C'

export type LedgerType =
  | 'REGISTRATION_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'ADMIN_BONUS'
  | 'CUSTOMER_REWARD'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'REDEMPTION'

export type OrderStatus = 'DRAFT' | 'PENDING' | 'NEEDS_REVISION' | 'APPROVED' | 'REJECTED'

/**
 * What planners emit; `lib/` turns these into SQL statements. Fixed-amount rows only —
 * resets are NOT drafts (their amount depends on the live balance at commit time; see
 * tech-spec §1.1 rule 2).
 */
export interface LedgerDraft {
  userId: string // wallet owner (beneficiary)
  wallet: Wallet
  type: LedgerType
  points: number // positive, fixed amount
  orderId?: string // CUSTOMER_* rows only
  subjectUserId?: string // REGISTRATION_BONUS rows only: the new registrant (always themselves)
}
