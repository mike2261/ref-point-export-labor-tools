// Seed a self-contained DEMO referral network for PO/PM acceptance testing.
//
//   pnpm seed:demo [--local] [--dry-run] [--purge] [--posts-only] [--guides-only]
//
// Everything it writes is tagged two ways, so it can always be found and removed again:
//   - phone numbers in the 0123xxxxxx block (`DEMO_PHONE_PREFIX`)
//   - full_name (and post title) prefixed with "DEMO "
// 0123 is deliberate: Vietnam retired the 11-digit 0123 mobile prefix in the 2018 renumbering
// (it became 083), so no live subscriber can hold one of these numbers. Both the CTV accounts
// (0123000001+) and the customer numbers on their orders (0123456001+) sit inside that block —
// an earlier revision used 0977/0912, which are live Viettel/Vinaphone prefixes.
// `--purge` deletes exactly that set (plus every order/ledger/notification hanging off it,
// including the ORDER_CREATED notifications that landed in the super admin's inbox). A normal
// run purges first, so re-seeding is idempotent.
//
// Why raw SQL and not the HTTP API: the interesting scenarios (G-wallet accrual, the rolling
// 3-month reset, the "sắp bị đặt lại" warning) only exist for accounts that registered months
// ago, and no endpoint can backdate `users.created_at`. To make sure the backdated history is
// byte-for-byte what production would have produced, this script imports the REAL domain
// planners (planRegistrationBonuses / planOrderApprovalBonuses / planMaintenance /
// planResetWarning) and the REAL notification copy rather than restating any of it.
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashPassword } from '../src/lib/password'
import { POINTS } from '../src/domain/points/constants'
import { planMaintenance, planResetWarning } from '../src/domain/points/maintenance'
import { anniversaryDate } from '../src/domain/points/periods'
import {
  orderCreatedMessage,
  orderApprovedMessage,
  orderRejectedMessage,
  orderNeedsRevisionMessage,
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  maintenanceAccrualMessage,
  maintenanceResetMessage,
  maintenanceResetWarningMessage,
  redemptionMessage,
} from '../src/domain/notifications/messages'
import type { OrderStatus } from '../src/domain/points/types'

const DEMO_PHONE_PREFIX = '0123'
const DEMO_NAME_PREFIX = 'DEMO '
const DEMO_PASSWORD = 'Demo@2026'
// Notifications older than this are pre-marked read, so the unread badge shows a believable
// handful of recent items instead of months of backlog.
const READ_CUTOFF_DAYS = 45

// The system never stores what a point is worth in cash — redemption only debits points, and the
// money changes hands outside the app. The social-proof copy below has to quote a figure, so it
// picks one here. Change this single constant if the business rate differs.
const VND_PER_POINT = 50_000

// Dot-grouped VND, written by hand rather than via toLocaleString so the output can't shift with
// the runtime's ICU build.
const formatVnd = (points: number) =>
  `${String(points * VND_PER_POINT).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`

// --- persona definitions ----------------------------------------------------

interface OrderSpec {
  /** Stable handle used for cross-references in this file only. */
  key: string
  fullName: string
  phone: string
  orderCode: string
  activationCode: string
  note: string | null
  status: OrderStatus
  createdDaysAgo: number
  /** APPROVED/REJECTED only: when the admin decided. */
  decidedDaysAgo?: number
  /** NEEDS_REVISION only. */
  revisionReason?: string
}

interface PersonaSpec {
  key: string
  phone: string
  fullName: string
  /** persona key of the referrer; null = root CTV (created by the admin, PRD FR1). */
  referrer: string | null
  registeredMonthsAgo: number
  isActive?: boolean
  orders: OrderSpec[]
  redemption?: { f?: number; g?: number; note: string; daysAgo: number }
}

