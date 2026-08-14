-- Đổi chữ "điểm" → "tiền" trong các ghi chú quyết toán đã ghi vào sổ.
--
-- Chỉ sửa TEXT, không đụng tới cột `points` — tỷ lệ quy đổi 1 điểm = 10.000đ nằm ở tầng hiển thị
-- (client/src/lib/money.ts + src/domain/notifications/messages.ts), số dư trong DB giữ nguyên.
--
-- Ba chuỗi dưới đây là hằng số DIRECT_ACTIVATION_REDEMPTION_NOTE_* trong src/lib/orders.ts, được
-- ghi nguyên văn vào point_ledger.note mỗi lần admin kích hoạt khách. Các dòng cũ trong production
-- vẫn mang bản cũ, nên phải cập nhật tại chỗ thì lịch sử mới đọc thống nhất với bản ghi mới.
-- WHERE khớp đúng toàn bộ chuỗi cũ ⇒ chạy lại nhiều lần cũng không đổi thêm gì (idempotent).

UPDATE point_ledger
   SET note = 'Thanh toán tiền giới thiệu khách hàng'
 WHERE note = 'Quyết toán điểm giới thiệu khách hàng khi kích hoạt khách — admin đã chi tiền mặt';

UPDATE point_ledger
   SET note = 'Quyết toán rút tiền đăng ký'
 WHERE note = 'Quyết toán điểm thưởng đăng ký khi kích hoạt khách — admin đã chi tiền mặt';

UPDATE point_ledger
   SET note = 'Thanh toán tiền thưởng'
 WHERE note = 'Quyết toán toàn bộ điểm thưởng khi kích hoạt khách — admin đã chi tiền mặt';
