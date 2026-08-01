import { describe, it, expect } from 'vitest'
import { planOrderApprovalBonuses } from './orderApproval'
import { POINTS } from './constants'

describe('planOrderApprovalBonuses', () => {
  it('with a referrer → the reward to the creator and the referral bonus to the referrer (both F, carry orderId)', () => {
    const drafts = planOrderApprovalBonuses({ orderId: 'o1', orderUserId: 'u1', referrerId: 'r1' })
    expect(drafts).toEqual([
      { userId: 'u1', wallet: 'F', type: 'CUSTOMER_REWARD', points: POINTS.CUSTOMER_REWARD, orderId: 'o1' },
      { userId: 'r1', wallet: 'F', type: 'CUSTOMER_REFERRAL_BONUS', points: POINTS.CUSTOMER_REFERRAL, orderId: 'o1' },
    ])
  })

  it('without a referrer → only the creator\'s reward', () => {
    const drafts = planOrderApprovalBonuses({ orderId: 'o1', orderUserId: 'u1', referrerId: null })
    expect(drafts).toEqual([
      { userId: 'u1', wallet: 'F', type: 'CUSTOMER_REWARD', points: POINTS.CUSTOMER_REWARD, orderId: 'o1' },
    ])
  })
})