const PERSONAS: PersonaSpec[] = [
  {
    key: 'bao',
    phone: '0123000001',
    fullName: `${DEMO_NAME_PREFIX}Trần Quốc Bảo`,
    referrer: null,
    registeredMonthsAgo: 8,
    // bao-1 → bao-2 leaves a 140-day gap with no APPROVED order — long enough that the rolling
    // 3-month window empties out and period 5 gets a real MAINTENANCE_RESET (verified against
    // planMaintenance directly), before bao-2's approval refills the window and periods 6-8
    // accrue normally again. Requested explicitly: the flagship persona should also show the
    // "tài khoản lâu ngày bị trừ thưởng rồi hồi phục" case, not just Hạnh's (KB-02).
    orders: [
      { key: 'bao-1', fullName: 'Nguyễn Văn Tùng', phone: '0123456001', orderCode: 'DH-2025-1180', activationCode: 'KH-4471', note: 'Đơn Nhật Bản – cơ khí', status: 'APPROVED', createdDaysAgo: 215, decidedDaysAgo: 210 },
      { key: 'bao-2', fullName: 'Trần Thị Loan', phone: '0123456002', orderCode: 'DH-2026-0233', activationCode: 'KH-5120', note: 'Đơn Đài Loan – điện tử', status: 'APPROVED', createdDaysAgo: 74, decidedDaysAgo: 70 },
      { key: 'bao-3', fullName: 'Phạm Quang Huy', phone: '0123456003', orderCode: 'DH-2026-0641', activationCode: 'KH-6033', note: 'Đơn Hàn Quốc – nông nghiệp', status: 'APPROVED', createdDaysAgo: 24, decidedDaysAgo: 20 },
      { key: 'bao-4', fullName: 'Lê Thị Bích', phone: '0123456004', orderCode: 'DH-2026-0102', activationCode: 'KH-4998', note: 'Khách đổi ý, không xuất cảnh', status: 'REJECTED', createdDaysAgo: 152, decidedDaysAgo: 150 },
    ],
    redemption: { f: 100, g: 30, note: 'Đã chi tiền mặt đợt tháng 6/2026', daysAgo: 12 },
  },
  {
    key: 'hanh',
    phone: '0123000002',
    fullName: `${DEMO_NAME_PREFIX}Nguyễn Thị Hạnh`,
    referrer: 'bao',
    registeredMonthsAgo: 6,
    // The "reset rồi hồi phục" persona: an early win, then a dry spell long enough for the
    // rolling window to wipe G, then a fresh approval that keeps it accruing again. Her ledger is
    // the one to open when checking that MAINTENANCE_RESET renders correctly mid-history.
    orders: [
      { key: 'hanh-1', fullName: 'Đinh Văn Nam', phone: '0123456011', orderCode: 'DH-2026-0044', activationCode: 'KH-5501', note: null, status: 'APPROVED', createdDaysAgo: 158, decidedDaysAgo: 155 },
      { key: 'hanh-2', fullName: 'Hoàng Thị Yến', phone: '0123456012', orderCode: 'DH-2026-0455', activationCode: 'KH-5877', note: 'Đơn Nhật Bản – thực phẩm', status: 'APPROVED', createdDaysAgo: 65, decidedDaysAgo: 61 },
      { key: 'hanh-3', fullName: 'Vũ Đình Phúc', phone: '0123456013', orderCode: 'DH-2026-0788', activationCode: 'KH-6210', note: 'Bổ sung hộ chiếu sau', status: 'NEEDS_REVISION', createdDaysAgo: 9, revisionReason: 'Mã kích hoạt không khớp với hồ sơ, vui lòng kiểm tra lại' },
    ],
    redemption: { f: 40, note: 'Đã chi tiền mặt đợt tháng 7/2026', daysAgo: 5 },
  },
  {
    key: 'khoi',
    phone: '0123000003',
    fullName: `${DEMO_NAME_PREFIX}Lê Minh Khôi`,
    referrer: 'bao',
    registeredMonthsAgo: 5,
    orders: [
      { key: 'khoi-1', fullName: 'Ngô Văn Kiên', phone: '0123456021', orderCode: 'DH-2026-0512', activationCode: 'KH-5990', note: 'Hồ sơ chưa đủ điều kiện', status: 'REJECTED', createdDaysAgo: 70, decidedDaysAgo: 68 },
    ],
  },
  {
    key: 'trang',
    phone: '0123000004',
    fullName: `${DEMO_NAME_PREFIX}Phạm Thu Trang`,
    referrer: 'bao',
    registeredMonthsAgo: 4,
    orders: [],
  },
  {
    key: 'tuan',
    phone: '0123000009',
    fullName: `${DEMO_NAME_PREFIX}Hoàng Anh Tuấn`,
    referrer: 'bao',
    registeredMonthsAgo: 4,
    orders: [
      // Decided inside the CURRENT rolling window on purpose — Tuấn is the "PENDING cap" persona,
      // so his G wallet must stay healthy and out of the at-risk list.
      { key: 'tuan-0', fullName: 'Lý Văn Đại', phone: '0123456031', orderCode: 'DH-2026-0390', activationCode: 'KH-5744', note: null, status: 'APPROVED', createdDaysAgo: 49, decidedDaysAgo: 45 },
      { key: 'tuan-1', fullName: 'Trịnh Thị Nga', phone: '0123456032', orderCode: 'DH-2026-0801', activationCode: 'KH-6301', note: 'Đơn 1/5 đang chờ duyệt', status: 'PENDING', createdDaysAgo: 8 },
      { key: 'tuan-2', fullName: 'Bùi Văn Lợi', phone: '0123456033', orderCode: 'DH-2026-0802', activationCode: 'KH-6302', note: 'Đơn 2/5 đang chờ duyệt', status: 'PENDING', createdDaysAgo: 7 },
      { key: 'tuan-3', fullName: 'Đặng Thị Hoa', phone: '0123456034', orderCode: 'DH-2026-0803', activationCode: 'KH-6303', note: 'Đơn 3/5 đang chờ duyệt', status: 'PENDING', createdDaysAgo: 6 },
      { key: 'tuan-4', fullName: 'Chu Minh Hiếu', phone: '0123456035', orderCode: 'DH-2026-0804', activationCode: 'KH-6304', note: 'Đơn 4/5 đang chờ duyệt', status: 'PENDING', createdDaysAgo: 5 },
      { key: 'tuan-5', fullName: 'Tạ Thị Vân', phone: '0123456036', orderCode: 'DH-2026-0805', activationCode: 'KH-6305', note: 'Đơn 5/5 – đã chạm trần PENDING', status: 'PENDING', createdDaysAgo: 4 },
    ],
  },
  {
    key: 'lam',
    phone: '0123000010',
    fullName: `${DEMO_NAME_PREFIX}Trịnh Bảo Lâm`,
    referrer: 'bao',
    registeredMonthsAgo: 3,
    isActive: false,
    orders: [],
  },
  {
    key: 'dang',
    phone: '0123000005',
    fullName: `${DEMO_NAME_PREFIX}Vũ Hải Đăng`,
    referrer: 'hanh',
    registeredMonthsAgo: 2,
    orders: [
      { key: 'dang-1', fullName: 'Nguyễn Thị Thắm', phone: '0123456041', orderCode: 'DH-2026-0777', activationCode: 'KH-6155', note: 'Đơn đầu tiên của CTV mới', status: 'PENDING', createdDaysAgo: 3 },
    ],
  },
  {
    key: 'mai',
    phone: '0123000006',
    fullName: `${DEMO_NAME_PREFIX}Đỗ Thanh Mai`,
    referrer: 'hanh',
    registeredMonthsAgo: 0, // overridden below to 10 days
    orders: [
      { key: 'mai-1', fullName: 'Phan Văn Thọ', phone: '0123456051', orderCode: 'DH-2026-0900', activationCode: 'KH-6400', note: 'Nháp – chưa gửi duyệt', status: 'DRAFT', createdDaysAgo: 2 },
    ],
  },
  {
    key: 'son',
    phone: '0123000007',
    fullName: `${DEMO_NAME_PREFIX}Bùi Văn Sơn`,
    referrer: 'khoi',
    registeredMonthsAgo: 3,
    orders: [
      { key: 'son-1', fullName: 'Mai Văn Hùng', phone: '0123456061', orderCode: 'DH-2026-0688', activationCode: 'KH-6088', note: 'Đơn Đài Loan – xây dựng', status: 'APPROVED', createdDaysAgo: 35, decidedDaysAgo: 31 },
    ],
  },
  {
    key: 'chi',
    phone: '0123000008',
    fullName: `${DEMO_NAME_PREFIX}Ngô Kim Chi`,
    referrer: 'trang',
    registeredMonthsAgo: 1,
    orders: [
      { key: 'chi-1', fullName: 'Hà Thị Duyên', phone: '0123456071', orderCode: 'DH-2026-0850', activationCode: 'KH-6350', note: 'Sai thông tin khách hàng', status: 'REJECTED', createdDaysAgo: 14, decidedDaysAgo: 12 },
    ],
  },
]

