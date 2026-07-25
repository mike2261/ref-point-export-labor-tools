import { describe, it, expect } from 'vitest'
import { POINTS } from '../points/constants'
import {
  orderCreatedMessage,
  orderApprovedMessage,
  orderRejectedMessage,
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  redemptionMessage,
} from './messages'

describe('notification messages', () => {
  it('order created: appends a non-empty note, drops a blank one', () => {
    expect(orderCreatedMessage(null).body).not.toContain('Ghi chú')
    expect(orderCreatedMessage('   ').body).not.toContain('Ghi chú')
    expect(orderCreatedMessage('đi Nhật').body).toContain('“đi Nhật”')
  })

  it('order approved states the +CUSTOMER_REWARD credit', () => {
    expect(orderApprovedMessage(null).body).toContain(String(POINTS.CUSTOMER_REWARD))
  })

  it('order rejected has no point amount', () => {
    const { body } = orderRejectedMessage(null)
    expect(body).toContain('từ chối')
  })

  it('referral + customer referral bonuses quote their exact amounts', () => {
    expect(referralSignupBonusMessage().body).toContain(String(POINTS.REFERRAL_SIGNUP))
    expect(customerReferralBonusMessage().body).toContain(String(POINTS.CUSTOMER_REFERRAL))
  })

  it('maintenance messages mention the period', () => {
    expect(maintenanceAccrualMessage(4).body).toContain('thứ 4')
    expect(maintenanceAccrualMessage(4).body).toContain(String(POINTS.MAINTENANCE))
    expect(maintenanceResetMessage(4).body).toContain('thứ 4')
  })

  it('redemption lists only the wallets actually deducted', () => {
    expect(redemptionMessage(5, 0).body).toContain('5 điểm ví F')
    expect(redemptionMessage(5, 0).body).not.toContain('ví G')
    expect(redemptionMessage(0, 3).body).toContain('3 điểm ví G')
    expect(redemptionMessage(5, 3).body).toContain('5 điểm ví F và 3 điểm ví G')
  })
})
