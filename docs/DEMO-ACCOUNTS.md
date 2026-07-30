# Tài khoản DEMO & kịch bản test (PO/PM)

> Seed ngày **29/07/2026** trên **production**. Toàn bộ dữ liệu demo được gắn dấu:
> số điện thoại dải **0123xxxxxx**, tên người và tiêu đề bài đăng bắt đầu bằng **`DEMO `**.
> Dữ liệu UAT cũ (dải 0900000xxx) và tài khoản admin **không bị đụng tới**.
>
> Dải `0123` được chọn có chủ đích: đầu số 11 số `0123` đã bị khai tử trong đợt chuyển đổi
> năm 2018 (thành `083`), nên **không thuê bao thật nào có thể trùng**. Số điện thoại khách hàng
> trên các đơn DEMO cũng nằm trong dải này (`0123456xxx`).

## Truy cập

| | |
|---|---|
| App CTV | https://xkld-tools-client.anhduc22601.workers.dev |
| API | https://xkld-tools.anhduc22601.workers.dev |
| Mật khẩu **tất cả** tài khoản DEMO | `Demo@2026` |
| Tài khoản Super Admin | `0942893001` (mật khẩu do team giữ) |

---

## 1. Danh sách tài khoản

| # | SĐT (đăng nhập) | Tên | Người giới thiệu | Đăng ký | Ví F | Ví G | Mở khoá đổi thưởng? |
|---|---|---|---|---|---|---|---|
| 1 | **0123000001** | DEMO Trần Quốc Bảo | — (CTV gốc) | 8 tháng trước | **100** | **10** | ✅ Có |
| 2 | **0123000002** | DEMO Nguyễn Thị Hạnh | 0123000001 | 6 tháng trước | **74** | **30** | ✅ Có |
| 3 | **0123000003** | DEMO Lê Minh Khôi | 0123000001 | 5 tháng trước | **22** | **10** | ❌ Không |
| 4 | **0123000004** | DEMO Phạm Thu Trang | 0123000001 | 4 tháng trước | **12** | **10** | ❌ Không |
| 5 | **0123000009** | DEMO Hoàng Anh Tuấn | 0123000001 | 4 tháng trước | **60** | **40** | ✅ Có |
| 6 | **0123000010** | DEMO Trịnh Bảo Lâm | 0123000001 | 3 tháng trước | **10** | **30** | ❌ Không (🔒 **tài khoản bị khoá**) |
| 7 | **0123000007** | DEMO Bùi Văn Sơn | 0123000003 | 3 tháng trước | **60** | **30** | ✅ Có |
| 8 | **0123000005** | DEMO Vũ Hải Đăng | 0123000002 | 2 tháng trước | **10** | **20** | ❌ Không |
| 9 | **0123000008** | DEMO Ngô Kim Chi | 0123000004 | 1 tháng trước | **10** | **10** | ❌ Không |
| 10 | **0123000006** | DEMO Đỗ Thanh Mai | 0123000002 | 10 ngày trước | **10** | **0** | ❌ Không |

### Sơ đồ mạng lưới giới thiệu

```
Bảo (0123000001) — CTV gốc, 8 tháng
├── Hạnh (0123000002) — 6 tháng
│   ├── Đăng (0123000005) — 2 tháng
│   └── Mai  (0123000006) — 10 ngày
├── Khôi (0123000003) — 5 tháng
│   └── Sơn (0123000007) — 3 tháng
├── Trang (0123000004) — 4 tháng
│   └── Chi (0123000008) — 1 tháng
├── Tuấn (0123000009) — 4 tháng
└── Lâm  (0123000010) — 3 tháng (đã khoá)
```

---

## 2. Kịch bản test

### KB-01 — CTV kỳ cựu, dữ liệu đầy đủ nhất
**Đăng nhập:** `0123000001` (Bảo)

Đây là tài khoản để xem "một CTV hoạt động lâu dài trông như thế nào".

