import { describe, it, expect } from 'vitest'
import { planRegistrationBonuses } from './registration'
import { POINTS } from './constants'

describe('planRegistrationBonuses', () => {
  it('with a referrer → 2 drafts (the registrant\'s own bonus + the referrer\'s), both carry subjectUserId', () => {
    const drafts = planRegistrationBonuses({ userId: 'u1', referrerId: 'r1' })
    expect(drafts).toEqual([
      { userId: 'u1', wallet: 'F', type: 'REGISTRATION_BONUS', points: POINTS.REGISTRATION, subjectUserId: 'u1' },
      { userId: 'r1', wallet: 'F', type: 'REFERRAL_SIGNUP_BONUS', points: POINTS.REFERRAL_SIGNUP, subjectUserId: 'u1' },
    ])
  })

  it('without a referrer (root user) → 1 draft', () => {
    const drafts = planRegistrationBonuses({ userId: 'u1', referrerId: null })
    expect(drafts).toEqual([
      { userId: 'u1', wallet: 'F', type: 'REGISTRATION_BONUS', points: POINTS.REGISTRATION, subjectUserId: 'u1' },
    ])
  })
})
