# PRD: Hệ thống điểm thưởng, mạng lưới giới thiệu & đổi điểm CTV Xuất khẩu Lao động

**Loại tài liệu:** Product Requirements Document (PRD) — tập trung yêu cầu nghiệp vụ/chức năng, chưa bao gồm thiết kế kỹ thuật (data schema chi tiết, API, tech stack). Đây là bản thiết kế lại **hoàn toàn từ đầu**, thay thế mọi tài liệu trước đó (mô hình "cây giới thiệu sâu không giới hạn + tỉ lệ chia điểm cấu hình" của bản cũ không còn áp dụng).

**Phạm vi nội dung:** Ba mảng chính — **mạng lưới giới thiệu/đăng ký**, **cơ chế cộng điểm qua Order**, và **đổi điểm lấy tiền mặt (Redemption)**.

---

## 1. Bối cảnh & Mục tiêu

Công ty XKLĐ vận hành thông qua một mạng lưới người dùng (User) giới thiệu lẫn nhau. Khi một User hoàn thành công việc thực tế (nằm ngoài hệ thống), User tự báo cáo bằng cách tạo một "Order"; Super Admin xác minh (ngoài hệ thống) và quyết định duyệt hay từ chối. Hệ thống cần cộng điểm thưởng cho User đó và cho người đã giới thiệu User đó khi Order được duyệt, và cho phép Admin trừ điểm đổi tiền mặt — tất cả phải minh bạch, có lịch sử đầy đủ để đối soát.

**Mục tiêu của hệ thống:**
1. Quản lý mạng lưới User dưới dạng **giới thiệu 1 cấp** (mỗi User biết đúng một người giới thiệu trực tiếp mình), cho phép User tự đăng ký/giới thiệu người khác tham gia.
2. Cung cấp cơ chế **User tự tạo Order (tự báo cáo hoàn thành) → Super Admin xác minh và duyệt (approve) hoặc từ chối (reject)** để quyết định có kích hoạt cộng điểm hay không.
3. Tự động cộng điểm cố định cho User được duyệt Order và cho người giới thiệu User đó (đúng 1 cấp).
4. Cho phép Admin trừ điểm của User để đổi lấy tiền mặt đã trả ngoài đời (Redemption).
5. Đảm bảo toàn bộ biến động điểm có lịch sử đầy đủ, bất biến, phục vụ đối soát.

---

## 2. Phạm vi

**Trong phạm vi (Phase này):**
- Đăng ký/mạng lưới giới thiệu 1 cấp (qua link mời hoặc nhập mã giới thiệu), kích hoạt ngay.
- Order: User tự tạo (tự báo cáo hoàn thành, luôn gắn với chính mình), Super Admin duyệt (approve) hoặc từ chối (reject) để kích hoạt cộng điểm.
- Cộng điểm cố định khi Order được duyệt (điểm cho User + điểm cho người giới thiệu).
- Sổ giao dịch điểm (Point Ledger) bất biến, số dư điểm (wallet balance) luôn suy ra được từ sổ này.
- Redemption: Admin trừ điểm của User để đổi lấy tiền mặt đã trả ngoài hệ thống.

**Ngoài phạm vi / để phase sau (đã xác nhận với stakeholder là chưa cần thiết kế chi tiết bây giờ):**
- `life_point`: một loại điểm khác tồn tại trên mỗi User, nhưng cơ chế cộng/trừ/sử dụng chưa thiết kế.
- Bất kỳ hình thức đổi điểm nào khác ngoài Redemption bằng tiền mặt do Admin thực hiện (ví dụ: User tự đổi điểm lấy hiện vật/dịch vụ trong hệ thống).
- Chuyển điểm ngang hàng giữa 2 User (P2P transfer) — hiện không có nhu cầu; nếu phát sinh sau này sẽ cần đánh giá lại kiến trúc lưu trữ điểm (xem Mục 10).
- Danh sách/giao diện xem người mình đã giới thiệu — mạng lưới giới thiệu hiện chỉ phục vụ tính điểm nội bộ, không cần hiển thị cho User.
- User tự hủy/rút lại Order sau khi đã tạo — chỉ Admin có quyền thay đổi trạng thái Order (duyệt/từ chối).