// Mai registered 10 days ago, not a whole month — expressed here rather than as a fractional
// `registeredMonthsAgo`, which the anniversary math has no meaning for.
const REGISTERED_DAYS_AGO_OVERRIDE: Record<string, number> = { mai: 10 }

// --- social-proof posts ("Thành tích CTV") ----------------------------------

// Real uploads from the company's WordPress library — the only images a seed script can reach,
// since the WP REST API 404s anonymous requests and so nothing new can be uploaded from here.
// They are wallpaper for UI testing ONLY: the copy attached to each post is invented and is in no
// way a caption of what the picture actually shows (most of these are licence scans and cohort
// group photos). `wp_media_id` stays NULL because these were not uploaded through the app.
const WP_UPLOADS = 'https://xklddieuduong.vn/wp-content/uploads'
const DEMO_IMAGES = [
  `${WP_UPLOADS}/2025/10/12.jpg`,
  `${WP_UPLOADS}/2025/10/14.jpg`,
  `${WP_UPLOADS}/2025/10/13.jpg`,
  `${WP_UPLOADS}/2025/09/1.jpg`,
  `${WP_UPLOADS}/2025/10/15-2.jpg`,
  `${WP_UPLOADS}/2025/10/16-5.jpg`,
  `${WP_UPLOADS}/2025/10/1.jpg`,
  `${WP_UPLOADS}/2025/10/2.jpg`,
  `${WP_UPLOADS}/2025/10/3.jpg`,
  `${WP_UPLOADS}/2025/10/4.jpg`,
  `${WP_UPLOADS}/2025/10/5.jpg`,
  `${WP_UPLOADS}/2025/10/6.jpg`,
  `${WP_UPLOADS}/2025/10/7.jpg`,
  `${WP_UPLOADS}/2025/10/8.jpg`,
  `${WP_UPLOADS}/2025/10/9.jpg`,
  `${WP_UPLOADS}/2025/10/10.jpg`,
  `${WP_UPLOADS}/2025/10/11.jpg`,
]

interface PostSpec {
  honorific: 'Anh' | 'Chị'
  name: string
  /** Points redeemed; the cash figure in the title is derived at VND_PER_POINT. */
  points: number
  daysAgo: number
  blurb: string
  /** Defaults to true. `false` rows exist to prove the public feed filters them out. */
  published?: boolean
}

// 24 published + 3 hidden. The public feed pages at 20, so 24 forces a real second page; the 3
// hidden rows must never show up there, only in the admin list.
const DEMO_POSTS: PostSpec[] = [
  // The first two mirror redemptions that genuinely exist in the seeded ledger, so a PO who opens
  // Bảo's or Hạnh's point history sees the matching REDEMPTION row.
  { honorific: 'Anh', name: 'Trần Quốc Bảo', points: 130, daysAgo: 12, blurb: 'CTV gốc của hệ thống, 8 tháng đồng hành. Quy đổi trọn 100 điểm ví F và 30 điểm ví G trong đợt chi tháng 6/2026.' },
  { honorific: 'Chị', name: 'Nguyễn Thị Hạnh', points: 40, daysAgo: 5, blurb: 'Giới thiệu đều đặn từ đầu năm, nhận thưởng đợt tháng 7/2026 ngay sau khi đơn khách thứ hai được duyệt.' },
  { honorific: 'Anh', name: 'Phạm Văn Cường', points: 200, daysAgo: 18, blurb: 'Dẫn đầu khu vực Bắc Trung Bộ quý II/2026 với 4 khách xuất cảnh thị trường Nhật Bản.' },
  { honorific: 'Chị', name: 'Lê Thị Hồng Nhung', points: 150, daysAgo: 23, blurb: 'Ba khách đi Đài Loan trong cùng một quý, cộng thêm hoa hồng từ hai CTV tuyến dưới.' },
  { honorific: 'Anh', name: 'Nguyễn Hữu Thắng', points: 100, daysAgo: 27, blurb: 'Hai khách xuất cảnh đơn hàng cơ khí, quy đổi ngay khi đủ điều kiện mở khoá.' },
  { honorific: 'Chị', name: 'Đặng Thu Hà', points: 250, daysAgo: 31, blurb: 'CTV xuất sắc nhất tháng 6/2026 — 5 khách xuất cảnh và mạng lưới 6 CTV tuyến dưới.' },
  { honorific: 'Anh', name: 'Vũ Đình Long', points: 90, daysAgo: 36, blurb: 'Chuyển đổi thành công nhóm khách quen sang đơn hàng nông nghiệp Hàn Quốc.' },
  { honorific: 'Chị', name: 'Trịnh Mai Phương', points: 120, daysAgo: 40, blurb: 'Giữ nhịp giới thiệu đều 8 tháng liên tiếp, không tháng nào bị đặt lại ví G.' },
  { honorific: 'Anh', name: 'Hoàng Minh Đức', points: 60, daysAgo: 44, blurb: 'CTV mới 4 tháng đã có khách đầu tiên xuất cảnh, mở khoá đổi thưởng ngay chu kỳ đầu.' },
  { honorific: 'Chị', name: 'Bùi Thị Kim Oanh', points: 300, daysAgo: 49, blurb: 'Mốc quy đổi cao nhất từ trước tới nay của hệ thống, tích luỹ trong 11 tháng.' },
  { honorific: 'Anh', name: 'Ngô Thanh Tùng', points: 80, daysAgo: 54, blurb: 'Hai khách đơn hàng xây dựng Đài Loan, nhận thưởng đợt chi tháng 5/2026.' },
  { honorific: 'Chị', name: 'Dương Thị Lệ Thu', points: 160, daysAgo: 58, blurb: 'Xây được nhánh tuyến dưới 4 người, phần lớn điểm đến từ hoa hồng giới thiệu.' },
  { honorific: 'Anh', name: 'Lý Văn Hiếu', points: 110, daysAgo: 63, blurb: 'Khách đơn hàng thực phẩm Nhật Bản xuất cảnh đúng hẹn, quy đổi trong tháng.' },
  { honorific: 'Chị', name: 'Phan Ngọc Ánh', points: 70, daysAgo: 68, blurb: 'CTV khu vực Bến Tre, khách đầu tiên xuất cảnh sau 3 tháng tham gia.' },
  { honorific: 'Anh', name: 'Đỗ Quang Vinh', points: 140, daysAgo: 73, blurb: 'Ba khách xuất cảnh liên tiếp trong quý I/2026, giữ ví G không lần nào bị reset.' },
  { honorific: 'Chị', name: 'Nguyễn Thị Bích Ngọc', points: 50, daysAgo: 78, blurb: 'Quy đổi lần đầu ngay sau khi khách đầu tiên được duyệt xuất cảnh.' },
  { honorific: 'Anh', name: 'Trương Bá Khoa', points: 180, daysAgo: 84, blurb: 'CTV kỳ cựu khu vực Tây Nguyên, mạng lưới tuyến dưới 5 người đang hoạt động.' },
  { honorific: 'Chị', name: 'Hồ Thị Thanh Trúc', points: 95, daysAgo: 90, blurb: 'Hai khách đi Nhật ngành điện tử, nhận thưởng đợt chi quý I/2026.' },
  { honorific: 'Anh', name: 'Cao Văn Nghĩa', points: 220, daysAgo: 96, blurb: 'Bốn khách xuất cảnh trong 6 tháng, thuộc nhóm 3 CTV dẫn đầu toàn hệ thống.' },
  { honorific: 'Chị', name: 'Vương Thị Hạnh Dung', points: 65, daysAgo: 103, blurb: 'CTV bán thời gian, duy trì đều một khách mỗi quý từ khi tham gia.' },
  { honorific: 'Anh', name: 'Lâm Tuấn Anh', points: 175, daysAgo: 110, blurb: 'Ba khách xuất cảnh cộng hoa hồng từ hai CTV do chính anh giới thiệu vào hệ thống.' },
  { honorific: 'Chị', name: 'Tạ Thị Mỹ Linh', points: 85, daysAgo: 118, blurb: 'Khách đơn hàng điều dưỡng Kaigo xuất cảnh tháng 4/2026.' },
  { honorific: 'Anh', name: 'Chu Đăng Khoa', points: 130, daysAgo: 126, blurb: 'Quy đổi sau khi hoàn tất hai đơn hàng cơ khí và một đơn nông nghiệp.' },
  { honorific: 'Chị', name: 'Nguyễn Hoài Thương', points: 105, daysAgo: 134, blurb: 'CTV khu vực Hà Nội, hai khách xuất cảnh trong quý IV/2025.' },

  // Hidden rows — must be invisible on the CTV app, visible (and toggleable) in admin.
  { honorific: 'Anh', name: 'Bài ẩn – chờ duyệt nội dung', points: 100, daysAgo: 3, blurb: 'Bài này đang ở trạng thái ẩn (published = 0). Nếu nó hiện trên app CTV thì bộ lọc publishedOnly đang sai.', published: false },
  { honorific: 'Chị', name: 'Bài ẩn – sai thông tin', points: 75, daysAgo: 15, blurb: 'Bài bị admin ẩn sau khi phát hiện sai số liệu. Dùng để test nút bật/tắt hiển thị ở màn admin.', published: false },
  { honorific: 'Anh', name: 'Bài ẩn – ảnh hỏng', points: 55, daysAgo: 29, blurb: 'Bài ẩn có URL ảnh không tồn tại, để kiểm tra fallback ImageOff của PostImage khi bật hiển thị.', published: false },
]

