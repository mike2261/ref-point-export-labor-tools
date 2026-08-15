// Notification copy, in Vietnamese (the product language for CTV/admin). Pure builders: given the
// event's facts they return { title, body }. Amounts come from the single POINTS source of truth so
// the copy can never drift from what the ledger actually credited. Kept here (domain, plain-node
// tested) so wording changes are a millisecond TDD loop, not an integration run.
import { POINTS } from '../points/constants'
import type { NotificationContent } from './types'

// Nghiệp vụ đã bỏ khái niệm "điểm" ở phía người dùng: ledger vẫn lưu điểm, nhưng mọi con số CTV
// nhìn thấy đều là VNĐ. Quy đổi nằm ở đây cho phần copy, và ở client/src/lib/money.ts cho phần UI —
// hai nơi phải dùng chung một tỷ lệ.
export const VND_PER_POINT = 10_000

/** 100 → "1.000.000". Không kèm "đ" — phần copy tự thêm nếu cần. */
export function formatVnd(points: number): string {
  return (points * VND_PER_POINT).toLocaleString('vi-VN')
}

export function registrationBonusMessage(): NotificationContent {
  return {
    title: 'Bạn nhận tiền đăng ký',
    body: `Chào mừng bạn đến với hệ thống. Bạn được cộng ${formatVnd(POINTS.REGISTRATION)}đ tiền cá nhân.`,
  }
}

// Wallet A — never auto-drains (see redemptionMessage/customerActivatedMessage, neither of which
// ever mentions it). Framed as "tiền hoa hồng" specifically so the copy itself signals to the CTV
// that this is not personal money and needs a manual admin settlement.
export function customerReferralBonusMessage(ctvFullName: string): NotificationContent {
  return {
    title: 'Bạn nhận tiền hoa hồng',
    body: `CTV ${ctvFullName} bạn giới thiệu vừa có khách hàng được kích hoạt. Bạn được cộng ${formatVnd(POINTS.CUSTOMER_REFERRAL)}đ tiền hoa hồng.`,
  }
}

export function adminBonusMessage(amount: number, content: string): NotificationContent {
  return {
    title: 'Bạn nhận tiền thưởng',
    body: `Bạn được cộng ${formatVnd(amount)}đ tiền thưởng: ${content}`,
  }
}

// Admin deducted points for cash paid out. One, two, or all three wallets may be touched;
// amounts are the positive point counts removed.
export function redemptionMessage(a: number, b: number, c: number): NotificationContent {
  const parts: string[] = []
  if (a > 0) parts.push(`${formatVnd(a)}đ tiền hoa hồng`)
  if (b > 0) parts.push(`${formatVnd(b)}đ tiền cá nhân`)
  if (c > 0) parts.push(`${formatVnd(c)}đ tiền thưởng`)
  const joined =
    parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} và ${parts[parts.length - 1]}`
      : parts[0]
  return {
    title: 'Thanh toán tiền',
    body: `Quản trị viên đã thanh toán ${joined} cho bạn.`,
  }
}

// Admin created an already-paid customer's order directly: the CTV's own share is credited
// then immediately redeemed (net zero) since the cash never went through the payout process.
// b/c only — wallet A (any referral commission this CTV holds) is left untouched.
// Từ 15/08/2026 lần kích hoạt chỉ CỘNG tiền, không tất toán ví nữa — tiền nằm lại trong ví cho
// tới khi admin trả và bấm rút. Nội dung vì thế chỉ nói về khoản vừa được cộng.
export function customerActivatedMessage(
  fullName: string,
  orderCode: string,
  credited: number,
): NotificationContent {
  return {
    title: 'Khách hàng đã được kích hoạt',
    body:
      `Khách hàng ${fullName} (đơn ${orderCode}) đã được kích hoạt. Bạn được cộng ` +
      `${formatVnd(credited)}đ tiền cá nhân.`,
  }
}