---

## 3. Mô hình mạng lưới giới thiệu

- Mỗi User có **đúng một người giới thiệu trực tiếp** (referrer), ngoại trừ tài khoản "gốc" do Super Admin tạo (không có referrer).
- Mạng lưới có thể sâu nhiều tầng, nhưng nghiệp vụ **chỉ quan tâm 1 cấp**: khi User X được cộng điểm, chỉ referrer trực tiếp của X được cộng điểm gián tiếp — không truy ngược thêm tầng nào khác.
- **Chỉ có 2 loại tài khoản**: **Super Admin** (đúng 1 tài khoản) và **User** (tất cả người còn lại).

### Đăng ký tài khoản
- Đăng ký luôn phải xác định được người giới thiệu, qua 1 trong 2 cách:
  1. **Qua link mời**: người giới thiệu chia sẻ link; hệ thống tự gán người chia sẻ làm referrer.
  2. **Tự nhập mã giới thiệu**: người đăng ký nhập mã (định danh) của người giới thiệu vào form đăng ký.
- **Tài khoản kích hoạt ngay sau khi đăng ký** — không cần Admin duyệt.
- **Chỉ Super Admin mới tạo được tài khoản "gốc"** (không có referrer) — dùng để khởi tạo mạng lưới ban đầu.

---

## 4. Vai trò người dùng

| Vai trò | Mô tả |
|---|---|
| **Super Admin** (1 tài khoản) | Tạo tài khoản "gốc"; xác minh (ngoài hệ thống) và duyệt (approve) hoặc từ chối (reject) Order do User tạo; thực hiện Redemption (trừ điểm đổi tiền mặt); xem toàn bộ lịch sử giao dịch điểm. |
| **User** (tất cả người còn lại) | Giới thiệu người khác tham gia (chia sẻ link mời hoặc mã giới thiệu của mình); tự tạo Order để báo cáo hoàn thành công việc; xem trạng thái Order của mình; xem số dư điểm & lịch sử giao dịch của bản thân. |

---

## 5. Khái niệm chính

- **Order**: bản ghi do User tự tạo, luôn gắn với chính User đó (tự báo cáo đã hoàn thành công việc ngoài hệ thống). Gồm: User tạo (= User thụ hưởng), ghi chú/tham chiếu (tùy chọn), trạng thái.
  - Trạng thái: `PENDING` (chờ Admin duyệt) → `APPROVED` (Admin duyệt, đã cộng điểm) hoặc → `REJECTED` (Admin từ chối).
  - Mỗi Order chỉ chuyển trạng thái đúng một lần từ `PENDING`; chỉ Super Admin có quyền chuyển trạng thái (User không tự hủy được).
- **Point Ledger**: sổ giao dịch điểm bất biến (append-only). Mỗi thay đổi điểm là một dòng, gồm: User liên quan, loại (`ORDER_REWARD` / `REFERRAL_BONUS` / `REDEMPTION`), số điểm (dương hoặc âm), thời điểm, tham chiếu tới Order (nếu có).
- **Point Wallet (số dư điểm)**: số điểm hiện có của một User — luôn suy ra/đối chiếu được từ tổng các dòng Point Ledger của User đó, không lưu tách rời khỏi sổ giao dịch nguồn.
- **Redemption**: hành động Super Admin trừ điểm của một User vì đã trả tiền mặt cho User đó ngoài hệ thống. Không có bước User xác nhận.

---

## 6. Luồng nghiệp vụ chi tiết

### 6.1. Đăng ký & giới thiệu
1. Người dùng mới đăng ký qua link mời (referrer tự động gán) hoặc tự nhập mã giới thiệu.
2. Tài khoản kích hoạt ngay, không cần duyệt.

