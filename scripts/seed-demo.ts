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
// Why raw SQL and not the HTTP API: some of the backdated history (registration months ago,
// customers activated months apart) can't be produced by calling today's endpoints, which always
// timestamp "now". To make sure it's still byte-for-byte what production would have produced,
// this script imports the REAL notification copy (referralSignupBonusMessage, adminBonusMessage,
// etc.) rather than restating any of it.
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashPassword } from '../src/lib/password'
import { POINTS } from '../src/domain/points/constants'
import {
  referralSignupBonusMessage,
  customerReferralBonusMessage,
  adminBonusMessage,
  redemptionMessage,
  customerActivatedMessage,
} from '../src/domain/notifications/messages'
import { DIRECT_ACTIVATION_ORDER_NOTE, DIRECT_ACTIVATION_REDEMPTION_NOTE } from '../src/lib/orders'

const DEMO_PHONE_PREFIX = '0123'
const DEMO_NAME_PREFIX = 'DEMO '
// Tags bonus_grants rows the same way DEMO_PHONE_PREFIX/DEMO_NAME_PREFIX tag users/posts/guides —
// bonus_grants has no user-owned column a broadcast grant's row would show up under (target_user_id
// is NULL for scope=ALL), so idempotency_key is the only column purgeSql can filter on directly.
const DEMO_BONUS_IDEM_PREFIX = 'demo-bonus-'
const DEMO_PASSWORD = 'Demo@2026'
// Notifications older than this are pre-marked read, so the unread badge shows a believable
// handful of recent items instead of months of backlog.
const READ_CUTOFF_DAYS = 45

// The system never stores what a point is worth in cash — redemption only debits points, and the
// money changes hands outside the app. The social-proof copy below has to quote a figure, so it
// picks one here. Change this single constant if the business rate differs.
const VND_PER_POINT = 5_000

// Dot-grouped VND, written by hand rather than via toLocaleString so the output can't shift with
// the runtime's ICU build.
const formatVnd = (points: number) =>
  `${String(points * VND_PER_POINT).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`

// --- persona definitions ----------------------------------------------------

/**
 * One activated customer. There are no draft/pending/rejected orders any more — the admin
 * activates a customer who already paid the CTV in cash, and the row is born APPROVED
 * (see src/lib/orders.ts activateCustomer).
 */
interface CustomerSpec {
  /** Stable handle used for cross-references in this file only. */
  key: string
  fullName: string
  phone: string
  orderCode: string
  /** When the admin activated them. */
  activatedDaysAgo: number
}

interface PersonaSpec {
  key: string
  phone: string
  fullName: string
  /** persona key of the referrer; null = root CTV (created by the admin, PRD FR1). */
  referrer: string | null
  registeredMonthsAgo: number
  isActive?: boolean
  customers: CustomerSpec[]
  redemption?: { f?: number; g?: number; note: string; daysAgo: number }
}