// The last hidden row deliberately points at a URL that 404s, so the image-error fallback can be
// exercised without touching any of the working images.
const BROKEN_IMAGE_INDEX = DEMO_POSTS.length - 1
const BROKEN_IMAGE_URL = `${WP_UPLOADS}/2025/10/khong-ton-tai.jpg`

// --- CTV guides ("Hướng dẫn CTV") --------------------------------------------

interface GuideSpec {
  title: string
  blurb: string
  daysAgo: number
  /** Defaults to true. `false` rows exist to prove the public feed filters them out. */
  published?: boolean
}

// 24 published + 3 hidden — same shape as DEMO_POSTS, deliberately: the public feed pages at 20,
// so 24 forces a real second page; the 3 hidden rows must never show up there, only in admin.
const DEMO_GUIDES: GuideSpec[] = [
  { title: 'Cách chốt đơn nhanh trong 24 giờ', daysAgo: 4, blurb: 'Ba bước chuẩn bị hồ sơ trước khi gặp khách để rút ngắn thời gian duyệt: xác minh giấy tờ gốc, chốt mã kích hoạt, và chụp ảnh hồ sơ rõ nét ngay tại chỗ.' },
  { title: 'Kịch bản tư vấn khách hàng lần đầu', daysAgo: 9, blurb: 'Mẫu câu hỏi mở đầu, cách giải thích quy trình xuất cảnh bằng ngôn ngữ dễ hiểu, và cách xử lý câu hỏi về chi phí.' },
  { title: 'Checklist hồ sơ trước khi gửi duyệt', daysAgo: 15, blurb: 'Danh sách 6 mục cần kiểm tra trước khi bấm gửi duyệt để tránh bị admin yêu cầu bổ sung.' },
  { title: 'Cách xử lý khi đơn bị yêu cầu bổ sung', daysAgo: 20, blurb: 'Đọc đúng lý do admin ghi, sửa đúng chỗ, và gửi lại trong vòng 24 giờ để không mất lượt.' },
  { title: 'Bí quyết giữ ví G không bị đặt lại', daysAgo: 26, blurb: 'Ví G bị đặt lại nếu 3 tháng liền không có đơn được duyệt — mẹo duy trì ít nhất một khách mỗi quý.' },
  { title: 'Cách chia sẻ link giới thiệu hiệu quả', daysAgo: 33, blurb: 'Nên gửi link mời qua Zalo cá nhân kèm một câu giới thiệu ngắn thay vì đăng công khai lên nhóm đông người.' },
  { title: 'Câu hỏi thường gặp về quy đổi điểm', daysAgo: 41, blurb: 'Điểm ví F và ví G khác nhau thế nào, khi nào được mở khoá đổi thưởng, và thời gian nhận tiền sau khi quy đổi.' },
  { title: 'Lưu ý khi khách chọn thị trường Nhật Bản', daysAgo: 48, blurb: 'Yêu cầu hồ sơ riêng cho thị trường Nhật, thời gian xử lý visa, và các lỗi hồ sơ thường gặp nhất.' },
  { title: 'Lưu ý khi khách chọn thị trường Đài Loan', daysAgo: 56, blurb: 'Khác biệt về giấy tờ so với thị trường Nhật, và mốc thời gian khách cần nắm trước khi xuất cảnh.' },
  { title: 'Cách xây dựng mạng lưới CTV tuyến dưới', daysAgo: 64, blurb: 'Khi nào nên mời người quen tham gia làm CTV, và cách hỗ trợ CTV mới trong tháng đầu tiên.' },
  { title: 'Hướng dẫn điền mã kích hoạt đúng chuẩn', daysAgo: 72, blurb: 'Mã kích hoạt sai định dạng là lý do phổ biến nhất khiến đơn bị yêu cầu bổ sung — cách kiểm tra trước khi gửi.' },
  { title: 'Cách đọc thông báo "Đơn cần bổ sung"', daysAgo: 79, blurb: 'Phân biệt lý do do thiếu giấy tờ, sai thông tin, hay mã kích hoạt không khớp — mỗi loại xử lý khác nhau.' },
  { title: 'Quy trình xử lý khi khách đổi ý không xuất cảnh', daysAgo: 85, blurb: 'Các bước cần làm ngay khi khách huỷ giữa chừng để đơn được từ chối đúng quy trình, không treo trạng thái.' },
  { title: 'Mẹo giữ liên lạc với khách sau khi gửi hồ sơ', daysAgo: 92, blurb: 'Tần suất nhắn tin hợp lý trong thời gian chờ duyệt để khách không sốt ruột mà cũng không thấy làm phiền.' },
  { title: 'Cách trả lời khi khách hỏi về thời gian chờ visa', daysAgo: 98, blurb: 'Khung thời gian tham khảo theo từng thị trường và cách trả lời khi có phát sinh chậm trễ.' },
  { title: 'Những lỗi hồ sơ khiến đơn bị từ chối nhiều nhất', daysAgo: 105, blurb: 'Tổng hợp 5 lỗi thường gặp nhất từ dữ liệu thực tế, xếp theo tần suất.' },
  { title: 'Cách tính điểm thưởng ví F và ví G', daysAgo: 112, blurb: 'Công thức cộng điểm khi khách xuất cảnh, khi giới thiệu CTV mới, và điểm duy trì hàng tháng.' },
  { title: 'Hướng dẫn sử dụng bộ lọc trong Sổ điểm', daysAgo: 118, blurb: 'Lọc theo ví, loại giao dịch, khoảng ngày và tìm theo tên/mã đơn để tự đối chiếu số dư nhanh hơn.' },
  { title: 'Khi nào nên tạo tài khoản CTV mới cho người quen', daysAgo: 125, blurb: 'Những dấu hiệu cho thấy một người quen phù hợp để mời làm CTV tuyến dưới, và cách hỗ trợ tháng đầu.' },
  { title: 'Lưu ý khi khách chọn thị trường Hàn Quốc', daysAgo: 132, blurb: 'Yêu cầu riêng về hồ sơ nông nghiệp/sản xuất, và các mốc thời gian khách cần nắm.' },
  { title: 'Cách xử lý khách yêu cầu hoàn tiền đặt cọc', daysAgo: 138, blurb: 'Quy trình phối hợp với admin khi khách yêu cầu hoàn cọc trước khi xuất cảnh.' },
  { title: 'Hướng dẫn đổi mật khẩu và khôi phục khi quên', daysAgo: 145, blurb: 'Các bước tự đổi mật khẩu, và cách liên hệ admin để được cấp mật khẩu tạm khi quên.' },
  { title: 'Mẹo duy trì phong độ CTV trong mùa thấp điểm', daysAgo: 152, blurb: 'Cách giữ ví G không bị đặt lại và duy trì mạng lưới giới thiệu vào những tháng ít khách.' },
  { title: 'Tổng hợp câu hỏi thường gặp từ CTV mới', daysAgo: 160, blurb: 'Giải đáp nhanh những thắc mắc phổ biến nhất trong tháng đầu tiên làm CTV.' },

  // Hidden rows — must be invisible on the CTV app, visible (and toggleable) in admin.
  { title: 'Nháp – hướng dẫn quy trình mới đang biên tập', daysAgo: 2, blurb: 'Bài này đang ở trạng thái ẩn (published = 0). Nếu nó hiện trên app CTV thì bộ lọc publishedOnly đang sai.', published: false },
  { title: 'Bản cũ – đã thay bằng hướng dẫn mới', daysAgo: 70, blurb: 'Bài bị admin ẩn sau khi quy trình thay đổi. Dùng để test nút bật/tắt hiển thị ở màn admin.', published: false },
  { title: 'Bài ẩn – ảnh hỏng', daysAgo: 30, blurb: 'Bài ẩn có URL ảnh không tồn tại, để kiểm tra fallback ImageOff của GuideImage khi bật hiển thị.', published: false },
]