### 6.2. Tạo & duyệt Order (kích hoạt cộng điểm)
1. User hoàn thành công việc thực tế (ngoài hệ thống).
2. **User tạo một Order ngay trong hệ thống**, tự gắn với chính mình, kèm ghi chú tùy chọn. Order ở trạng thái `PENDING`.
3. **Super Admin xác minh (ngoài hệ thống) và xem xét Order đang chờ duyệt.**
4. Nếu hợp lệ, Admin **duyệt (approve)**:
   - Order chuyển sang `APPROVED`.
   - Point Ledger ghi 1 dòng `ORDER_REWARD`: **+50 điểm** cho User đó.
   - Nếu User đó có referrer, Point Ledger ghi thêm 1 dòng `REFERRAL_BONUS`: **+10 điểm** cho referrer.
5. Nếu không hợp lệ, Admin **từ chối (reject)**: Order chuyển sang `REJECTED` — không phát sinh điểm nào.
6. Mỗi Order chỉ chuyển trạng thái từ `PENDING` đúng một lần (sang `APPROVED` hoặc `REJECTED`).
7. User không thể tự hủy/sửa Order sau khi đã tạo.
8. Số điểm cộng (50 và 10) là **hằng số cố định toàn hệ thống**, không cấu hình theo từng Order.

### 6.3. Đổi điểm lấy tiền mặt (Redemption)
1. Super Admin đã trả tiền mặt cho User ngoài hệ thống (quy trình chi trả nằm ngoài phạm vi).
2. Super Admin thực hiện thao tác **Redemption** trong hệ thống: chọn User, nhập số điểm cần trừ, kèm ghi chú tùy chọn.
3. Hệ thống trừ điểm ngay lập tức — **không cần User xác nhận**.
4. Point Ledger ghi 1 dòng `REDEMPTION` (số điểm âm) cho User đó.
5. Redemption chỉ thực hiện được nếu User có đủ số dư điểm hiện tại; nếu không đủ, thao tác bị từ chối.
6. Hệ thống **không lưu số tiền mặt quy đổi** — việc quy đổi điểm sang tiền là Admin tự tính toán ngoài hệ thống.

---

## 7. Quy tắc nghiệp vụ

- Điểm thưởng Order **chỉ** phát sinh sau khi Admin duyệt (approve) — không phát sinh khi User tạo Order.
- Mỗi Order chỉ chuyển trạng thái từ `PENDING` đúng một lần (sang `APPROVED` hoặc `REJECTED`); chỉ Super Admin có quyền chuyển trạng thái.
- Số điểm thưởng Order (50 trực tiếp / 10 gián tiếp) là hằng số hệ thống, áp dụng cho mọi Order.
- Hoa hồng gián tiếp chỉ tính đúng **một cấp** trên User tạo Order — không truy ngược thêm.
- Đăng ký luôn phải xác định được người giới thiệu; chỉ Super Admin tạo được tài khoản không có referrer.
- Mọi dòng Point Ledger là bất biến (append-only) — không sửa/xóa; muốn điều chỉnh phải tạo dòng mới.
- Số dư điểm (Point Wallet) của User luôn được tính lại từ Point Ledger gốc, không lưu số liệu "cứng" tách rời.
- Redemption chỉ thực hiện được khi số dư điểm đủ; không cho phép số dư điểm âm.

---

## 8. Yêu cầu chức năng theo vai trò

**Super Admin**
- FR1: Tạo tài khoản "gốc" (không referrer) để khởi tạo mạng lưới.
- FR2: Xem danh sách Order theo trạng thái (`PENDING`/`APPROVED`/`REJECTED`), lọc theo User.
- FR3: Duyệt (approve) một Order đang `PENDING`.
- FR4: Từ chối (reject) một Order đang `PENDING`.
- FR5: Thực hiện Redemption — trừ điểm của một User, kèm ghi chú tùy chọn.
- FR6: Xem lịch sử toàn bộ Point Ledger (đối soát), lọc theo User/thời gian/loại giao dịch.
- FR7: Xem số dư điểm hiện tại của bất kỳ User nào.

