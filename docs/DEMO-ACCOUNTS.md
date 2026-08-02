# Tài khoản DEMO & kịch bản test (PO/PM)

> Seed lần gần nhất ngày **02/08/2026**, sau khi bỏ luồng CTV tự tạo đơn: giờ CTV **không tạo đơn
> nữa**, admin trực tiếp **kích hoạt khách hàng** (khách đã trả tiền mặt cho CTV). Không còn đơn
> nháp / chờ duyệt / cần bổ sung / từ chối ở bất kỳ đâu.
> Toàn bộ dữ liệu demo được gắn dấu:
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

| # | SĐT (đăng nhập) | Tên | Người giới thiệu | Đăng ký | Ví F | Ví G | Khách đã KH | Mở khoá đổi thưởng? |
|---|---|---|---|---|---|---|---|---|
| 1 | **0123000001** | DEMO Trần Quốc Bảo | — (CTV gốc) | 8 tháng trước | **300** | **100** | 3 | ✅ Có |
| 2 | **0123000002** | DEMO Nguyễn Thị Hạnh | 0123000001 | 6 tháng trước | **40** | **300** | 2 | ✅ Có |
| 3 | **0123000003** | DEMO Lê Minh Khôi | 0123000001 | 5 tháng trước | **220** | **100** | 0 | ❌ Không |
| 4 | **0123000004** | DEMO Phạm Thu Trang | 0123000001 | 4 tháng trước | **120** | **100** | 0 | ❌ Không |
| 5 | **0123000009** | DEMO Hoàng Anh Tuấn | 0123000001 | 4 tháng trước | **100** | **400** | 4 | ✅ Có |
| 6 | **0123000010** | DEMO Trịnh Bảo Lâm | 0123000001 | 3 tháng trước | **100** | **300** | 0 | ❌ Không (🔒 **tài khoản bị khoá**) |
| 7 | **0123000007** | DEMO Bùi Văn Sơn | 0123000003 | 3 tháng trước | **100** | **300** | 1 | ✅ Có |
| 8 | **0123000005** | DEMO Vũ Hải Đăng | 0123000002 | 2 tháng trước | **100** | **200** | 1 | ✅ Có |
| 9 | **0123000008** | DEMO Ngô Kim Chi | 0123000004 | 1 tháng trước | **100** | **100** | 0 | ❌ Không |
| 10 | **0123000006** | DEMO Đỗ Thanh Mai | 0123000002 | 10 ngày trước | **100** | **0** | 0 | ❌ Không |

> **Vì sao ví F trông "ít"?** Khi admin kích hoạt khách, CTV được **+500 F rồi bị trừ đúng 500 F
> ngay lập tức** (khách đã trả tiền mặt trực tiếp, không đi qua quy trình payout) → phần của
> chính mình **net = 0**. Cái thực sự tích luỹ là: +100 đăng ký, +20 mỗi CTV giới thiệu được,
> và **+100 hoa hồng mỗi lần khách của tuyến dưới được kích hoạt** (khoản này *không* bị trừ).
> Vì vậy Khôi có 220 F dù chưa có khách nào của riêng mình.

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

- Ví F = 300, ví G = 100, đã mở khoá đổi thưởng.
- **Lịch sử điểm** có đủ **7 loại giao dịch**: đăng ký (+100 F), giới thiệu CTV (+20 F × 5 người),
  thưởng khách (+500 F × 3 lần) **và 3 dòng trừ −500 F đối ứng ngay sau đó**, hoa hồng tuyến dưới
  (+100 F × 6 lần — từ khách của Hạnh và Tuấn), duy trì hàng tháng (+100 G × 8 chu kỳ),
  **đặt lại ví G** (−400 G ở chu kỳ 5 — xem bên dưới), quy đổi (−500 F và −300 G).
- **Khách đã kích hoạt:** 3 (DH-2025-1180, DH-2026-0233, DH-2026-0641).
- **Tài khoản lâu ngày bị trừ thưởng rồi hồi phục:** khoảng cách ~140 ngày giữa khách đầu tiên
  (DH-2025-1180, kích hoạt ~210 ngày trước) và khách thứ hai (DH-2026-0233, ~70 ngày trước) đủ dài
  để cửa sổ 3 tháng không có khách nào lọt vào → ví G bị **đặt lại ở chu kỳ 5** (mất trọn 400 điểm
  đang tích), sau đó khách thứ hai kéo việc tích luỹ trở lại bình thường từ chu kỳ 6. Đây là cùng
  hiện tượng như KB-02 (Hạnh) nhưng trên chính CTV kỳ cựu nhất — dùng để kiểm tra reset không chỉ
  xảy ra với tài khoản mới/ít hoạt động.