- Ví F = 100, ví G = 10, đã mở khoá đổi thưởng.
- **Lịch sử điểm** có đủ **7 loại giao dịch**: đăng ký (+10 F), giới thiệu CTV (+2 F × 5 người),
  thưởng khách xuất cảnh (+50 F × 3 đơn), hoa hồng tuyến dưới (+10 F × 3 lần),
  duy trì hàng tháng (+10 G × 8 chu kỳ), **đặt lại ví G** (−40 G ở chu kỳ 5 — xem bên dưới),
  quy đổi (−100 F và −30 G).
- **Đơn hàng:** 3 đơn `ĐÃ DUYỆT` (DH-2025-1180, DH-2026-0233, DH-2026-0641) + 1 đơn `TỪ CHỐI` (DH-2026-0102).
- **Tài khoản lâu ngày bị trừ thưởng rồi hồi phục:** khoảng cách ~140 ngày giữa đơn đầu tiên
  (DH-2025-1180, duyệt ~210 ngày trước) và đơn thứ hai (DH-2026-0233, duyệt ~70 ngày trước) đủ dài
  để cửa sổ 3 tháng không có đơn nào lọt vào → ví G bị **đặt lại ở chu kỳ 5** (mất trọn 40 điểm
  đang tích), sau đó đơn thứ hai kéo việc tích luỹ trở lại bình thường từ chu kỳ 6. Đây là cùng
  hiện tượng như KB-02 (Hạnh) nhưng trên chính CTV kỳ cựu nhất — dùng để kiểm tra reset không chỉ
  xảy ra với tài khoản mới/ít hoạt động.

**Cần kiểm:** số dư 2 ví khớp tổng lịch sử; phân trang lịch sử điểm; bộ lọc theo ví/loại/thời gian;
mỗi dòng `+50` truy ngược được về đúng tên khách & mã đơn; dòng `MAINTENANCE_RESET −40` ở chu kỳ 5
kèm thông báo *"Ví G đã được đặt lại"* xuất hiện đúng vị trí giữa các dòng tích luỹ.

---

### KB-02 — Ví G bị đặt lại rồi hồi phục
**Đăng nhập:** `0123000002` (Hạnh)

- Có đơn duyệt sớm → sau đó **nguội 3 tháng** → ví G **bị reset −30 vào chu kỳ 4 (29/05/2026)** →
  rồi có đơn mới nên G tích lại bình thường, hiện = 30.
- **Cần kiểm:** trong lịch sử điểm phải thấy dòng `MAINTENANCE_RESET −30` nằm giữa,
  và thông báo *"Ví G đã được đặt lại"*.
- Còn 1 đơn ở trạng thái **`CẦN BỔ SUNG`** (DH-2026-0788), lý do admin ghi:
  *"Mã kích hoạt không khớp với hồ sơ, vui lòng kiểm tra lại"*.
  → **Test luồng sửa & gửi lại:** CTV sửa đơn → gửi lại → đơn về `CHỜ DUYỆT` → admin duyệt →
  Hạnh +50 F, Bảo (người giới thiệu) +10 F.
- Đã có 1 lần quy đổi −40 F.

---

### KB-03 — CTV "nguội", ví G bị reset liên tiếp + cảnh báo sắp reset
**Đăng nhập:** `0123000003` (Khôi)

- **Chưa từng có đơn nào được duyệt** → ví G bị reset **2 lần** (chu kỳ 4 ngày 28/06, chu kỳ 5 ngày 28/07).
  *(Khôi đăng ký 28/02 — tháng 2 không có ngày 29 nên mốc kỷ niệm của riêng anh này rơi vào
  ngày 28, khác với các tài khoản DEMO còn lại. Đây là hành vi đúng của `anniversaryDate`.)*
- Đang có **thông báo cảnh báo "Ví G sắp bị đặt lại"** cho chu kỳ 6.
- Ví F = 22 vì: +10 đăng ký, +2 giới thiệu Sơn, **+10 hoa hồng** khi đơn của Sơn được duyệt.
- **Điểm cần chú ý (case dễ sai):** Khôi **có điểm hoa hồng nhưng vẫn KHÔNG được đổi thưởng**,
  vì điều kiện mở khoá là *chính mình* phải có ≥ 1 đơn được duyệt.
  → Admin thử quy đổi cho Khôi phải báo lỗi **khoá đổi thưởng**.

