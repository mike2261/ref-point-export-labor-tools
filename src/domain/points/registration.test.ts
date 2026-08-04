import { describe, it, expect } from 'vitest'
import { planRegistrationBonuses } from './registration'
import { POINTS } from './constants'

describe('planRegistrationBonuses', () => {
  it('always emits exactly one draft: the self REGISTRATION_BONUS in wallet B', () => {
    const drafts = planRegistrationBonuses({ userId: 'u1' })
    expect(drafts).toEqual([
      { userId: 'u1', wallet: 'B', type: 'REGISTRATION_BONUS', points: POINTS.REGISTRATION, subjectUserId: 'u1' },
    ])
  })
})