**Cần kiểm:** số dư 2 ví khớp tổng lịch sử; phân trang lịch sử điểm; bộ lọc theo ví/loại/thời gian;
mỗi cặp `+500 / −500` truy ngược được về đúng tên khách & mã đơn; dòng `MAINTENANCE_RESET −400`
ở chu kỳ 5 kèm thông báo *"Ví G đã được đặt lại"* xuất hiện đúng vị trí giữa các dòng tích luỹ.

---

### KB-02 — Ví G bị đặt lại rồi hồi phục
**Đăng nhập:** `0123000002` (Hạnh)

- Có khách được kích hoạt sớm → sau đó **nguội 3 tháng** → ví G **bị reset −300 vào chu kỳ 4
  (29/05/2026)** → rồi có khách mới nên G tích lại bình thường, hiện = 300.
- **Cần kiểm:** trong lịch sử điểm phải thấy dòng `MAINTENANCE_RESET −300` nằm giữa,
  và thông báo *"Ví G đã được đặt lại"*.
- 2 khách đã kích hoạt (DH-2026-0044, DH-2026-0455) — mỗi lần Bảo (người giới thiệu) nhận +100 F.
- Đã có 1 lần quy đổi −200 F, nên ví F chỉ còn 40 — thấp nhất trong các CTV đã có khách.
  Dùng để test **quy đổi vượt số dư** (thử đổi 100 F cho Hạnh phải bị chặn).

---

### KB-03 — CTV "nguội", ví G bị reset liên tiếp + cảnh báo sắp reset
**Đăng nhập:** `0123000003` (Khôi)

- **Chưa từng có khách nào của riêng mình** → ví G bị reset **2 lần** (chu kỳ 4 ngày 28/06, chu kỳ 5 ngày 28/07).
  *(Khôi đăng ký 28/02 — tháng 2 không có ngày 29 nên mốc kỷ niệm của riêng anh này rơi vào
  ngày 28, khác với các tài khoản DEMO còn lại. Đây là hành vi đúng của `anniversaryDate`.)*
- Đang có **thông báo cảnh báo "Ví G sắp bị đặt lại"** cho chu kỳ 6.
- Ví F = 220 vì: +100 đăng ký, +20 giới thiệu Sơn, **+100 hoa hồng** khi khách của Sơn được kích hoạt.
- **Điểm cần chú ý (case dễ sai):** Khôi **có điểm hoa hồng nhưng vẫn KHÔNG được đổi thưởng**,
  vì điều kiện mở khoá là *chính mình* phải có ≥ 1 khách được kích hoạt.
  → Admin thử quy đổi cho Khôi phải báo lỗi **khoá đổi thưởng**.

---

### KB-04 — CTV mới bị reset lần đầu, đang trong vùng cảnh báo
**Đăng nhập:** `0123000004` (Trang)

- Chưa có khách nào. Ví G vừa **bị reset −300 ở chu kỳ 4 (29/07/2026)**, hiện còn 100.
- Đang có **cảnh báo sắp reset** cho chu kỳ 5.
- **Cần kiểm:** màn hình admin **"CTV có nguy cơ mất điểm duy trì"** (`GET /api/admin/points/at-risk`)
  phải liệt kê đúng 3 người: **Khôi (0123000003), Trang (0123000004), Lâm (0123000010)**.

---

### KB-05 — CTV nhiều khách nhất
**Đăng nhập:** `0123000009` (Tuấn)

- **4 khách đã kích hoạt** — nhiều nhất trong các persona: DH-2026-0390 (45 ngày trước) và 3 khách
  sát nhau (DH-2026-0801/0802/0803, 8–6 ngày trước).
- Dùng để test **màn "Khách hàng" của admin**: lọc/tìm theo tên CTV này phải ra đúng 4 dòng,
  và 3 dòng mới nhất nằm liền nhau ở đầu danh sách.
- Ví F = 100 (thưởng khách của chính mình net = 0, Tuấn chưa giới thiệu CTV nào nên không có
  hoa hồng tuyến dưới) — minh hoạ rõ nhất việc **kích hoạt khách không làm tăng ví F của chính CTV đó**.
- Có khách trong cửa sổ hiện tại nên ví G khoẻ (400), không nằm trong danh sách nguy cơ.

---