---

### KB-04 — CTV mới bị reset lần đầu, đang trong vùng cảnh báo
**Đăng nhập:** `0123000004` (Trang)

- Chưa có đơn nào. Ví G vừa **bị reset −30 ở chu kỳ 4 (29/07/2026)**, hiện còn 10.
- Đang có **cảnh báo sắp reset** cho chu kỳ 5.
- **Cần kiểm:** màn hình admin **"CTV có nguy cơ mất điểm duy trì"** (`GET /api/admin/points/at-risk`)
  phải liệt kê đúng 3 người: **Khôi (0123000003), Trang (0123000004), Lâm (0123000010)**.

---

### KB-05 — Chạm trần 5 đơn CHỜ DUYỆT
**Đăng nhập:** `0123000009` (Tuấn)

- Đang có **đúng 5 đơn `CHỜ DUYỆT`** (DH-2026-0801 → DH-2026-0805) — bằng giới hạn tối đa.
- **Cần kiểm:** tạo thêm đơn nháp thì được, nhưng **bấm gửi duyệt đơn thứ 6 phải bị chặn**
  với thông báo quá số đơn chờ duyệt.
- Sau khi admin duyệt/từ chối bớt 1 đơn → gửi được đơn tiếp theo.
- Tuấn cũng có 1 đơn đã duyệt trước đó (DH-2026-0390) nên ví G khoẻ, không nằm trong danh sách nguy cơ.

---

### KB-06 — CTV mới, giai đoạn "khởi động" 3 tháng đầu
**Đăng nhập:** `0123000005` (Đăng)

- Đăng ký 2 tháng trước: ví F = 10, ví G = 20 (2 chu kỳ × 10).
- **Chưa bị áp dụng cơ chế reset** (3 tháng đầu là giai đoạn khởi động) — dùng để đối chiếu với KB-03/KB-04.
- Có 1 đơn `CHỜ DUYỆT` (DH-2026-0777) → **luồng duyệt đơn đầu đời:**
  admin duyệt → Đăng +50 F và mở khoá đổi thưởng, Hạnh (người giới thiệu) +10 F,
  cả hai đều nhận thông báo.

---

### KB-07 — Tài khoản vừa tạo, sạch nhất
**Đăng nhập:** `0123000006` (Mai)

- Đăng ký 10 ngày trước: ví F = 10, **ví G = 0** (chưa tới mốc 1 tháng đầu tiên).
- Hộp thư **trống** — đúng thiết kế: người đăng ký không nhận thông báo cho +10 của chính mình.
- Có sẵn 1 **đơn NHÁP** (DH-2026-0900) → test luồng: sửa nháp → gửi duyệt → admin nhận thông báo "Đơn hàng mới".

---

### KB-08 — Đơn bị từ chối
**Đăng nhập:** `0123000008` (Chi)

- 1 đơn **`TỪ CHỐI`** (DH-2026-0850) + thông báo tương ứng.
- **Cần kiểm:** đơn từ chối **không sinh điểm nào**, và **không sửa lại được** —
  muốn làm lại phải tạo đơn mới.

---

### KB-09 — Tài khoản bị khoá
**Đăng nhập:** `0123000010` (Lâm) → **phải đăng nhập thất bại**

- **Cần kiểm:** thông báo lỗi chung chung (*"sai số điện thoại hoặc mật khẩu"*), **không được lộ**
  thông tin là tài khoản tồn tại nhưng bị khoá.
- Lâm vẫn tiếp tục tích điểm duy trì và vẫn nằm trong danh sách "nguy cơ mất điểm" của admin
  (đúng thiết kế hiện tại — nếu PO thấy chưa hợp lý thì đây là điểm cần quyết định lại).
- **Điểm cần PO quyết:** hộp thư của Lâm hiện có sẵn **1 thông báo "Ví G sắp bị đặt lại"**
  (chu kỳ 4). Tức là hệ thống vẫn sinh thông báo cho tài khoản đã khoá, trong khi chính chủ
  **không thể đăng nhập để đọc**. Kiểm tra trực tiếp bằng SQL hoặc bằng cách mở khoá tài khoản
  rồi đăng nhập lại.

