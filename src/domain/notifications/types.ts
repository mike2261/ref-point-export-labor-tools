// Notification taxonomy (PRD §6.3). ORDER_* target an order; the rest target a point-ledger row.
export type NotificationType =
  | 'ORDER_CREATED'
  | 'ORDER_APPROVED'
  | 'ORDER_REJECTED'
  | 'ORDER_NEEDS_REVISION'
  | 'REGISTRATION_BONUS'
  | 'REFERRAL_SIGNUP_BONUS'
  | 'CUSTOMER_REFERRAL_BONUS'
  | 'MAINTENANCE_ACCRUAL'
  | 'MAINTENANCE_RESET'
  | 'MAINTENANCE_RESET_WARNING'
  | 'REDEMPTION'

/** Rendered copy for one notification. Pure data — no I/O, no formatting side effects. */
export interface NotificationContent {
  title: string
  body: string
}