### KB-06 — CTV mới, giai đoạn "khởi động" 3 tháng đầu
**Đăng nhập:** `0123000005` (Đăng)

- Đăng ký 2 tháng trước: ví F = 100, ví G = 200 (2 chu kỳ × 100).
- **Chưa bị áp dụng cơ chế reset** (3 tháng đầu là giai đoạn khởi động) — dùng để đối chiếu với KB-03/KB-04.
- Đã có **khách đầu tiên** (DH-2026-0777, kích hoạt 3 ngày trước) → **đã mở khoá đổi thưởng**,
  và Hạnh (người giới thiệu) nhận +100 F. Hộp thư Đăng có đúng **1 thông báo** cho lần kích hoạt này
  (không phải 2) — đây là điểm khác biệt chính so với luồng duyệt đơn cũ.

---

### KB-07 — Tài khoản vừa tạo, sạch nhất
**Đăng nhập:** `0123000006` (Mai)

- Đăng ký 10 ngày trước: ví F = 100, **ví G = 0** (chưa tới mốc 1 tháng đầu tiên).
- Hộp thư **trống** — đúng thiết kế: người đăng ký không nhận thông báo cho +100 của chính mình.
- **Chưa có khách nào** → chưa mở khoá đổi thưởng. Dùng để test màn hình rỗng của CTV mới tinh.

---

### KB-08 — CTV tuyến dưới chưa hoạt động
**Đăng nhập:** `0123000008` (Chi)

- Đăng ký 1 tháng trước dưới Trang, **chưa có khách nào** → ví F = 100, ví G = 100, chưa mở khoá.
- **Cần kiểm:** admin thử kích hoạt 1 khách cho Chi → Chi mở khoá đổi thưởng ngay,
  **Trang (người giới thiệu) +100 F**, và Chi nhận đúng 1 thông báo.
  Đây là cách nhanh nhất để xem trọn luồng kích hoạt từ đầu.

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

1. **Màn "Khách hàng":** phải thấy **11 khách DEMO đã kích hoạt** (Bảo 3, Hạnh 2, Tuấn 4, Sơn 1,
   Đăng 1). Không còn bộ lọc trạng thái, không có nút duyệt/từ chối/yêu cầu bổ sung —
   chỉ có danh sách + tìm kiếm + nút **"Kích hoạt khách hàng"**.
2. **Kích hoạt 1 khách mới** (gợi ý: cho Chi — xem KB-08) → kiểm tra ngay:
   - CTV được **+500 F rồi −500 F** (net 0), người giới thiệu **+100 F** (không bị trừ)
   - CTV nhận **đúng 1 thông báo** (không phải 2)
   - CTV **mở khoá đổi thưởng** ngay cả khi ví F không tăng
   - Bấm kích hoạt 2 lần liên tiếp cùng nội dung → lần 2 phải báo **đã kích hoạt trước đó**
3. **Quy đổi điểm:** thử trên Bảo (được — còn 300 F), trên Khôi (**phải bị chặn – chưa mở khoá**),
   và trên Hạnh với số lớn hơn 40 (**phải bị chặn – không đủ số dư**).
4. **Đặt lại mật khẩu** cho 1 CTV DEMO → mật khẩu tạm `12345678`, hết hạn sau 15 phút,
   CTV bắt buộc đổi mật khẩu ở lần đăng nhập kế tiếp.
5. **Tìm kiếm:** gõ `DEMO` ở màn hình người dùng, hoặc `DH-2026` ở màn hình khách hàng.
6. **Kiểm tra phía CTV:** đăng nhập bất kỳ CTV nào — **không còn menu/đường dẫn nào tới đơn hàng**.

---

### KB-11 — Màn "Thành tích CTV" (bài đăng)

**Đăng nhập:** bất kỳ CTV nào → Trang chủ → **Thành tích CTV**
(API công khai, không cần đăng nhập: `GET /api/posts`)

Đã seed **24 bài**, tất cả đều hiển thị.

- **Phân trang:** trang mặc định 20 bài → trang 1 có 20, **trang 2 có 4**. Đủ để test nút chuyển trang.
- **Ảnh hỏng:** bài **cũ nhất** (`DEMO Chị Nguyễn Hoài Thương đổi 1050 điểm…`, cuối trang 2) cố tình
  trỏ tới URL ảnh không tồn tại → app CTV phải rơi vào fallback biểu tượng `ImageOff`,
  **không được vỡ layout**.