---

### KB-10 — Luồng của Super Admin
**Đăng nhập:** `0942893001`

1. **Hàng đợi duyệt đơn:** phải thấy **6 đơn DEMO đang chờ** (5 của Tuấn + 1 của Đăng).
2. **Duyệt 1 đơn** → kiểm tra ngay: CTV +50 F, người giới thiệu +10 F, cả hai có thông báo,
   đơn chuyển `ĐÃ DUYỆT` và **không duyệt lại được lần 2**.
3. **Yêu cầu bổ sung** trên 1 đơn chờ duyệt → CTV nhận thông báo *"Đơn hàng cần bổ sung"*.
4. **Quy đổi điểm:** thử trên Bảo (được), trên Khôi (**phải bị chặn – chưa mở khoá**),
   và thử số điểm lớn hơn số dư (**phải bị chặn – không đủ số dư**).
5. **Đặt lại mật khẩu** cho 1 CTV DEMO → mật khẩu tạm `12345678`, hết hạn sau 15 phút,
   CTV bắt buộc đổi mật khẩu ở lần đăng nhập kế tiếp.
6. **Tìm kiếm:** gõ `DEMO` ở màn hình người dùng, hoặc `DH-2026` ở màn hình đơn hàng.

---

### KB-11 — Màn "Thành tích CTV" (bài đăng)

**Đăng nhập:** bất kỳ CTV nào → Trang chủ → **Thành tích CTV**
(API công khai, không cần đăng nhập: `GET /api/posts`)

Đã seed **27 bài**, trong đó **24 bài hiển thị** + **3 bài ẩn** (`published = 0`).

- **Phân trang:** trang mặc định 20 bài → trang 1 có 20, **trang 2 có 4**. Đủ để test nút chuyển trang.
- **Bài ẩn không được lộ:** 3 bài ẩn (tiêu đề `DEMO Bài ẩn – …`) **phải không xuất hiện**
  trên app CTV. Chúng chỉ hiện ở màn admin, dùng để test nút bật/tắt hiển thị.
- **Ảnh hỏng:** bài ẩn `DEMO Bài ẩn – ảnh hỏng` trỏ tới URL ảnh không tồn tại.
  Admin bật hiển thị bài này → app CTV phải rơi vào fallback biểu tượng `ImageOff`,
  **không được vỡ layout**.
- **Xem chi tiết:** bấm 1 bài → mở trang chi tiết (ảnh tỉ lệ 4:5, nút quay lại góc trái).
- **Hai bài đầu khớp với dữ liệu điểm thật:** `DEMO Anh Trần Quốc Bảo đổi 130 điểm nhận 6.500.000đ`
  và `DEMO Chị Nguyễn Thị Hạnh đổi 40 điểm nhận 2.000.000đ` — mở lịch sử điểm của Bảo/Hạnh
  sẽ thấy đúng dòng `REDEMPTION` tương ứng.

> ⚠️ **Nội dung và ảnh đều là giả, chỉ để test giao diện.**
> - Ảnh lấy từ thư viện WordPress sẵn có của công ty (`xklddieuduong.vn`) vì WP REST API chặn
>   request ẩn danh nên script không upload được ảnh mới. **Ảnh không liên quan tới nội dung bài** —
>   phần lớn là ảnh scan giấy phép và ảnh chụp tập thể học viên. Đừng đọc ảnh như minh hoạ cho tiêu đề.
> - Tên người trong bài là **tên bịa** (trừ Bảo và Hạnh là 2 persona DEMO đã có sẵn).
> - Số tiền quy ra theo **giả định 1 điểm = 50.000đ** — hệ thống **không** lưu tỷ giá này ở đâu cả.
>   Nếu tỷ giá thật khác, sửa hằng số `VND_PER_POINT` trong `scripts/seed-demo.ts` rồi seed lại.

---

### KB-12 — Màn "Hướng dẫn CTV" (bài đăng)

