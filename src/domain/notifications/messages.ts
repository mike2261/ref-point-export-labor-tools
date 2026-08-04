// Notification copy, in Vietnamese (the product language for CTV/admin). Pure builders: given the
// event's facts they return { title, body }. Amounts come from the single POINTS source of truth so
// the copy can never drift from what the ledger actually credited. Kept here (domain, plain-node
// tested) so wording changes are a millisecond TDD loop, not an integration run.
import { POINTS } from '../points/constants'
import type { NotificationContent } from './types'

export function registrationBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận điểm đăng ký',
    body: `Chào mừng bạn đến với hệ thống. Bạn được cộng ${POINTS.REGISTRATION} điểm cá nhân.`,
  }
}

// Wallet A — never auto-drains (see redemptionMessage/customerActivatedMessage, neither of which
// ever mentions it). Framed as "điểm hoa hồng" specifically so the copy itself signals to the CTV
// that this is not personal points and needs a manual admin settlement.
export function customerReferralBonusMessage(ctvFullName: string): NotificationContent {
  return {
    title: 'Bạn nhận điểm hoa hồng',
    body: `CTV ${ctvFullName} bạn giới thiệu vừa có khách hàng được kích hoạt. Bạn được cộng ${POINTS.CUSTOMER_REFERRAL} điểm hoa hồng.`,
  }
}

export function adminBonusMessage(amount: number, content: string): NotificationContent {
  return {
    title: 'Bạn nhận điểm thưởng',
    body: `Bạn được cộng ${amount} điểm thưởng: ${content}`,
  }
}

// Admin deducted points for cash paid out. One or both wallets may be touched; amounts are the
// positive point counts removed. b/c only — wallet A is never redeemed through this path.
export function redemptionMessage(b: number, c: number): NotificationContent {
  const parts: string[] = []
  if (b > 0) parts.push(`${b} điểm cá nhân`)
  if (c > 0) parts.push(`${c} điểm thưởng`)
  return {
    title: 'Quy đổi điểm',
    body: `Quản trị viên đã trừ ${parts.join(' và ')} khỏi tài khoản của bạn.`,
  }
}

// Admin created an already-paid customer's order directly: the CTV's own share is credited
// then immediately redeemed (net zero) since the cash never went through the payout process.
// b/c only — wallet A (any referral commission this CTV holds) is left untouched.
export function customerActivatedMessage(
  fullName: string,
  orderCode: string,
  paidB: number,
  paidC: number,
): NotificationContent {
  const parts = [`${paidB} điểm cá nhân`]
  if (paidC > 0) parts.push(`${paidC} điểm thưởng`)
  return {
    title: 'Khách hàng đã được kích hoạt',
    body:
      `Khách hàng ${fullName} (đơn ${orderCode}) đã được kích hoạt. Toàn bộ điểm của bạn đã được ` +
      `quyết toán và chi trả: ${parts.join(' và ')}. Ví đã tất toán và bắt đầu tích luỹ lại từ đầu.`,
  }
}