**User**
- FR8: Giới thiệu người khác tham gia (chia sẻ link mời hoặc mã giới thiệu của mình).
- FR9: Tự tạo Order để báo cáo hoàn thành công việc, kèm ghi chú tùy chọn.
- FR10: Xem trạng thái các Order mình đã tạo (`PENDING`/`APPROVED`/`REJECTED`).
- FR11: Xem số dư điểm & lịch sử giao dịch (Point Ledger) của bản thân.

---

## 9. Dữ liệu cần lưu (mức khái niệm)

Ở mức PRD, liệt kê dữ liệu cần có (không phải schema kỹ thuật đầy đủ — xem tech spec riêng):

- **User**: định danh, họ tên, vai trò (`SUPER_ADMIN`/`USER`), người giới thiệu (referrer, nullable), trạng thái hoạt động, số dư điểm (suy ra từ Point Ledger).
- **Order**: định danh, User tạo (= User thụ hưởng), ghi chú (tùy chọn), trạng thái (`PENDING`/`APPROVED`/`REJECTED`), người duyệt/từ chối (Super Admin), thời điểm tạo/duyệt/từ chối.
- **Point Ledger**: định danh, User liên quan, loại (`ORDER_REWARD`/`REFERRAL_BONUS`/`REDEMPTION`), số điểm (dấu +/-), Order liên kết (nếu có), ghi chú (nếu có, cho Redemption), thời điểm tạo.

---

## 10. Yêu cầu phi chức năng

- **Phân quyền (RBAC)**: User chỉ thấy dữ liệu của mình; Super Admin thấy toàn bộ.
- **Toàn vẹn dữ liệu**: cơ chế chống race-condition khi Admin duyệt/từ chối Order nhiều lần/đồng thời, hoặc khi Redemption bị submit trùng — đảm bảo mỗi Order chỉ tạo điểm đúng một lần, và số dư điểm không bao giờ âm.
- **Truy vết & đối soát**: mọi thao tác tạo Order, duyệt, từ chối, Redemption phải có lịch sử đầy đủ (ai, khi nào).
- **Quy mô**: dưới 1.000 User, tần suất thao tác thấp (Admin-driven, không có nhiều actor tranh chấp cùng lúc trên cùng một entity).
- **Kiến trúc lưu trữ điểm**: ở quy mô và các luồng nghiệp vụ hiện tại (không có chuyển điểm ngang hàng giữa 2 User, không có thao tác nào cần phối hợp atomic qua lại giữa 2 entity khác nhau), toàn bộ thao tác cộng/trừ điểm đều diễn tả được bằng một câu lệnh ghi có điều kiện duy nhất (kiểu compare-and-swap) trên một entity — không cần cơ chế điều phối phức tạp hơn (chi tiết kỹ thuật cụ thể để ở tech spec riêng). Nếu sau này có tính năng chuyển điểm ngang hàng giữa 2 User, cần đánh giá lại điểm này.

---

## 11. Giả định đã áp dụng cho phiên bản PRD này

- Hệ thống phục vụ một công ty XKLĐ duy nhất.
- Mạng lưới giới thiệu 1 cấp; điểm thưởng Order + điểm giới thiệu là hằng số cố định (50/10), không cấu hình theo từng Order.
- Tài khoản đăng ký qua link/mã giới thiệu kích hoạt ngay, không cần Admin duyệt.
- User tự tạo Order (luôn gắn với chính mình) để báo cáo hoàn thành; Super Admin duyệt hoặc từ chối; User không thể tự hủy Order sau khi tạo.
- Redemption do Admin thực hiện trực tiếp, không cần User xác nhận, không lưu số tiền mặt quy đổi.
- `life_point` và các hình thức đổi điểm khác ngoài Redemption tiền mặt được để lại cho phase sau.
