// Registration-bonus planner (PRD §6.1, tech-spec §6.3). Emits the wallet-B draft credited
// atomically with user creation. Referring someone who merely registers earns nothing (that
// bonus was REFERRAL_SIGNUP_BONUS, removed) — only the registrant's own self bonus is left.
import { POINTS } from './constants'
import type { LedgerDraft } from './types'

export function planRegistrationBonuses(input: { userId: string }): LedgerDraft[] {
  return [
    {
      userId: input.userId,
      wallet: 'B',
      type: 'REGISTRATION_BONUS',
      points: POINTS.REGISTRATION,
      subjectUserId: input.userId,
    },
  ]
}
