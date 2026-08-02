// Notification copy, in Vietnamese (the product language for CTV/admin). Pure builders: given the
// event's facts they return { title, body }. Amounts come from the single POINTS source of truth so
// the copy can never drift from what the ledger actually credited. Kept here (domain, plain-node
// tested) so wording changes are a millisecond TDD loop, not an integration run.
import { POINTS } from '../points/constants'
import type { NotificationContent } from './types'

export function referralSignupBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận điểm giới thiệu',
    body: `Một người bạn giới thiệu vừa đăng ký. Bạn được cộng ${POINTS.REFERRAL_SIGNUP} điểm vào ví F.`,
  }
}

export function customerReferralBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận điểm hoa hồng',
    body: `Người bạn giới thiệu vừa có khách được kích hoạt. Bạn được cộng ${POINTS.CUSTOMER_REFERRAL} điểm vào ví F.`,
  }
}

export function maintenanceAccrualMessage(periodIndex: number): NotificationContent {
  return {
    title: 'Điểm duy trì ví G',
    body: `Bạn được cộng ${POINTS.MAINTENANCE} điểm duy trì vào ví G (chu kỳ tháng thứ ${periodIndex}).`,
  }
}

export function maintenanceResetMessage(periodIndex: number): NotificationContent {
  return {
    title: 'Ví G đã được đặt lại',
    body:
      `Ví G của bạn đã được đặt lại về 0 ở chu kỳ tháng thứ ${periodIndex} do không có khách hàng ` +
      `nào được kích hoạt trong 3 tháng gần nhất.`,
  }
}

export function maintenanceResetWarningMessage(periodIndex: number): NotificationContent {
  return {
    title: 'Ví G sắp bị đặt lại',
    body:
      `Ví G của bạn có thể bị đặt lại về 0 vào chu kỳ tháng thứ ${periodIndex} nếu không có khách ` +
      `hàng nào được kích hoạt trước thời điểm đó. Hãy giới thiệu thêm khách hàng để duy trì điểm.`,
  }
}

// Admin deducted points for cash paid out. One or both wallets may be touched; amounts are the
// positive point counts removed.
export function redemptionMessage(f: number, g: number): NotificationContent {
  const parts: string[] = []
  if (f > 0) parts.push(`${f} điểm ví F`)
  if (g > 0) parts.push(`${g} điểm ví G`)
  return {
    title: 'Quy đổi điểm',
    body: `Quản trị viên đã trừ ${parts.join(' và ')} khỏi tài khoản của bạn.`,
  }
}

// Admin created an already-paid customer's order directly: the CTV's own share is credited
// then immediately redeemed (net zero) since the cash never went through the payout process.
export function customerActivatedMessage(
  fullName: string,
  orderCode: string,
  paidF: number,
  paidG: number,
): NotificationContent {
  const parts = [`${paidF} điểm ví F`]
  if (paidG > 0) parts.push(`${paidG} điểm ví G`)
  return {
    title: 'Khách hàng đã được kích hoạt',
    body:
      `Khách hàng ${fullName} (đơn ${orderCode}) đã được kích hoạt. Toàn bộ điểm của bạn đã được ` +
      `quyết toán và chi trả: ${parts.join(' và ')}. Hai ví hiện về 0 và bắt đầu tích luỹ lại từ đầu.`,
  }
}
