<?php
// Bỏ cụm "điều dưỡng" khỏi <title> trên nhatbanxkld.com — yêu cầu 13/08/2026 ("khi tìm kiếm và
// gửi link thì bỏ hết chữ điều dưỡng đi").
//
// Tên site và thẻ og:* đã sạch (snippet 1396 lo phần đó qua pre_option_blogname /
// pre_option_blogdescription), nhưng phần đầu của <title> lấy từ tên danh mục: term 'don-hang'
// đang tên "Đơn hàng điều dưỡng" nên Google hiện "Đơn hàng điều dưỡng – Xuất khẩu lao động Nhật
// Bản". Đổi thẳng tên term thì xklddieuduong.vn (dùng chung một bản WordPress) cũng mất chữ đó,
// nên lọc theo host y như các snippet khác.
//
// Bắt buộc là PHP chứ không phải JS: Google và trình xem trước link của Zalo/Facebook đọc HTML
// thô từ server, không chạy JS — sửa document.title sau khi tải trang không bao giờ tới được
// kết quả tìm kiếm hay thẻ chia sẻ link.
//
// Ưu tiên 20 để chạy sau các filter mặc định. Chỉ đụng tới các phần tử là chuỗi, và bỏ luôn phần
// tử rỗng sau khi cắt (ví dụ một term tên đúng bằng "Điều dưỡng") để WordPress không nối ra dấu
// gạch thừa.
add_filter('document_title_parts', function ($parts) {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return $parts;
    }
    foreach ($parts as $key => $value) {
        if (!is_string($value)) {
            continue;
        }
        $cleaned = preg_replace('/\s*điều dưỡng\s*/iu', ' ', $value);
        $parts[$key] = trim(preg_replace('/\s+/u', ' ', $cleaned));
    }
    return array_filter($parts, function ($value) {
        return !is_string($value) || $value !== '';
    });
}, 20);