// The last hidden row deliberately points at a URL that 404s, mirroring DEMO_POSTS' broken-image
// case, so the image-error fallback can be exercised without touching any of the working images.
const GUIDE_BROKEN_IMAGE_INDEX = DEMO_GUIDES.length - 1
const GUIDE_BROKEN_IMAGE_URL = `${WP_UPLOADS}/2025/10/khong-ton-tai-huong-dan.jpg`

// --- SQL helpers ------------------------------------------------------------

const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const qn = (v: string | null) => (v === null ? 'NULL' : q(v))

const NOW = new Date()

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000)
}

/** `n` months back from now, day clamped exactly like anniversaryDate (month-end safety). */
function monthsAgo(n: number): Date {
  const day = NOW.getUTCDate()
  const target = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, 1))
  const daysInMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, daysInMonth),
      NOW.getUTCHours(), NOW.getUTCMinutes(), NOW.getUTCSeconds()),
  )
}

/** The cron fires 01:00 UTC daily, so a period's rows land at 01:00 on its anniversary date. */
function cronRunAt(anniversary: Date): string {
  return new Date(Date.UTC(
    anniversary.getUTCFullYear(), anniversary.getUTCMonth(), anniversary.getUTCDate(), 1, 0, 0,
  )).toISOString()
}

const READ_CUTOFF = daysAgo(READ_CUTOFF_DAYS).toISOString()

const statements: string[] = []

