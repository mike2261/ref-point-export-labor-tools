import { describe, it, expect } from 'vitest'
import { POINTS } from '../points/constants'
import {
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from './messages'

describe('notification messages', () => {
  it('referral + customer referral bonuses quote their exact amounts', () => {
    expect(referralSignupBonusMessage().body).toContain(String(POINTS.REFERRAL_SIGNUP))
    expect(customerReferralBonusMessage('Trần Quốc Bảo').body).toContain(String(POINTS.CUSTOMER_REFERRAL))
  })

  it('customer referral bonus names the referred CTV who closed the customer', () => {
    const { body } = customerReferralBonusMessage('Trần Quốc Bảo')
    expect(body).toContain('Trần Quốc Bảo')
  })

  it('customer activated states the customer, order code, and both wallet payouts', () => {
    const { title, body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 720, 300)
    expect(title).toBe('Khách hàng đã được kích hoạt')
    expect(body).toContain('Trần Thị B')
    expect(body).toContain('DH-2026-0900')
    expect(body).toContain('720')
    expect(body).toContain('300')
  })

  it('customer activated omits the G wallet when there was nothing in it', () => {
    const { body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 500, 0)
    expect(body).toContain('500')
    expect(body).not.toContain('ví G')
  })

  it('admin bonus quotes the amount and includes the admin-authored content', () => {
    const { title, body } = adminBonusMessage(50, 'Thưởng mừng đạt mốc 50 CTV')
    expect(title).toBe('Bạn nhận điểm thưởng')
    expect(body).toContain('50')
    expect(body).toContain('Thưởng mừng đạt mốc 50 CTV')
  })

  it('redemption lists only the wallets actually deducted', () => {
    expect(redemptionMessage(5, 0).body).toContain('5 điểm ví F')
    expect(redemptionMessage(5, 0).body).not.toContain('ví G')
    expect(redemptionMessage(0, 3).body).toContain('3 điểm ví G')
    expect(redemptionMessage(5, 3).body).toContain('5 điểm ví F và 3 điểm ví G')
  })
})
