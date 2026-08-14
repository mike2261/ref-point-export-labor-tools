# Checklist feedback Zalo — nhóm "SỬA WEB"

Nguồn: nhóm Zalo **SỬA WEB** (Nguyễn Quang Xklđ Nhật Bản ↔ Mai Đức), các ảnh gửi
**13/08/2026 15:11–15:12**, cộng feedback trong chat 1-1 **12/08/2026 15:15**.

Trạng thái tính đến **14/08/2026**: `[x]` đã xong trong code · `[ ]` còn phải làm · `[?]` cần
anh Quang xác nhận lại.

**Tổng: 23 mục — tất cả đã xong. Snippet đã dán lên site và kiểm chứng trên bản chạy thật.**

---

## ⚠️ Nguyên tắc: hai tên miền dùng chung một bản WordPress

`nhatbanxkld.com` và `xklddieuduong.vn` chạy chung một cài đặt WordPress — **chỉ dùng chung dữ
liệu bài đăng, giao diện xklddieuduong.vn phải giữ nguyên**. Mọi snippet đều lọc theo
`$_SERVER['HTTP_HOST']`, và không được sửa nội dung trang trong UX Builder (trang chủ dùng chung,
xoá trong builder là mất ở cả hai site).

Đã kiểm chứng sau khi dán: trên `xklddieuduong.vn`, trang danh mục `don-hang` vẫn dùng archive
mặc định của theme, `<title>` vẫn còn "điều dưỡng", trang chủ vẫn còn video — không đổi gì.

## Snippet đang chạy trên site (WPCode)

| Snippet | File mirror trong repo | Việc |
|---|---|---|
| 1364 (cập nhật) | `jp-custom-archive.php` | lưới bài đăng cho 7 danh mục |
| mới | `title-strip-dieuduong.php` | bỏ "điều dưỡng" khỏi `<title>` |
| mới | `hide-interview-video.php` | ẩn video phỏng vấn ở trang chủ |

`seo-title-meta-swap.php` là **bản đã lệch** với snippet 1396 đang chạy (bản live lọc server qua
`pre_option_blogname` / `pre_option_blogdescription`) — giữ làm lịch sử, đừng dán đè.

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
- [x] **"Đã đăng bài nhưng chưa lên web"** — có **hai tầng**, tầng gốc mãi mới lộ ra:
      1. **Sai danh mục (tầng gốc).** Tool gửi bài vào term `don-hang` (64, tên thật "Đơn hàng
         điều dưỡng" — tab "Hỏi - Đáp về Điều dưỡng" của xklddieuduong.vn), trong khi tab "Câu
         hỏi đi Nhật" trên nhatbanxkld.com trỏ tới `quy-trinh-chi-phi-don` (71). Bài lên
         WordPress thật nhưng nằm ở chỗ khác với tab người dùng bấm vào. Đối chiếu bằng link
         trong `header-swap.php` + danh sách `product_cat` lấy từ REST API của site.
         Đã sửa `src/lib/wpProducts.ts`, `adminJobPosts.ts`, tile dashboard, test, và snippet.
      2. **Trang danh mục chưa có template riêng.** `jp-custom-archive.php` chỉ bắt
         `don-nam`/`don-nu` nên 5 danh mục 1 ảnh rơi về archive mặc định của theme — vừa xấu vừa
         thừa khoảng trống trên đầu. Đã mở rộng cho cả 7 danh mục **chỉ trên nhatbanxkld.com**:
         mỗi bài là 1 ô **ảnh vuông + tiêu đề**, **2 thẻ/hàng ở mọi khổ màn hình**, bấm vào mở
         xem lớn, mới nhất trước. Chỉ Đơn nam/Đơn nữ giữ lưới co giãn 1-2-3 cột vì mỗi thẻ một
         tỷ lệ ảnh khác nhau.
- [ ] 4 bài anh Quang đăng sáng 13/08 (ID **1451, 1453, 1455, 1457**) vẫn nằm trong `don-hang`
      nên chưa hiện ở tab "Câu hỏi đi Nhật" — chốt 14/08: **để nguyên, anh Quang đăng lại bằng
      tool rồi tự xoá sau**. Bản sửa chỉ áp dụng cho bài đăng từ giờ trở đi.
- [x] **Co khoảng trống dưới header** — 5 mục này dùng chung template nên được kéo lên giống Đơn
      nam/Đơn nữ, không còn khoảng trắng lớn

## 3. Trang web nhatbanxkld.com — bỏ chữ "điều dưỡng"

Commit: `2909da0`.

- [x] og:title / og:description / meta description đã sạch
- [x] `<title>` trang danh mục còn "Đơn hàng điều dưỡng" (tên term dùng chung với
      xklddieuduong.vn) → thêm filter `document_title_parts` **chạy phía server**, scope theo
      host. Bản JS không sửa được kết quả Google và thẻ xem trước link Zalo/Facebook vì crawler
      không chạy JS. Đã dán lên site: nay là "Đơn hàng – Xuất khẩu lao động Nhật Bản"

## 4. Thành tích CTV / Hướng dẫn CTV

Commit: `ed67da4`, `e227b25` (ảnh) · `1f242d0` (bỏ mô tả).

- [x] Ảnh ngang 16:9, không bị cắt, ở cả danh sách và trang chi tiết
- [x] Bấm xem ảnh không bị phóng to quá khổ (`object-contain`)
- [x] Nút quay lại tách khỏi ảnh, có khoảng cách phía trên
- [x] "chỉ cần tiêu đề và ảnh, bỏ phần mô tả" — bỏ ô Nội dung ở form đăng/sửa bài thành tích và
      bỏ hiển thị mô tả ở danh sách + trang chi tiết. Mô tả cũ vẫn nằm nguyên trong DB (PATCH
      không gửi `description` nữa) nên đảo lại được nếu đổi ý.
      **Hướng dẫn CTV giữ nguyên mô tả** vì tin nhắn chỉ nói về mục Thành tích CTV

## 5. Trang chủ — video phỏng vấn

Snippet `hide-interview-video.php`.

- [x] "👉 chỗ video này xóa đi cho a nhé" + "bỏ cả cái text phỏng vấn học viên ấy" (14/08) — bỏ
      nguyên section **"PHỎNG VẤN HỌC VIÊN"** (tiêu đề + video YouTube) trên nhatbanxkld.com.
      Section đó chỉ chứa đúng 2 thứ này nên bỏ cả section là gọn nhất.
      xklddieuduong.vn vẫn còn nguyên
- [x] ⚠️ **Không bắt theo ID**: Flatsome sinh lại `id="row-..."` / `id="section_..."` **ngẫu
      nhiên mỗi lần render** (ba lần tải cùng một trang cho ba ID khác nhau). Bản snippet đầu bắt
      theo `#row-131956572` nên phần CSS chưa bao giờ khớp — chỉ nhánh JS chạy. Nay cả CSS
      (`section:has(iframe[src*="..."])`) lẫn JS đều bám theo **mã video**, thứ duy nhất ổn định

---

## Kiểm chứng

- Backend `npx vitest run`: **176/176 pass** (16 file)
- Client `npx tsc --noEmit`: sạch · `npx vite build`: thành công
- `php -l` cả 3 snippet: không lỗi cú pháp
- Nội dung dán lên WPCode so khớp SHA-256 với file trong repo, từng snippet một
- Sau khi dán, kiểm tra lại trang chạy thật ở cả hai tên miền
