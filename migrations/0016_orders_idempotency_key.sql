-- Khoá chống gửi trùng cho lệnh kích hoạt khách hàng, chuyển từ point_ledger sang orders.
--
-- Bối cảnh (15/08/2026): kích hoạt khách không còn tự tất toán ví CTV nữa — admin trả tiền bằng
-- chức năng rút tiền thủ công. Trước đây khoá idempotency được gắn vào chính dòng REDEMPTION mà
-- hàm activateCustomer ghi ra; point_ledger có CHECK ràng chỉ dòng REDEMPTION mới được mang khoá
-- (`(idempotency_key IS NOT NULL) = (type = 'REDEMPTION')`), nên bỏ dòng rút đi thì không còn chỗ
-- nào giữ khoá — bấm hai lần sẽ tạo hai đơn và cộng tiền hai lần.
--
-- Cột nullable + partial unique index: đơn cũ (trước migration này) không có khoá, và unique index
-- có WHERE nên nhiều dòng NULL vẫn hợp lệ. ADD COLUMN đơn giản, không phải dựng lại bảng.

ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX uq_orders_idem
  ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
