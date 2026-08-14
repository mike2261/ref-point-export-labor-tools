# Feedback từ nhóm Zalo "SỬA WEB"

Nguồn: nhóm Zalo **SỬA WEB** (Nguyễn Quang Xklđ Nhật Bản ↔ Mai Đức), các ảnh gửi ngày
**13/08/2026 15:11–15:12**, cộng phần feedback trong chat 1-1 ngày **12/08/2026 15:15**.

Trạng thái tính đến **14/08/2026**. `[x]` = đã sửa xong trong code, `[ ]` = chưa làm,
`[?]` = cần anh Quang xác nhận lại.

---

## 1. Đổi toàn bộ "điểm" → "tiền" (1 điểm = 10.000đ)

Quy đổi nằm ở tầng hiển thị: DB vẫn lưu `points`, client dùng `client/src/lib/money.ts`, thông
báo dùng `src/domain/notifications/messages.ts`. Hai nơi phải giữ chung tỷ lệ `VND_PER_POINT`.

- [x] "điểm cá nhân" → **Tiền cá nhân**
- [x] "điểm thưởng" → **Tiền thưởng**
- [x] "điểm hoa hồng" → **Tiền hoa hồng**
- [x] "Đổi điểm" → **Đổi tiền**; nút/nhãn rút → **Rút tiền**
- [x] Mọi con số nhân 10.000 và ngăn cách kiểu Việt: `100` → `1.000.000`, `500` → `5.000.000`,
      `1000` → `10.000.000`
- [x] Dòng cộng/trừ: `+100` → `+1.000.000`, `-100` → `-1.000.000`
- [x] Quy định màu: cộng tiền **xanh**, rút tiền **đỏ** (`vndToneClass`)
- [x] Bỏ các chip "đã cộng 1 · đã đổi 1" và banner "bạn đã đổi 1 điểm" ở đầu trang — lịch sử
      nằm ở các dòng bên dưới
- [x] Thưởng do admin cấp hiện đúng số tiền admin nhập (không còn "+1 điểm")
- [x] Admin nhập **số tiền** (VNĐ) ở modal đổi tiền và trang thưởng; quy đổi ngược về điểm khi
      gọi API (`vndToPoints`, báo lỗi nếu số tiền không chia hết cho 10.000)
- [x] Thông báo (notification) không còn chữ "điểm" — có test chặn hồi quy
- [x] Ghi chú quyết toán trong sổ:
      "Thanh toán tiền giới thiệu khách hàng" / "Quyết toán rút tiền đăng ký" /
      "Thanh toán tiền thưởng" — bỏ hẳn "admin đã chi tiền mặt".
      Các dòng cũ trong DB được đổi bằng `migrations/0015_settlement_notes_money_wording.sql`
- [x] Dòng liên hệ: "Liên hệ quản trị viên qua Zalo để được xác nhận và quy đổi ra tiền mặt"
- [x] Bỏ số điện thoại khách của CTV tuyến dưới ở màn "Từ CTV giới thiệu" (chỉ còn tên CTV +
      tên khách + mã đơn)

## 2. Đăng bài (5 mục 1 ảnh: Câu hỏi đi Nhật, Đón tiếp học viên, Đăng ký đi Nhật, Phỏng vấn đơn hàng, Học viên xuất cảnh)

- [x] Bỏ ô **Mô tả** trong form đăng bài — chỉ còn Tiêu đề + Ảnh
      (`client/src/components/admin/SingleImageJobPostForm.tsx`)
- [x] Khung tải ảnh chuyển sang **vuông** (1:1) để đúng loại ảnh anh đăng
- [x] **Bài đăng không lên web**: 5 danh mục này chưa có template riêng nên rơi về archive mặc
      định của theme. Đã mở rộng `docs/wordpress-snippets/jp-custom-archive.php` cho cả 7 danh
      mục — mỗi bài là 1 ô **ảnh vuông + tiêu đề**, bấm vào ảnh mở xem lớn, sắp xếp mới nhất
      trước. ⚠️ Cần dán bản mới vào WPCode trên site thì mới có hiệu lực.
- [x] **Co khoảng trống dưới header**: dùng chung template ở trên nên 5 mục này được kéo lên
      giống Đơn nam/Đơn nữ (`margin-top: -50px`), không còn khoảng trắng lớn

## 3. Trang web nhatbanxkld.com

- [x] og:title / og:description / meta description đã sạch chữ "điều dưỡng"
- [x] `<title>` trang danh mục vẫn còn "Đơn hàng điều dưỡng" (tên term dùng chung với
      xklddieuduong.vn). Đã thêm filter PHP **chạy phía server** vào
      `docs/wordpress-snippets/seo-title-meta-swap.php` — bản JS cũ không sửa được kết quả
      Google và thẻ xem trước link vì crawler không chạy JS.
      ⚠️ Cần dán bản mới vào WPCode trên site thì mới có hiệu lực.

## 4. Thành tích CTV / Hướng dẫn CTV

- [x] Ảnh ngang 16:9, không bị cắt, ở cả danh sách và trang chi tiết
- [x] Xem ảnh không bị phóng to quá khổ (`object-contain`)
- [x] Nút quay lại tách khỏi ảnh, có khoảng cách phía trên
- [x] "chỉ cần tiêu đề và ảnh, bỏ phần mô tả" — đã bỏ ô Nội dung ở form đăng/sửa bài thành tích
      và bỏ hiển thị mô tả ở danh sách + trang chi tiết của CTV. Mô tả cũ vẫn nằm nguyên trong
      DB (PATCH không còn gửi `description`), chỉ là không hiện và không sửa được nữa — nếu anh
      Quang đổi ý thì bỏ comment lại là có ngay.
      **Hướng dẫn CTV giữ nguyên mô tả** vì tin nhắn chỉ nói về mục Thành tích CTV.

## 5. Chưa rõ

- [?] "👉 chỗ video này xóa đi cho a nhé" — video gửi kèm trong nhóm. Có thể là banner/cảnh báo
      số dư 0 đã comment-out ở commit `6aaaeb3`, nhưng cần xem lại video để chắc.
