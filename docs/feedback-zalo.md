# Checklist feedback Zalo — nhóm "SỬA WEB"

Nguồn: nhóm Zalo **SỬA WEB** (Nguyễn Quang Xklđ Nhật Bản ↔ Mai Đức), các ảnh gửi
**13/08/2026 15:11–15:12**, cộng feedback trong chat 1-1 **12/08/2026 15:15**.

Trạng thái tính đến **14/08/2026**: `[x]` đã xong trong code · `[ ]` còn phải làm · `[?]` cần
anh Quang xác nhận lại.

**Tổng: 22 mục — 20 đã xong, 1 chờ dán lên site, 1 chưa rõ.**

---

## ⚠️ CÒN PHẢI LÀM

- [ ] **Dán 2 snippet PHP vào WPCode trên site.** Hai file trong repo chỉ là bản mirror, sửa ở
      repo không đổi gì trên web thật:
      `docs/wordpress-snippets/jp-custom-archive.php` (hiển thị bài đăng của 5 danh mục mới) và
      `docs/wordpress-snippets/seo-title-meta-swap.php` (bỏ "điều dưỡng" khỏi tiêu đề).
      Dán xong kiểm tra `https://nhatbanxkld.com/?danh-muc=don-hang`: bài đăng phải lên và tiêu
      đề tab hết chữ "điều dưỡng".
- [?] **"👉 chỗ video này xóa đi cho a nhé"** — video gửi kèm trong nhóm, chưa xem được nội
      dung. Có thể là banner cảnh báo số dư 0 đã comment-out ở commit `6aaaeb3`, nhưng cần anh
      Quang chỉ lại chỗ cần xoá.

---

## 1. Đổi toàn bộ "điểm" → "tiền" (1 điểm = 10.000đ)

Quy đổi nằm ở tầng hiển thị: DB vẫn lưu `points`, client dùng `src/lib/money.ts`, thông báo dùng
`src/domain/notifications/messages.ts` — hai nơi phải giữ chung tỷ lệ `VND_PER_POINT`.
Commit: `4695f7e` (backend) · `7e04730` (client).

- [x] "điểm cá nhân" → **Tiền cá nhân**
- [x] "điểm thưởng" → **Tiền thưởng**
- [x] "điểm hoa hồng" → **Tiền hoa hồng**
- [x] "Đổi điểm" → **Đổi tiền**; nhãn rút → **Rút tiền**
- [x] Mọi con số nhân 10.000, ngăn cách kiểu Việt: `100` → `1.000.000`, `500` → `5.000.000`,
      `1000` → `10.000.000`
- [x] Dòng cộng/trừ: `+100` → `+1.000.000`, `-100` → `-1.000.000`
- [x] Quy định màu: cộng tiền **xanh**, rút tiền **đỏ** (`vndToneClass`)
- [x] Bỏ chip "đã cộng 1 · đã đổi 1" và banner "bạn đã đổi 1 điểm" ở đầu trang — lịch sử đã nằm
      ở các dòng bên dưới
- [x] Thưởng do admin cấp hiện đúng số tiền admin nhập (không còn "+1 điểm")
- [x] Admin nhập **số tiền VNĐ** ở modal đổi tiền và trang thưởng, quy đổi ngược về điểm khi gọi
      API (`vndToPoints` báo lỗi nếu số tiền không chia hết cho 10.000)
- [x] Thông báo không còn chữ "điểm" — có test chặn hồi quy
- [x] Ghi chú quyết toán trong sổ: "Thanh toán tiền giới thiệu khách hàng" / "Quyết toán rút
      tiền đăng ký" / "Thanh toán tiền thưởng", bỏ hẳn "admin đã chi tiền mặt". Các dòng cũ
      trong DB đổi bằng `migrations/0015_settlement_notes_money_wording.sql`
- [x] Dòng liên hệ: "Liên hệ quản trị viên qua Zalo để được xác nhận và quy đổi ra tiền mặt"
- [x] Bỏ số điện thoại khách của CTV tuyến dưới ở màn "Từ CTV giới thiệu" — chỉ còn tên CTV,
      tên khách, mã đơn

## 2. Đăng bài — 5 mục 1 ảnh

Câu hỏi đi Nhật · Đón tiếp học viên · Đăng ký đi Nhật · Phỏng vấn đơn hàng · Học viên xuất cảnh.
Commit: `97506cc` (client) · `b35b965` (snippet WP).

- [x] Bỏ ô **Mô tả** trong form đăng bài — chỉ còn Tiêu đề + Ảnh
      (`src/components/admin/SingleImageJobPostForm.tsx`)
- [x] Khung tải ảnh chuyển sang **vuông 1:1** cho khớp loại ảnh anh đăng
- [x] **"Đã đăng bài nhưng chưa lên web"** — nguyên nhân: `jp-custom-archive.php` chỉ bắt
      `don-nam`/`don-nu`, 5 danh mục này rơi về archive mặc định của theme. Đã mở rộng template
      cho cả 7 danh mục: mỗi bài là 1 ô **ảnh vuông + tiêu đề**, bấm vào mở xem lớn, mới nhất
      trước
- [x] **Co khoảng trống dưới header** — 5 mục này dùng chung template nên được kéo lên giống Đơn
      nam/Đơn nữ, không còn khoảng trắng lớn

## 3. Trang web nhatbanxkld.com — bỏ chữ "điều dưỡng"

Commit: `2909da0`.

- [x] og:title / og:description / meta description đã sạch
- [x] `<title>` trang danh mục còn "Đơn hàng điều dưỡng" (tên term dùng chung với
      xklddieuduong.vn) → thêm filter `document_title_parts` **chạy phía server**, scope theo
      host. Bản JS cũ không sửa được kết quả Google và thẻ xem trước link Zalo/Facebook vì
      crawler không chạy JS

## 4. Thành tích CTV / Hướng dẫn CTV

Commit: `ed67da4`, `e227b25` (ảnh) · `1f242d0` (bỏ mô tả).

- [x] Ảnh ngang 16:9, không bị cắt, ở cả danh sách và trang chi tiết
- [x] Bấm xem ảnh không bị phóng to quá khổ (`object-contain`)
- [x] Nút quay lại tách khỏi ảnh, có khoảng cách phía trên
- [x] "chỉ cần tiêu đề và ảnh, bỏ phần mô tả" — bỏ ô Nội dung ở form đăng/sửa bài thành tích và
      bỏ hiển thị mô tả ở danh sách + trang chi tiết. Mô tả cũ vẫn nằm nguyên trong DB (PATCH
      không gửi `description` nữa) nên đảo lại được nếu đổi ý.
      **Hướng dẫn CTV giữ nguyên mô tả** vì tin nhắn chỉ nói về mục Thành tích CTV

---

## Kiểm chứng

- Backend `npx vitest run`: **176/176 pass** (16 file)
- Client `npx tsc --noEmit`: sạch · `npx vite build`: thành công
- `php -l` cả 2 snippet: không lỗi cú pháp
