// Notification copy, in Vietnamese (the product language for CTV/admin). Pure builders: given the
// event's facts they return { title, body }. Amounts come from the single POINTS source of truth so
// the copy can never drift from what the ledger actually credited. Kept here (domain, plain-node
// tested) so wording changes are a millisecond TDD loop, not an integration run.
import { POINTS } from '../points/constants'
import type { NotificationContent } from './types'

// A trimmed, non-empty note rendered as a suffix; empty/blank notes add nothing.
function noteSuffix(note: string | null): string {
  const trimmed = note?.trim()
  return trimmed ? ` Ghi chú: “${trimmed}”.` : ''
}

// --- Orders -----------------------------------------------------------------

export function orderCreatedMessage(note: string | null): NotificationContent {
  return {
    title: 'Đơn hàng mới',
    body: `Có một đơn hàng mới đang chờ bạn duyệt.${noteSuffix(note)}`,
  }
}

export function orderApprovedMessage(note: string | null): NotificationContent {
  return {
    title: 'Đơn hàng đã được duyệt',
    body: `Đơn hàng của bạn đã được duyệt. Bạn được cộng ${POINTS.CUSTOMER_REWARD} điểm vào ví F.${noteSuffix(note)}`,
  }
}

export function orderRejectedMessage(note: string | null): NotificationContent {
  return {
    title: 'Đơn hàng bị từ chối',
    body: `Đơn hàng của bạn đã bị từ chối.${noteSuffix(note)}`,
  }
}

export function orderNeedsRevisionMessage(reason: string): NotificationContent {
  return {
    title: 'Đơn hàng cần bổ sung',
    body: `Đơn hàng của bạn cần được bổ sung trước khi duyệt tiếp. Lý do: “${reason.trim()}”.`,
  }
}

// --- Point events -----------------------------------------------------------

export function referralSignupBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận điểm giới thiệu',
    body: `Một người bạn giới thiệu vừa đăng ký. Bạn được cộng ${POINTS.REFERRAL_SIGNUP} điểm vào ví F.`,
  }
}

export function customerReferralBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận điểm hoa hồng',
    body: `Đơn hàng của người bạn giới thiệu đã được duyệt. Bạn được cộng ${POINTS.CUSTOMER_REFERRAL} điểm vào ví F.`,
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
      `Ví G của bạn đã được đặt lại về 0 ở chu kỳ tháng thứ ${periodIndex} do không có đơn hàng ` +
      `nào được duyệt trong 3 tháng gần nhất.`,
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