function insertLedger(row: {
  id: string; userId: string; wallet: 'F' | 'G'; type: string; points: number
  orderId?: string | null; subjectUserId?: string | null; periodIndex?: number | null
  idempotencyKey?: string | null; note?: string | null; createdBy?: string | null; createdAt: string
}): void {
  statements.push(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, idempotency_key, note, created_by, created_at) VALUES (` +
      [q(row.id), q(row.userId), q(row.wallet), q(row.type), String(row.points),
        qn(row.orderId ?? null), qn(row.subjectUserId ?? null),
        row.periodIndex == null ? 'NULL' : String(row.periodIndex),
        qn(row.idempotencyKey ?? null), qn(row.note ?? null), qn(row.createdBy ?? null),
        q(row.createdAt)].join(', ') +
      `);`,
  )
}

function insertNotification(row: {
  userId: string; type: string; title: string; body: string
  orderId?: string | null; ledgerId?: string | null; periodIndex?: number | null; createdAt: string
}): void {
  const readAt = row.createdAt < READ_CUTOFF ? q(row.createdAt) : 'NULL'
  statements.push(
    `INSERT INTO notifications (id, user_id, type, title, body, order_id, ledger_id, period_index, read_at, created_at) VALUES (` +
      [q(crypto.randomUUID()), q(row.userId), q(row.type), q(row.title), q(row.body),
        qn(row.orderId ?? null), qn(row.ledgerId ?? null),
        row.periodIndex == null ? 'NULL' : String(row.periodIndex),
        readAt, q(row.createdAt)].join(', ') +
      `);`,
  )
}

function insertOrderEvent(orderId: string, type: string, actorId: string, reason: string | null, at: string): void {
  statements.push(
    `INSERT INTO order_events (id, order_id, type, actor_id, reason, created_at) VALUES (` +
      [q(crypto.randomUUID()), q(orderId), q(type), q(actorId), qn(reason), q(at)].join(', ') + `);`,
  )
}

// --- purge ------------------------------------------------------------------

// FK-safe order: notifications (references orders + point_ledger) → order_events → point_ledger
// → orders → password_reset_log → users. The notification sweep deliberately also catches rows
// owned by the SUPER ADMIN that point at a demo order (every ORDER_CREATED alert).
function purgeSql(): string[] {
  const demoUsers = `SELECT id FROM users WHERE phone LIKE '${DEMO_PHONE_PREFIX}%'`
  const demoOrders = `SELECT id FROM orders WHERE user_id IN (${demoUsers})`
  const demoLedger = `SELECT id FROM point_ledger WHERE user_id IN (${demoUsers})`
  return [
    `DELETE FROM notifications WHERE user_id IN (${demoUsers}) OR order_id IN (${demoOrders}) OR ledger_id IN (${demoLedger});`,
    `DELETE FROM order_events WHERE order_id IN (${demoOrders});`,
    `DELETE FROM point_ledger WHERE user_id IN (${demoUsers}) OR subject_user_id IN (${demoUsers}) OR order_id IN (${demoOrders});`,
    `DELETE FROM orders WHERE user_id IN (${demoUsers});`,
    `DELETE FROM password_reset_log WHERE user_id IN (${demoUsers});`,
    `DELETE FROM users WHERE phone LIKE '${DEMO_PHONE_PREFIX}%';`,
    // Posts/guides hang off the super admin, not off a demo user, so the title prefix is the only
    // handle that distinguishes them from real content the admin may have published.
    `DELETE FROM posts WHERE title LIKE '${DEMO_NAME_PREFIX}%';`,
    `DELETE FROM guides WHERE title LIKE '${DEMO_NAME_PREFIX}%';`,
  ]
}

// --- build ------------------------------------------------------------------

interface BuiltUser {
  id: string
  spec: PersonaSpec
  registeredAt: Date
  referrerId: string | null
  approvedDates: Date[]
}

async function build(adminId: string): Promise<Map<string, BuiltUser>> {
  const users = new Map<string, BuiltUser>()

  // Pass 1: users + registration bonuses. Order matters (a referrer must exist first), which the
  // PERSONAS array already respects.
  for (const spec of PERSONAS) {
    const registeredAt =
      REGISTERED_DAYS_AGO_OVERRIDE[spec.key] !== undefined
        ? daysAgo(REGISTERED_DAYS_AGO_OVERRIDE[spec.key])
        : monthsAgo(spec.registeredMonthsAgo)
    const referrerId = spec.referrer ? users.get(spec.referrer)!.id : null
    const built: BuiltUser = { id: crypto.randomUUID(), spec, registeredAt, referrerId, approvedDates: [] }
    users.set(spec.key, built)

    const createdAt = registeredAt.toISOString()
    statements.push(
      `INSERT INTO users (id, full_name, phone, password_hash, role, referrer_id, referral_code, is_active, created_at) VALUES (` +
        [q(built.id), q(spec.fullName), q(spec.phone), q(await hashPassword(DEMO_PASSWORD)), q('USER'),
          qn(referrerId), q(spec.phone), spec.isActive === false ? '0' : '1', q(createdAt)].join(', ') +
        `);`,
    )

    // Registration bonuses, exactly as createUser() lays them out: +10 F to the registrant, and
    // +2 F to the referrer (root CTV has none — the admin who creates them earns nothing, A2).
    insertLedger({
      id: crypto.randomUUID(), userId: built.id, wallet: 'F', type: 'REGISTRATION_BONUS',
      points: POINTS.REGISTRATION, subjectUserId: built.id, createdAt,
    })
    if (referrerId) {
      const ledgerId = crypto.randomUUID()
      insertLedger({
        id: ledgerId, userId: referrerId, wallet: 'F', type: 'REFERRAL_SIGNUP_BONUS',
        points: POINTS.REFERRAL_SIGNUP, subjectUserId: built.id, createdAt,
      })
      const m = referralSignupBonusMessage()
      insertNotification({ userId: referrerId, type: 'REFERRAL_SIGNUP_BONUS', title: m.title, body: m.body, ledgerId, createdAt })
    }
  }

  // Pass 2: orders, their event log, approval bonuses and the notifications each transition fires.
  for (const built of users.values()) {
    for (const o of built.spec.orders) {
      const orderId = crypto.randomUUID()
      const createdAt = daysAgo(o.createdDaysAgo).toISOString()
      const decidedAt = o.decidedDaysAgo !== undefined ? daysAgo(o.decidedDaysAgo).toISOString() : null
      // DRAFT was never submitted, so it never moved; everything else last moved on its decision
      // (or, for PENDING/NEEDS_REVISION, on submit/kickback).
      const submittedAt = o.status === 'DRAFT' ? null : new Date(daysAgo(o.createdDaysAgo).getTime() + 3_600_000).toISOString()
      const revisionAt = o.status === 'NEEDS_REVISION' ? new Date(daysAgo(o.createdDaysAgo).getTime() + 7_200_000).toISOString() : null
      const updatedAt = decidedAt ?? revisionAt ?? submittedAt ?? createdAt

      statements.push(
        `INSERT INTO orders (id, user_id, full_name, phone, order_code, activation_code, note, status, revision_reason, decided_by, decided_at, created_at, updated_at) VALUES (` +
          [q(orderId), q(built.id), q(o.fullName), q(o.phone), q(o.orderCode), q(o.activationCode), qn(o.note),
            q(o.status), qn(o.revisionReason ?? null),
            decidedAt ? q(adminId) : 'NULL', qn(decidedAt), q(createdAt), q(updatedAt)].join(', ') +
          `);`,
      )

      if (submittedAt) {
        insertOrderEvent(orderId, 'SUBMITTED', built.id, null, submittedAt)
        const m = orderCreatedMessage(o.note)
        insertNotification({ userId: adminId, type: 'ORDER_CREATED', title: m.title, body: m.body, orderId, createdAt: submittedAt })
      }

      if (o.status === 'NEEDS_REVISION') {
        insertOrderEvent(orderId, 'REVISION_REQUESTED', adminId, o.revisionReason!, revisionAt!)
        const m = orderNeedsRevisionMessage(o.revisionReason!)
        insertNotification({ userId: built.id, type: 'ORDER_NEEDS_REVISION', title: m.title, body: m.body, orderId, createdAt: revisionAt! })
      }

      if (o.status === 'REJECTED') {
        insertOrderEvent(orderId, 'REJECTED', adminId, null, decidedAt!)
        const m = orderRejectedMessage(o.note)
        insertNotification({ userId: built.id, type: 'ORDER_REJECTED', title: m.title, body: m.body, orderId, createdAt: decidedAt! })
      }

      if (o.status === 'APPROVED') {
        built.approvedDates.push(new Date(decidedAt!))
        insertOrderEvent(orderId, 'APPROVED', adminId, null, decidedAt!)

        // +50 F creator / +10 F direct referrer — the referrer leg is skipped when there is no
        // referrer or the referrer is the super admin, exactly like approveOrder's S3 guard.
        insertLedger({
          id: crypto.randomUUID(), userId: built.id, wallet: 'F', type: 'CUSTOMER_REWARD',
          points: POINTS.CUSTOMER_REWARD, orderId, createdAt: decidedAt!,
        })
        const am = orderApprovedMessage(o.note)
        insertNotification({ userId: built.id, type: 'ORDER_APPROVED', title: am.title, body: am.body, orderId, createdAt: decidedAt! })

        if (built.referrerId) {
          const ledgerId = crypto.randomUUID()
          insertLedger({
            id: ledgerId, userId: built.referrerId, wallet: 'F', type: 'CUSTOMER_REFERRAL_BONUS',
            points: POINTS.CUSTOMER_REFERRAL, orderId, createdAt: decidedAt!,
          })
          const rm = customerReferralBonusMessage()
          insertNotification({ userId: built.referrerId, type: 'CUSTOMER_REFERRAL_BONUS', title: rm.title, body: rm.body, ledgerId, createdAt: decidedAt! })
        }
      }
    }
  }

  // Pass 3: replay the monthly cron over the whole backdated history. planMaintenance decides
  // reset-or-not per period from (registeredAt, approvedDates) alone — no run history — so one
  // catch-up call from lastAccruedPeriod = 0 produces exactly what N daily runs would have.
  const gBalance = new Map<string, number>()
  for (const built of users.values()) {
    let g = 0
    const plan = planMaintenance({
      registeredAt: built.registeredAt,
      lastAccruedPeriod: 0,
      approvedOrderDates: built.approvedDates,
      now: NOW,
    })
    for (const item of plan) {
      const at = cronRunAt(anniversaryDate(built.registeredAt, item.periodIndex))
      // A reset is skipped entirely when G is already 0 — a zero-point row would violate
      // `points <> 0` (applyPeriod's own guard).
      if (item.resetRequired && g > 0) {
        const ledgerId = crypto.randomUUID()
        insertLedger({
          id: ledgerId, userId: built.id, wallet: 'G', type: 'MAINTENANCE_RESET',
          points: -g, periodIndex: item.periodIndex, createdAt: at,
        })
        const m = maintenanceResetMessage(item.periodIndex)
        insertNotification({ userId: built.id, type: 'MAINTENANCE_RESET', title: m.title, body: m.body, ledgerId, createdAt: at })
        g = 0
      }
      const ledgerId = crypto.randomUUID()
      insertLedger({
        id: ledgerId, userId: built.id, wallet: 'G', type: 'MAINTENANCE_ACCRUAL',
        points: POINTS.MAINTENANCE, periodIndex: item.periodIndex, createdAt: at,
      })
      g += POINTS.MAINTENANCE
      const m = maintenanceAccrualMessage(item.periodIndex)
      insertNotification({ userId: built.id, type: 'MAINTENANCE_ACCRUAL', title: m.title, body: m.body, ledgerId, createdAt: at })
    }
    gBalance.set(built.key, g)

    // The "sắp bị đặt lại" heads-up, for whoever is standing in the warning zone right now. The
    // cron would have sent it the day the zone opened — anniversary(target - 1).
    const lastAccrued = plan.length ? plan[plan.length - 1].periodIndex : 0
    const warning = planResetWarning({
      registeredAt: built.registeredAt,
      lastAccruedPeriod: lastAccrued,
      approvedOrderDates: built.approvedDates,
      now: NOW,
    })
    if (warning?.warningRequired) {
      const m = maintenanceResetWarningMessage(warning.periodIndex)
      insertNotification({
        userId: built.id, type: 'MAINTENANCE_RESET_WARNING', title: m.title, body: m.body,
        periodIndex: warning.periodIndex,
        createdAt: cronRunAt(anniversaryDate(built.registeredAt, warning.periodIndex - 1)),
      })
    }
  }

  // Pass 4: redemptions (admin deducts points for cash already paid outside the system). Placed
  // last so the wallets they draw from are fully accrued first.
  for (const built of users.values()) {
    const r = built.spec.redemption
    if (!r) continue
    const at = daysAgo(r.daysAgo).toISOString()
    const key = `demo-redemption-${built.spec.phone}`
    const firstId = crypto.randomUUID()
    let first = true
    for (const [wallet, amount] of [['F', r.f], ['G', r.g]] as const) {
      if (!amount) continue
      insertLedger({
        id: first ? firstId : crypto.randomUUID(), userId: built.id, wallet, type: 'REDEMPTION',
        points: -amount, idempotencyKey: key, note: r.note, createdBy: adminId, createdAt: at,
      })
      first = false
    }
    const m = redemptionMessage(r.f ?? 0, r.g ?? 0)
    insertNotification({ userId: built.id, type: 'REDEMPTION', title: m.title, body: m.body, ledgerId: firstId, createdAt: at })
  }

  return users
}

/** Social-proof feed rows. Independent of the personas, so it takes only the admin as author. */
function buildPosts(adminId: string): void {
  DEMO_POSTS.forEach((p, i) => {
    const imageUrl = i === BROKEN_IMAGE_INDEX ? BROKEN_IMAGE_URL : DEMO_IMAGES[i % DEMO_IMAGES.length]
    const title = p.published === false
      ? `${DEMO_NAME_PREFIX}${p.name}`
      : `${DEMO_NAME_PREFIX}${p.honorific} ${p.name} đổi ${p.points} điểm nhận ${formatVnd(p.points)}`

    statements.push(
      `INSERT INTO posts (id, title, description, image_url, wp_media_id, published, created_by, created_at) VALUES (` +
        [q(crypto.randomUUID()), q(title), q(p.blurb), q(imageUrl), 'NULL',
          p.published === false ? '0' : '1', q(adminId), q(daysAgo(p.daysAgo).toISOString())].join(', ') +
        `);`,
    )
  })
}

/** CTV guide feed rows ("Hướng dẫn CTV") — same shape and rules as buildPosts, above. */
function buildGuides(adminId: string): void {
  DEMO_GUIDES.forEach((g, i) => {
    const imageUrl = i === GUIDE_BROKEN_IMAGE_INDEX ? GUIDE_BROKEN_IMAGE_URL : DEMO_IMAGES[i % DEMO_IMAGES.length]
    const title = `${DEMO_NAME_PREFIX}${g.title}`

    statements.push(
      `INSERT INTO guides (id, title, description, image_url, wp_media_id, published, created_by, created_at) VALUES (` +
        [q(crypto.randomUUID()), q(title), q(g.blurb), q(imageUrl), 'NULL',
          g.published === false ? '0' : '1', q(adminId), q(daysAgo(g.daysAgo).toISOString())].join(', ') +
        `);`,
    )
  })
}

// --- run --------------------------------------------------------------------

const wranglerBin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')

function runWrangler(args: string[], local: boolean): string {
  const result = spawnSync(wranglerBin, ['d1', 'execute', 'xkld-db', local ? '--local' : '--remote', ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`
  if (result.status !== 0) {
    console.error(output.trim())
    process.exit(1)
  }
  return output
}