- **Xem chi tiết:** bấm 1 bài → mở trang chi tiết (ảnh tỉ lệ 4:5, nút quay lại góc trái).
- **CRUD ở admin:** `/admin/posts` — đăng bài mới, sửa (kể cả đổi ảnh), xoá. Không có ẩn/hiện:
  mọi bài đã đăng đều hiển thị với CTV.
- **Hai bài đầu khớp với dữ liệu điểm thật:** `DEMO Anh Trần Quốc Bảo đổi 1300 điểm nhận 6.500.000đ`
  và `DEMO Chị Nguyễn Thị Hạnh đổi 400 điểm nhận 2.000.000đ` — mở lịch sử điểm của Bảo/Hạnh
  sẽ thấy đúng dòng `REDEMPTION` tương ứng.

> ⚠️ **Nội dung và ảnh đều là giả, chỉ để test giao diện.**
> - Ảnh lấy từ thư viện WordPress sẵn có của công ty (`xklddieuduong.vn`) vì WP REST API chặn
>   request ẩn danh nên script không upload được ảnh mới. **Ảnh không liên quan tới nội dung bài** —
>   phần lớn là ảnh scan giấy phép và ảnh chụp tập thể học viên. Đừng đọc ảnh như minh hoạ cho tiêu đề.
> - Tên người trong bài là **tên bịa** (trừ Bảo và Hạnh là 2 persona DEMO đã có sẵn).
> - Số tiền quy ra theo **giả định 1 điểm = 5.000đ** — hệ thống **không** lưu tỷ giá này ở đâu cả.
>   Nếu tỷ giá thật khác, sửa hằng số `VND_PER_POINT` trong `scripts/seed-demo.ts` rồi seed lại.

---

### KB-12 — Màn "Hướng dẫn CTV" (bài đăng)

**Đăng nhập:** bất kỳ CTV nào → Trang chủ → **Hướng dẫn CTV** (nút xanh lá cạnh "Thành tích CTV",
cũng có thể vào từ header của màn Thành tích) (API công khai, không cần đăng nhập: `GET /api/guides`)

Cùng cấu trúc và cùng số liệu như KB-11 (Thành tích), chỉ khác nội dung: **24 bài**, tất cả đều
hiển thị — nội dung là mẹo/quy trình dành cho CTV (chốt đơn, tư vấn khách, giữ ví G, từng thị
trường xuất khẩu lao động…) thay vì thông báo đổi thưởng.

- **Phân trang:** trang 1 có 20, **trang 2 có 4**.
- **Ảnh hỏng:** bài **cũ nhất** (cuối trang 2) trỏ tới URL không tồn tại — phải rơi vào fallback
  `ImageOff`, không vỡ layout (giống hệt cơ chế của Thành tích).
- **Xem chi tiết:** bấm 1 bài → mở trang chi tiết (ảnh tỉ lệ 4:5, nút quay lại góc trái).
- **CRUD ở admin:** `/admin/guides` — đăng bài mới (ảnh + tiêu đề + mô tả), sửa (kể cả đổi ảnh),
  xoá — y hệt thao tác ở `/admin/posts`. Không có ẩn/hiện.

---

## 3. Lưu ý khi test

- **CTV không tạo đơn được nữa.** Toàn bộ luồng nháp → gửi duyệt → duyệt/từ chối/bổ sung đã bị bỏ.
  Khách hàng chỉ xuất hiện khi **admin bấm "Kích hoạt khách hàng"**.
- **Số dư sẽ tự thay đổi theo thời gian.** Hệ thống chạy tự động mỗi ngày lúc **08:00 giờ VN**:
  mỗi tài khoản được **+100 ví G** vào đúng ngày kỷ niệm đăng ký hàng tháng (ngày 30 với hầu hết
  tài khoản DEMO, riêng Khôi là ngày 28 — tháng 2 không có ngày 30 nên bị `anniversaryDate`
  kẹp về cuối tháng). Khôi và Trang nếu vẫn không có khách nào được kích hoạt thì
  **ví G sẽ bị reset tiếp** ở kỳ sau — đây là hành vi đúng, không phải lỗi.
- Các con số trong tài liệu này là **trạng thái tại thời điểm seed (02/08/2026)**, lấy trực tiếp
  từ DB sau khi chạy seed.
- Dữ liệu DEMO tách biệt hoàn toàn với dữ liệu UAT cũ (0900000xxx).
- Mọi thao tác test (kích hoạt khách, quy đổi…) sẽ **làm thay đổi vĩnh viễn** số liệu ở trên.
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