const PERSONAS: PersonaSpec[] = [
  {
    key: 'bao',
    phone: '0123000001',
    fullName: `${DEMO_NAME_PREFIX}Trần Quốc Bảo`,
    referrer: null,
    registeredMonthsAgo: 8,
    // bao-1 → bao-2 leaves a 140-day gap with no APPROVED order — kept as realistic spacing; it
    // no longer drives any G-wallet behavior now that the maintenance cron is gone.
    customers: [
      { key: 'bao-1', fullName: 'Nguyễn Văn Tùng', phone: '0123456001', orderCode: 'DH-2025-1180', activatedDaysAgo: 210 },
      { key: 'bao-2', fullName: 'Trần Thị Loan', phone: '0123456002', orderCode: 'DH-2026-0233', activatedDaysAgo: 70 },
      { key: 'bao-3', fullName: 'Phạm Quang Huy', phone: '0123456003', orderCode: 'DH-2026-0641', activatedDaysAgo: 20 },
    ],
    // g: 80 = the 50 broadcast grant + the 30 individual grant seeded in Pass 3 below — his whole
    // G balance. daysAgo must be after both grants (90 and 8 days ago) so the ledger reads in
    // chronological order.
    redemption: { f: 500, g: 80, note: 'Đã chi tiền mặt đợt tháng 6/2026', daysAgo: 6 },
  },
  {
    key: 'hanh',
    phone: '0123000002',
    fullName: `${DEMO_NAME_PREFIX}Nguyễn Thị Hạnh`,
    referrer: 'bao',
    registeredMonthsAgo: 6,
    // An early win, then a dry spell, then a fresh approval — realistic spacing only; her
    // G-wallet history now comes entirely from the ADMIN_BONUS grants seeded in Pass 3.
    customers: [
      { key: 'hanh-1', fullName: 'Đinh Văn Nam', phone: '0123456011', orderCode: 'DH-2026-0044', activatedDaysAgo: 155 },
      { key: 'hanh-2', fullName: 'Hoàng Thị Yến', phone: '0123456012', orderCode: 'DH-2026-0455', activatedDaysAgo: 61 },
    ],
    redemption: { f: 200, note: 'Đã chi tiền mặt đợt tháng 7/2026', daysAgo: 5 },
  },
  {
    key: 'khoi',
    phone: '0123000003',
    fullName: `${DEMO_NAME_PREFIX}Lê Minh Khôi`,
    referrer: 'bao',
    registeredMonthsAgo: 5,
    customers: [],
  },
  {
    key: 'trang',
    phone: '0123000004',
    fullName: `${DEMO_NAME_PREFIX}Phạm Thu Trang`,
    referrer: 'bao',
    registeredMonthsAgo: 4,
    customers: [],
  },
  {
    key: 'tuan',
    phone: '0123000009',
    fullName: `${DEMO_NAME_PREFIX}Hoàng Anh Tuấn`,
    referrer: 'bao',
    registeredMonthsAgo: 4,
    // The most-customers persona — 4 activations, the newest three within days of each other, so
    // the admin customer list has a CTV worth filtering by. His G wallet stays healthy too.
    customers: [
      { key: 'tuan-0', fullName: 'Lý Văn Đại', phone: '0123456031', orderCode: 'DH-2026-0390', activatedDaysAgo: 45 },
      { key: 'tuan-1', fullName: 'Trịnh Thị Nga', phone: '0123456032', orderCode: 'DH-2026-0801', activatedDaysAgo: 8 },
      { key: 'tuan-2', fullName: 'Bùi Văn Lợi', phone: '0123456033', orderCode: 'DH-2026-0802', activatedDaysAgo: 7 },
      { key: 'tuan-3', fullName: 'Đặng Thị Hoa', phone: '0123456034', orderCode: 'DH-2026-0803', activatedDaysAgo: 6 },
    ],
  },
  {
    key: 'lam',
    phone: '0123000010',
    fullName: `${DEMO_NAME_PREFIX}Trịnh Bảo Lâm`,
    referrer: 'bao',
    registeredMonthsAgo: 3,
    isActive: false,
    customers: [],
  },
  {
    key: 'dang',
    phone: '0123000005',
    fullName: `${DEMO_NAME_PREFIX}Vũ Hải Đăng`,
    referrer: 'hanh',
    registeredMonthsAgo: 2,
    // CTV mới vừa có khách đầu tiên — mở khoá đổi thưởng ngay.
    customers: [
      { key: 'dang-1', fullName: 'Nguyễn Thị Thắm', phone: '0123456041', orderCode: 'DH-2026-0777', activatedDaysAgo: 3 },
    ],
  },
  {
    key: 'mai',
    phone: '0123000006',
    fullName: `${DEMO_NAME_PREFIX}Đỗ Thanh Mai`,
    referrer: 'hanh',
    registeredMonthsAgo: 0, // overridden below to 10 days
    customers: [],
  },
  {
    key: 'son',
    phone: '0123000007',
    fullName: `${DEMO_NAME_PREFIX}Bùi Văn Sơn`,
    referrer: 'khoi',
    registeredMonthsAgo: 3,
    customers: [
      { key: 'son-1', fullName: 'Mai Văn Hùng', phone: '0123456061', orderCode: 'DH-2026-0688', activatedDaysAgo: 31 },
    ],
  },
  {
    key: 'chi',
    phone: '0123000008',
    fullName: `${DEMO_NAME_PREFIX}Ngô Kim Chi`,
    referrer: 'trang',
    registeredMonthsAgo: 1,
    customers: [],
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
}

// 24 rows, all visible. The public feed pages at 20, so 24 forces a real second page (page 2
// holds 4). Every row is published: the admin UI has no show/hide toggle, so a hidden row seeded
// here could never be made visible again.
const DEMO_POSTS: PostSpec[] = [
  // The first two mirror redemptions that genuinely exist in the seeded ledger, so a PO who opens
  // Bảo's or Hạnh's point history sees the matching REDEMPTION row.
  { honorific: 'Anh', name: 'Trần Quốc Bảo', points: 800, daysAgo: 12, blurb: 'CTV gốc của hệ thống, 8 tháng đồng hành. Quy đổi 500 điểm cá nhân và 300 điểm thưởng trong đợt chi tháng 6/2026.' },
  { honorific: 'Chị', name: 'Nguyễn Thị Hạnh', points: 200, daysAgo: 5, blurb: 'Giới thiệu đều đặn từ đầu năm, nhận thưởng đợt tháng 7/2026 ngay sau khi khách thứ hai được kích hoạt.' },
  { honorific: 'Anh', name: 'Phạm Văn Cường', points: 2000, daysAgo: 18, blurb: 'Dẫn đầu khu vực Bắc Trung Bộ quý II/2026 với 4 khách xuất cảnh thị trường Nhật Bản.' },
  { honorific: 'Chị', name: 'Lê Thị Hồng Nhung', points: 1500, daysAgo: 23, blurb: 'Ba khách đi Đài Loan trong cùng một quý, cộng thêm hoa hồng từ hai CTV tuyến dưới.' },
  { honorific: 'Anh', name: 'Nguyễn Hữu Thắng', points: 1000, daysAgo: 27, blurb: 'Hai khách xuất cảnh đơn hàng cơ khí, quy đổi ngay khi đủ điều kiện mở khoá.' },
  { honorific: 'Chị', name: 'Đặng Thu Hà', points: 2500, daysAgo: 31, blurb: 'CTV xuất sắc nhất tháng 6/2026 — 5 khách xuất cảnh và mạng lưới 6 CTV tuyến dưới.' },
  { honorific: 'Anh', name: 'Vũ Đình Long', points: 900, daysAgo: 36, blurb: 'Chuyển đổi thành công nhóm khách quen sang đơn hàng nông nghiệp Hàn Quốc.' },
  { honorific: 'Chị', name: 'Trịnh Mai Phương', points: 1200, daysAgo: 40, blurb: 'Giữ nhịp giới thiệu đều 8 tháng liên tiếp, luôn có khách mới mỗi quý.' },
  { honorific: 'Anh', name: 'Hoàng Minh Đức', points: 600, daysAgo: 44, blurb: 'CTV mới 4 tháng đã có khách đầu tiên xuất cảnh, mở khoá đổi thưởng ngay chu kỳ đầu.' },
  { honorific: 'Chị', name: 'Bùi Thị Kim Oanh', points: 3000, daysAgo: 49, blurb: 'Mốc quy đổi cao nhất từ trước tới nay của hệ thống, tích luỹ trong 11 tháng.' },
  { honorific: 'Anh', name: 'Ngô Thanh Tùng', points: 800, daysAgo: 54, blurb: 'Hai khách đơn hàng xây dựng Đài Loan, nhận thưởng đợt chi tháng 5/2026.' },
  { honorific: 'Chị', name: 'Dương Thị Lệ Thu', points: 1600, daysAgo: 58, blurb: 'Xây được nhánh tuyến dưới 4 người, phần lớn điểm đến từ hoa hồng giới thiệu.' },
  { honorific: 'Anh', name: 'Lý Văn Hiếu', points: 1100, daysAgo: 63, blurb: 'Khách đơn hàng thực phẩm Nhật Bản xuất cảnh đúng hẹn, quy đổi trong tháng.' },
  { honorific: 'Chị', name: 'Phan Ngọc Ánh', points: 700, daysAgo: 68, blurb: 'CTV khu vực Bến Tre, khách đầu tiên xuất cảnh sau 3 tháng tham gia.' },
  { honorific: 'Anh', name: 'Đỗ Quang Vinh', points: 1400, daysAgo: 73, blurb: 'Ba khách xuất cảnh liên tiếp trong quý I/2026, liên tục nhận thưởng điểm từ admin.' },
  { honorific: 'Chị', name: 'Nguyễn Thị Bích Ngọc', points: 500, daysAgo: 78, blurb: 'Quy đổi lần đầu ngay sau khi khách đầu tiên được duyệt xuất cảnh.' },
  { honorific: 'Anh', name: 'Trương Bá Khoa', points: 1800, daysAgo: 84, blurb: 'CTV kỳ cựu khu vực Tây Nguyên, mạng lưới tuyến dưới 5 người đang hoạt động.' },
  { honorific: 'Chị', name: 'Hồ Thị Thanh Trúc', points: 950, daysAgo: 90, blurb: 'Hai khách đi Nhật ngành điện tử, nhận thưởng đợt chi quý I/2026.' },
  { honorific: 'Anh', name: 'Cao Văn Nghĩa', points: 2200, daysAgo: 96, blurb: 'Bốn khách xuất cảnh trong 6 tháng, thuộc nhóm 3 CTV dẫn đầu toàn hệ thống.' },
  { honorific: 'Chị', name: 'Vương Thị Hạnh Dung', points: 650, daysAgo: 103, blurb: 'CTV bán thời gian, duy trì đều một khách mỗi quý từ khi tham gia.' },
  { honorific: 'Anh', name: 'Lâm Tuấn Anh', points: 1750, daysAgo: 110, blurb: 'Ba khách xuất cảnh cộng hoa hồng từ hai CTV do chính anh giới thiệu vào hệ thống.' },
  { honorific: 'Chị', name: 'Tạ Thị Mỹ Linh', points: 850, daysAgo: 118, blurb: 'Khách đơn hàng điều dưỡng Kaigo xuất cảnh tháng 4/2026.' },
  { honorific: 'Anh', name: 'Chu Đăng Khoa', points: 1300, daysAgo: 126, blurb: 'Quy đổi sau khi hoàn tất hai đơn hàng cơ khí và một đơn nông nghiệp.' },
  { honorific: 'Chị', name: 'Nguyễn Hoài Thương', points: 1050, daysAgo: 134, blurb: 'CTV khu vực Hà Nội, hai khách xuất cảnh trong quý IV/2025.' },
]

// The last row deliberately points at a URL that 404s, so PostImage's ImageOff fallback can be
// exercised straight from the CTV app without touching any of the working images.
const BROKEN_IMAGE_INDEX = DEMO_POSTS.length - 1
const BROKEN_IMAGE_URL = `${WP_UPLOADS}/2025/10/khong-ton-tai.jpg`

// --- CTV guides ("Hướng dẫn CTV") --------------------------------------------

interface GuideSpec {
  title: string
  blurb: string
  daysAgo: number
}

// 24 rows, all visible — same shape as DEMO_POSTS, deliberately: the public feed pages at 20, so
// 24 forces a real second page (page 2 holds 4).
const DEMO_GUIDES: GuideSpec[] = [
  { title: 'Cách chốt đơn nhanh trong 24 giờ', daysAgo: 4, blurb: 'Ba bước chuẩn bị hồ sơ trước khi gặp khách để rút ngắn thời gian duyệt: xác minh giấy tờ gốc, chốt mã kích hoạt, và chụp ảnh hồ sơ rõ nét ngay tại chỗ.' },
  { title: 'Kịch bản tư vấn khách hàng lần đầu', daysAgo: 9, blurb: 'Mẫu câu hỏi mở đầu, cách giải thích quy trình xuất cảnh bằng ngôn ngữ dễ hiểu, và cách xử lý câu hỏi về chi phí.' },
  { title: 'Checklist hồ sơ trước khi gửi duyệt', daysAgo: 15, blurb: 'Danh sách 6 mục cần kiểm tra trước khi bấm gửi duyệt để tránh bị admin yêu cầu bổ sung.' },
  { title: 'Cách xử lý khi đơn bị yêu cầu bổ sung', daysAgo: 20, blurb: 'Đọc đúng lý do admin ghi, sửa đúng chỗ, và gửi lại trong vòng 24 giờ để không mất lượt.' },
  { title: 'Điểm thưởng là gì và khi nào được cộng điểm', daysAgo: 26, blurb: 'Điểm thưởng chỉ được cộng khi admin chủ động thưởng — điểm tích luỹ không giới hạn thời gian, dùng để đổi thưởng cùng điểm cá nhân khi có khách xuất cảnh.' },
  { title: 'Cách chia sẻ link giới thiệu hiệu quả', daysAgo: 33, blurb: 'Nên gửi link mời qua Zalo cá nhân kèm một câu giới thiệu ngắn thay vì đăng công khai lên nhóm đông người.' },
  { title: 'Câu hỏi thường gặp về quy đổi điểm', daysAgo: 41, blurb: 'Điểm cá nhân và điểm thưởng khác nhau thế nào, khi nào được mở khoá đổi thưởng, và thời gian nhận tiền sau khi quy đổi.' },
  { title: 'Lưu ý khi khách chọn thị trường Nhật Bản', daysAgo: 48, blurb: 'Yêu cầu hồ sơ riêng cho thị trường Nhật, thời gian xử lý visa, và các lỗi hồ sơ thường gặp nhất.' },
  { title: 'Lưu ý khi khách chọn thị trường Đài Loan', daysAgo: 56, blurb: 'Khác biệt về giấy tờ so với thị trường Nhật, và mốc thời gian khách cần nắm trước khi xuất cảnh.' },
  { title: 'Cách xây dựng mạng lưới CTV tuyến dưới', daysAgo: 64, blurb: 'Khi nào nên mời người quen tham gia làm CTV, và cách hỗ trợ CTV mới trong tháng đầu tiên.' },
  { title: 'Hướng dẫn điền mã kích hoạt đúng chuẩn', daysAgo: 72, blurb: 'Mã kích hoạt sai định dạng là lý do phổ biến nhất khiến đơn bị yêu cầu bổ sung — cách kiểm tra trước khi gửi.' },
  { title: 'Cách đọc thông báo "Đơn cần bổ sung"', daysAgo: 79, blurb: 'Phân biệt lý do do thiếu giấy tờ, sai thông tin, hay mã kích hoạt không khớp — mỗi loại xử lý khác nhau.' },
  { title: 'Quy trình xử lý khi khách đổi ý không xuất cảnh', daysAgo: 85, blurb: 'Các bước cần làm ngay khi khách huỷ giữa chừng để đơn được từ chối đúng quy trình, không treo trạng thái.' },
  { title: 'Mẹo giữ liên lạc với khách sau khi gửi hồ sơ', daysAgo: 92, blurb: 'Tần suất nhắn tin hợp lý trong thời gian chờ duyệt để khách không sốt ruột mà cũng không thấy làm phiền.' },
  { title: 'Cách trả lời khi khách hỏi về thời gian chờ visa', daysAgo: 98, blurb: 'Khung thời gian tham khảo theo từng thị trường và cách trả lời khi có phát sinh chậm trễ.' },
  { title: 'Những lỗi hồ sơ khiến đơn bị từ chối nhiều nhất', daysAgo: 105, blurb: 'Tổng hợp 5 lỗi thường gặp nhất từ dữ liệu thực tế, xếp theo tần suất.' },
  { title: 'Cách tính điểm cá nhân và điểm thưởng', daysAgo: 112, blurb: 'Công thức cộng điểm khi khách xuất cảnh, khi giới thiệu CTV mới, và điểm thưởng do admin chủ động cấp.' },
  { title: 'Hướng dẫn sử dụng bộ lọc trong Sổ điểm', daysAgo: 118, blurb: 'Lọc theo ví, loại giao dịch, khoảng ngày và tìm theo tên/mã đơn để tự đối chiếu số dư nhanh hơn.' },
  { title: 'Khi nào nên tạo tài khoản CTV mới cho người quen', daysAgo: 125, blurb: 'Những dấu hiệu cho thấy một người quen phù hợp để mời làm CTV tuyến dưới, và cách hỗ trợ tháng đầu.' },
  { title: 'Lưu ý khi khách chọn thị trường Hàn Quốc', daysAgo: 132, blurb: 'Yêu cầu riêng về hồ sơ nông nghiệp/sản xuất, và các mốc thời gian khách cần nắm.' },
  { title: 'Cách xử lý khách yêu cầu hoàn tiền đặt cọc', daysAgo: 138, blurb: 'Quy trình phối hợp với admin khi khách yêu cầu hoàn cọc trước khi xuất cảnh.' },
  { title: 'Hướng dẫn đổi mật khẩu và khôi phục khi quên', daysAgo: 145, blurb: 'Các bước tự đổi mật khẩu, và cách liên hệ admin để được cấp mật khẩu tạm khi quên.' },
  { title: 'Mẹo duy trì phong độ CTV trong mùa thấp điểm', daysAgo: 152, blurb: 'Cách duy trì mạng lưới giới thiệu đều đặn vào những tháng ít khách để luôn có cơ hội nhận thưởng điểm.' },
  { title: 'Tổng hợp câu hỏi thường gặp từ CTV mới', daysAgo: 160, blurb: 'Giải đáp nhanh những thắc mắc phổ biến nhất trong tháng đầu tiên làm CTV.' },
]

// The last row deliberately points at a URL that 404s, mirroring DEMO_POSTS' broken-image case,
// so GuideImage's ImageOff fallback can be exercised straight from the CTV app.
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

const READ_CUTOFF = daysAgo(READ_CUTOFF_DAYS).toISOString()

const statements: string[] = []

// Running per-user wallet totals, updated by insertLedger below. Pass 4 asserts against these:
// now that a CTV's own CUSTOMER_REWARD is netted straight back out, a persona's redemption can
// silently exceed their balance and seed a negative wallet — which the real API would refuse.
const tally = new Map<string, { F: number; G: number }>()

function insertLedger(row: {
  id: string; userId: string; wallet: 'F' | 'G'; type: string; points: number
  orderId?: string | null; subjectUserId?: string | null; periodIndex?: number | null
  bonusGrantId?: string | null
  idempotencyKey?: string | null; note?: string | null; createdBy?: string | null; createdAt: string
}): void {
  const t = tally.get(row.userId) ?? { F: 0, G: 0 }
  t[row.wallet] += row.points
  tally.set(row.userId, t)
  statements.push(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, subject_user_id, period_index, bonus_grant_id, idempotency_key, note, created_by, created_at) VALUES (` +
      [q(row.id), q(row.userId), q(row.wallet), q(row.type), String(row.points),
        qn(row.orderId ?? null), qn(row.subjectUserId ?? null),
        row.periodIndex == null ? 'NULL' : String(row.periodIndex),
        qn(row.bonusGrantId ?? null),
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
    // point_ledger.bonus_grant_id REFERENCES bonus_grants(id) — bonus_grants is the PARENT, so it
    // must be deleted AFTER point_ledger (the child). D1 disallows TEMP tables (SQLITE_AUTH), so
    // this can't snapshot which grants belonged to demo users via point_ledger the way the other
    // DELETEs above do; instead the grants carry their own DEMO_BONUS_IDEM_PREFIX tag (idempotency_key),
    // the same tagging technique DEMO_PHONE_PREFIX/DEMO_NAME_PREFIX use for users/posts/guides.
    `DELETE FROM point_ledger WHERE user_id IN (${demoUsers}) OR subject_user_id IN (${demoUsers}) OR order_id IN (${demoOrders});`,
    `DELETE FROM bonus_grants WHERE idempotency_key LIKE '${DEMO_BONUS_IDEM_PREFIX}%';`,
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

  // Pass 2: activated customers. Mirrors lib/orders.ts activateCustomer() exactly — an
  // already-APPROVED order, its audit row, +500 F to the CTV, +100 F to their referrer, and an
  // immediate -500 F REDEMPTION netting the CTV's own share back to zero (the customer paid them
  // in cash), plus the single consolidated notification that flow sends.
  for (const built of users.values()) {
    for (const c of built.spec.customers) {
      const orderId = crypto.randomUUID()
      const at = daysAgo(c.activatedDaysAgo).toISOString()
      built.approvedDates.push(new Date(at))

      statements.push(
        `INSERT INTO orders (id, user_id, full_name, phone, order_code, activation_code, note, status, revision_reason, decided_by, decided_at, created_at, updated_at) VALUES (` +
          [q(orderId), q(built.id), q(c.fullName), q(c.phone), q(c.orderCode), q(c.orderCode),
            q(DIRECT_ACTIVATION_ORDER_NOTE), q('APPROVED'), 'NULL',
            q(adminId), q(at), q(at), q(at)].join(', ') +
          `);`,
      )
      insertOrderEvent(orderId, 'APPROVED', adminId, null, at)

      // +500 F to the CTV …
      insertLedger({
        id: crypto.randomUUID(), userId: built.id, wallet: 'F', type: 'CUSTOMER_REWARD',
        points: POINTS.CUSTOMER_REWARD, orderId, createdAt: at,
      })
      // … then straight back out, netting their own share to zero.
      const redemptionId = crypto.randomUUID()
      insertLedger({
        id: redemptionId, userId: built.id, wallet: 'F', type: 'REDEMPTION',
        points: -POINTS.CUSTOMER_REWARD, idempotencyKey: `demo-activation-${c.key}`,
        note: DIRECT_ACTIVATION_REDEMPTION_NOTE, createdBy: adminId, createdAt: at,
      })
      const cm = customerActivatedMessage(c.fullName, c.orderCode)
      insertNotification({ userId: built.id, type: 'REDEMPTION', title: cm.title, body: cm.body, ledgerId: redemptionId, createdAt: at })

      // The referrer's +100 is NOT netted — that leg is skipped when there is no referrer or the
      // referrer is the super admin, exactly like activateCustomer's guard.
      if (built.referrerId) {
        const ledgerId = crypto.randomUUID()
        insertLedger({
          id: ledgerId, userId: built.referrerId, wallet: 'F', type: 'CUSTOMER_REFERRAL_BONUS',
          points: POINTS.CUSTOMER_REFERRAL, orderId, createdAt: at,
        })
        const rm = customerReferralBonusMessage()
        insertNotification({ userId: built.referrerId, type: 'CUSTOMER_REFERRAL_BONUS', title: rm.title, body: rm.body, ledgerId, createdAt: at })
      }
    }
  }

  // Pass 3: two admin bonus grants (design: docs/superpowers/specs/2026-08-03-admin-point-bonus-
  // design.md) — a broadcast to every demo CTV, and one extra individual grant to `bao`, so the
  // demo shows both flows and their ledger/notification/history rows.
  const broadcastId = crypto.randomUUID()
  const broadcastAt = daysAgo(90).toISOString()
  const broadcastContent = 'Thưởng mừng hệ thống đạt mốc 50 CTV — tháng 4/2026'
  statements.push(
    `INSERT INTO bonus_grants (id, idempotency_key, scope, target_user_id, amount, content, recipient_count, created_by, created_at) VALUES (` +
      [q(broadcastId), q(`${DEMO_BONUS_IDEM_PREFIX}${broadcastId}`), q('ALL'), 'NULL', '50', q(broadcastContent),
        String(users.size), q(adminId), q(broadcastAt)].join(', ') +
      `);`,
  )
  for (const built of users.values()) {
    const ledgerId = crypto.randomUUID()
    insertLedger({
      id: ledgerId, userId: built.id, wallet: 'G', type: 'ADMIN_BONUS',
      points: 50, bonusGrantId: broadcastId, note: broadcastContent, createdBy: adminId, createdAt: broadcastAt,
    })
    const m = adminBonusMessage(50, broadcastContent)
    insertNotification({ userId: built.id, type: 'ADMIN_BONUS', title: m.title, body: m.body, ledgerId, createdAt: broadcastAt })
  }

  const bao = users.get('bao')!
  const individualId = crypto.randomUUID()
  const individualAt = daysAgo(8).toISOString()
  const individualContent = 'Thưởng nóng vượt chỉ tiêu quý — dẫn đầu khu vực'
  statements.push(
    `INSERT INTO bonus_grants (id, idempotency_key, scope, target_user_id, amount, content, recipient_count, created_by, created_at) VALUES (` +
      [q(individualId), q(`${DEMO_BONUS_IDEM_PREFIX}${individualId}`), q('PHONE'), q(bao.id), '30', q(individualContent),
        '1', q(adminId), q(individualAt)].join(', ') +
      `);`,
  )
  const individualLedgerId = crypto.randomUUID()
  insertLedger({
    id: individualLedgerId, userId: bao.id, wallet: 'G', type: 'ADMIN_BONUS',
    points: 30, bonusGrantId: individualId, note: individualContent, createdBy: adminId, createdAt: individualAt,
  })
  const im = adminBonusMessage(30, individualContent)
  insertNotification({ userId: bao.id, type: 'ADMIN_BONUS', title: im.title, body: im.body, ledgerId: individualLedgerId, createdAt: individualAt })

  // Pass 4: redemptions (admin deducts points for cash already paid outside the system). Placed
  // last so the wallets they draw from are fully accrued first.
  for (const built of users.values()) {
    const r = built.spec.redemption
    if (!r) continue
    const at = daysAgo(r.daysAgo).toISOString()
    const have = tally.get(built.id) ?? { F: 0, G: 0 }
    for (const [wallet, amount] of [['F', r.f], ['G', r.g]] as const) {
      if (amount && amount > have[wallet]) {
        throw new Error(
          `${built.spec.phone} (${built.spec.fullName}): redemption of ${amount} ${wallet} exceeds ` +
            `their ${have[wallet]} ${wallet}. Lower it in PERSONAS — a CTV's own customer reward is ` +
            `netted back out, so activations add nothing to their own spendable balance.`,
        )
      }
    }
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
    const title = `${DEMO_NAME_PREFIX}${p.honorific} ${p.name} đổi ${p.points} điểm nhận ${formatVnd(p.points)}`

    statements.push(
      `INSERT INTO posts (id, title, description, image_url, wp_media_id, published, created_by, created_at) VALUES (` +
        [q(crypto.randomUUID()), q(title), q(p.blurb), q(imageUrl), 'NULL',
          '1', q(adminId), q(daysAgo(p.daysAgo).toISOString())].join(', ') +
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
          '1', q(adminId), q(daysAgo(g.daysAgo).toISOString())].join(', ') +
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
    console.log(`✔ Seeded ${DEMO_POSTS.length} bài "Thành tích CTV" to ${target}`)
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
    console.log(`✔ Seeded ${DEMO_GUIDES.length} bài "Hướng dẫn CTV" to ${target}`)
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
  console.log(`  ${DEMO_POSTS.length} bài "Thành tích CTV"`)
  console.log(`  ${DEMO_GUIDES.length} bài "Hướng dẫn CTV"`)
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