async function main() {
  const { values } = parseArgs({
    options: {
      local: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      'posts-only': { type: 'boolean', default: false },
      'guides-only': { type: 'boolean', default: false },
    },
  })
  const local = values.local as boolean
  const dryRun = values['dry-run'] as boolean
  const purgeOnly = values.purge as boolean
  const postsOnly = values['posts-only'] as boolean
  const guidesOnly = values['guides-only'] as boolean

  const target = local ? 'local' : 'REMOTE (production)'

  if (purgeOnly) {
    const sql = purgeSql().join('\n')
    if (dryRun) {
      console.log(sql)
      return
    }
    const file = join(tmpdir(), `xkld-demo-purge-${Date.now()}.sql`)
    writeFileSync(file, sql)
    runWrangler([`--file=${file}`], local)
    console.log(`✔ DEMO data purged from ${target}`)
    return
  }

  // The super admin is the decider on every seeded order and the recipient of ORDER_CREATED.
  const adminJson = runWrangler(['--json', '--command', `SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1;`], local)
  const adminId: string | undefined = JSON.parse(adminJson.slice(adminJson.indexOf('[')))?.[0]?.results?.[0]?.id
  if (!adminId) {
    console.error('No SUPER_ADMIN found — run `pnpm seed:admin` first.')
    process.exit(1)
  }

  const publishedCount = DEMO_POSTS.filter((p) => p.published !== false).length
  const publishedGuideCount = DEMO_GUIDES.filter((g) => g.published !== false).length

  // Refreshing just the feed must not disturb the accounts: re-running the full seed would move
  // every backdated timestamp to today and hand out new user ids.
  if (postsOnly) {
    buildPosts(adminId)
    const sql = [`DELETE FROM posts WHERE title LIKE '${DEMO_NAME_PREFIX}%';`, ...statements].join('\n')
    if (dryRun) {
      console.log(sql)
      return
    }
    const file = join(tmpdir(), `xkld-demo-posts-${Date.now()}.sql`)
    writeFileSync(file, sql)
    runWrangler([`--file=${file}`], local)
    console.log(`✔ Seeded ${DEMO_POSTS.length} bài "Thành tích CTV" to ${target} (${publishedCount} hiển thị, ${DEMO_POSTS.length - publishedCount} ẩn)`)
    return
  }

  if (guidesOnly) {
    buildGuides(adminId)
    const sql = [`DELETE FROM guides WHERE title LIKE '${DEMO_NAME_PREFIX}%';`, ...statements].join('\n')
    if (dryRun) {
      console.log(sql)
      return
    }
    const file = join(tmpdir(), `xkld-demo-guides-${Date.now()}.sql`)
    writeFileSync(file, sql)
    runWrangler([`--file=${file}`], local)
    console.log(`✔ Seeded ${DEMO_GUIDES.length} bài "Hướng dẫn CTV" to ${target} (${publishedGuideCount} hiển thị, ${DEMO_GUIDES.length - publishedGuideCount} ẩn)`)
    return
  }

  const users = await build(adminId)
  buildPosts(adminId)
  buildGuides(adminId)
  const sql = [...purgeSql(), ...statements].join('\n')

  if (dryRun) {
    console.log(sql)
    return
  }

  const file = join(tmpdir(), `xkld-demo-seed-${Date.now()}.sql`)
  writeFileSync(file, sql)
  runWrangler([`--file=${file}`], local)

  console.log(`✔ Seeded ${users.size} DEMO CTV accounts to ${target}`)
  console.log(`  ${DEMO_POSTS.length} bài "Thành tích CTV" (${publishedCount} hiển thị, ${DEMO_POSTS.length - publishedCount} ẩn)`)
  console.log(`  ${DEMO_GUIDES.length} bài "Hướng dẫn CTV" (${publishedGuideCount} hiển thị, ${DEMO_GUIDES.length - publishedGuideCount} ẩn)`)
  console.log(`  password (all accounts): ${DEMO_PASSWORD}`)
  for (const built of users.values()) {
    const ref = built.spec.referrer ? users.get(built.spec.referrer)!.spec.phone : '(root — không có người giới thiệu)'
    console.log(`  ${built.spec.phone}  ${built.spec.fullName.padEnd(28)} ref: ${ref}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
