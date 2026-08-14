import { describe, it, expect } from 'vitest'
import { POINTS } from '../points/constants'
import {
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
  formatVnd,
} from './messages'

describe('notification messages', () => {
  it('customer referral bonus quotes its exact amount, as money', () => {
    expect(customerReferralBonusMessage('Trần Quốc Bảo').body).toContain(
      formatVnd(POINTS.CUSTOMER_REFERRAL),
    )
  })

  it('customer referral bonus names the referred CTV who closed the customer', () => {
    const { body } = customerReferralBonusMessage('Trần Quốc Bảo')
    expect(body).toContain('Trần Quốc Bảo')
  })

  it('customer referral bonus is framed as commission (tiền hoa hồng), not personal money', () => {
    const { body } = customerReferralBonusMessage('Trần Quốc Bảo')
    expect(body).toContain('tiền hoa hồng')
    expect(body).not.toContain('tiền cá nhân')
  })

  // Không còn chữ "điểm" ở bất kỳ thông báo nào — CTV chỉ thấy tiền.
  it('no message mentions "điểm" any more', () => {
    const bodies = [
      customerReferralBonusMessage('Trần Quốc Bảo').body,
      adminBonusMessage(50, 'Thưởng nóng').body,
      redemptionMessage(7, 5, 3).body,
      customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 720, 300).body,
    ]
    for (const body of bodies) expect(body).not.toMatch(/điểm/i)
  })

  it('customer activated states the customer, order code, and both wallet payouts', () => {
    const { title, body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 720, 300)
    expect(title).toBe('Khách hàng đã được kích hoạt')
    expect(body).toContain('Trần Thị B')
    expect(body).toContain('DH-2026-0900')
    expect(body).toContain(formatVnd(720)) // 7.200.000
    expect(body).toContain(formatVnd(300)) // 3.000.000
  })

  it('customer activated omits wallet C when there was nothing in it', () => {
    const { body } = customerActivatedMessage('Trần Thị B', 'DH-2026-0900', 500, 0)
    expect(body).toContain(formatVnd(500))
    expect(body).not.toContain('tiền thưởng')
  })

  it('admin bonus quotes the amount as money and includes the admin-authored content', () => {
    const { title, body } = adminBonusMessage(50, 'Thưởng mừng đạt mốc 50 CTV')
    expect(title).toBe('Bạn nhận tiền thưởng')
    expect(body).toContain(formatVnd(50)) // 500.000
    expect(body).toContain('Thưởng mừng đạt mốc 50 CTV')
  })

  it('redemption lists only the wallets actually deducted', () => {
    expect(redemptionMessage(0, 5, 0).body).toContain(`${formatVnd(5)}đ tiền cá nhân`)
    expect(redemptionMessage(0, 5, 0).body).not.toContain('tiền thưởng')
    expect(redemptionMessage(0, 0, 3).body).toContain(`${formatVnd(3)}đ tiền thưởng`)
    expect(redemptionMessage(0, 5, 3).body).toContain(
      `${formatVnd(5)}đ tiền cá nhân và ${formatVnd(3)}đ tiền thưởng`,
    )
  })

  it('redemption includes wallet A (tiền hoa hồng) when deducted', () => {
    expect(redemptionMessage(7, 0, 0).body).toContain(`${formatVnd(7)}đ tiền hoa hồng`)
  })

  it('redemption joins three deducted wallets with commas and a final "và"', () => {
    const { body } = redemptionMessage(7, 5, 3)
    expect(body).toContain(
      `${formatVnd(7)}đ tiền hoa hồng, ${formatVnd(5)}đ tiền cá nhân và ${formatVnd(3)}đ tiền thưởng`,
    )
  })

  it('formatVnd scales points by 10.000 and groups with Vietnamese separators', () => {
    expect(formatVnd(100)).toBe('1.000.000')
    expect(formatVnd(500)).toBe('5.000.000')
    expect(formatVnd(1)).toBe('10.000')
  })
})