**Đăng nhập:** bất kỳ CTV nào → Trang chủ → **Hướng dẫn CTV** (nút xanh lá cạnh "Thành tích CTV",
cũng có thể vào từ header của màn Thành tích) (API công khai, không cần đăng nhập: `GET /api/guides`)

Cùng cấu trúc và cùng số liệu như KB-11 (Thành tích), chỉ khác nội dung: **27 bài**, trong đó
**24 bài hiển thị** + **3 bài ẩn** (`published = 0`) — nội dung là mẹo/quy trình dành cho CTV
(chốt đơn, tư vấn khách, giữ ví G, từng thị trường xuất khẩu lao động…) thay vì thông báo đổi thưởng.

- **Phân trang:** trang 1 có 20, **trang 2 có 4**.
- **Bài ẩn không được lộ:** 3 bài ẩn (`DEMO Nháp – …`, `DEMO Bản cũ – …`, `DEMO Bài ẩn – ảnh hỏng`)
  **phải không xuất hiện** trên app CTV, chỉ hiện ở màn `/admin/guides`.
- **Ảnh hỏng:** bài ẩn `DEMO Bài ẩn – ảnh hỏng` trỏ tới URL không tồn tại — bật hiển thị lên phải
  rơi vào fallback `ImageOff`, không vỡ layout (giống hệt cơ chế của Thành tích).
- **Xem chi tiết:** bấm 1 bài → mở trang chi tiết (ảnh tỉ lệ 4:5, nút quay lại góc trái).
- **CRUD ở admin:** `/admin/guides` — đăng bài mới (ảnh + tiêu đề + mô tả), sửa, ẩn/hiện, xoá —
  y hệt thao tác ở `/admin/posts`.

---

## 3. Lưu ý khi test

- **Số dư sẽ tự thay đổi theo thời gian.** Hệ thống chạy tự động mỗi ngày lúc **08:00 giờ VN**:
  mỗi tài khoản được **+10 ví G** vào đúng ngày kỷ niệm đăng ký hàng tháng (ngày 29 với hầu hết
  tài khoản DEMO, riêng Khôi là ngày 28). Khôi và Trang nếu vẫn không có đơn được duyệt thì
  **ví G sẽ bị reset tiếp** ở kỳ sau — đây là hành vi đúng, không phải lỗi.
- Các con số trong tài liệu này là **trạng thái tại thời điểm seed (29/07/2026)**.
- Dữ liệu DEMO tách biệt hoàn toàn với dữ liệu UAT cũ (0900000xxx).
- Mọi thao tác test (duyệt đơn, quy đổi…) sẽ **làm thay đổi vĩnh viễn** số liệu ở trên.
  Cần trả về trạng thái ban đầu thì chạy lại seed (xem mục 4).

## 4. Seed lại / xoá dữ liệu DEMO (dành cho dev)

```bash
pnpm seed:demo               # xoá dữ liệu DEMO cũ rồi seed lại từ đầu (production)
pnpm seed:demo --local       # tương tự nhưng trên DB local
pnpm seed:demo --purge       # chỉ xoá sạch dữ liệu DEMO
pnpm seed:demo --dry-run     # in SQL ra màn hình, không ghi gì
pnpm seed:demo --posts-only  # chỉ nạp lại bài "Thành tích CTV", KHÔNG đụng tài khoản CTV
pnpm seed:demo --guides-only # chỉ nạp lại bài "Hướng dẫn CTV", KHÔNG đụng tài khoản CTV
```

> `--posts-only` dùng khi chỉ muốn làm mới danh sách bài đăng. Chạy `pnpm seed:demo` đầy đủ sẽ
> **tạo lại toàn bộ tài khoản với id mới và dời mọi mốc thời gian về ngày chạy**, nên số liệu
> trong tài liệu này sẽ lệch đi.

Script: `scripts/seed-demo.ts`. Nó dùng lại **chính các hàm nghiệp vụ của app**
(`planMaintenance`, `planOrderApprovalBonuses`, nội dung thông báo…) nên dữ liệu sinh ra
giống hệt như khi người dùng thật thao tác — chỉ khác là được lùi ngày về quá khứ.
