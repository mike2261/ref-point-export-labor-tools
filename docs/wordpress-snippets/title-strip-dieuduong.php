<?php
// Sửa <title> (chữ hiện trên tab trình duyệt và trên kết quả Google) cho nhatbanxkld.com.
// Hai việc, cùng một filter:
//
//   1. Trang danh mục lấy tiêu đề theo ĐÚNG NHÃN TRÊN HEADER, không lấy tên term trong
//      WordPress — yêu cầu 14/08/2026. Tên term là tên cũ dùng chung với xklddieuduong.vn
//      ("Quy trình chi phí đơn", "Học viên tại Nhật", "Mọi người đăng ký"…), trong khi khách bấm
//      vào tab ghi "Câu hỏi đi Nhật", "Đón tiếp học viên", "Đăng ký đi Nhật"… Đổi thẳng tên term
//      thì site kia cũng đổi theo, nên map ở tầng title.
//      Nguồn nhãn: docs/wordpress-snippets/header-swap.php (khối 8 tab của nhatbanxkld.com).
//
//   2. Bỏ cụm "điều dưỡng" khỏi mọi trang còn lại — yêu cầu 13/08/2026 ("khi tìm kiếm và gửi
//      link thì bỏ hết chữ điều dưỡng đi"). Tên site và thẻ og:* đã sạch từ snippet 1396
//      (pre_option_blogname / pre_option_blogdescription), chỉ còn phần đầu của <title>.
//
// Bắt buộc là PHP chứ không phải JS: Google và trình xem trước link của Zalo/Facebook đọc HTML
// thô từ server, không chạy JS — sửa document.title sau khi tải trang không bao giờ tới được
// kết quả tìm kiếm hay thẻ chia sẻ link.
//
// Ưu tiên 20 để chạy sau các filter mặc định.
add_filter('document_title_parts', function ($parts) {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return $parts;
    }

    // slug danh mục => nhãn đúng như trên header.
    $tab_titles = array(
        'quy-trinh-chi-phi-don' => 'Câu hỏi đi Nhật',
        'hoc-vien-tai-nhat'     => 'Đón tiếp học viên',
        'dang-ky-don'           => 'Đăng ký đi Nhật',
        'phong-van-va-nhap-hoc' => 'Phỏng vấn đơn hàng',
        'hoc-vien-xuat-canh'    => 'Học viên xuất cảnh',
        'don-nam'               => 'Đơn hàng cho Nam',
        'don-nu'                => 'Đơn hàng cho Nữ',
    );

    if (is_tax('product_cat')) {
        $term = get_queried_object();
        if ($term instanceof WP_Term && isset($tab_titles[$term->slug])) {
            // Ghi đè hẳn phần tiêu đề; phần đuôi (tên site) do WordPress tự nối, giữ nguyên.
            $parts['title'] = $tab_titles[$term->slug];
            return $parts;
        }
    }

    // Các trang khác: chỉ cắt chữ "điều dưỡng", dọn khoảng trắng thừa, và bỏ phần tử rỗng sau khi
    // cắt (ví dụ một term tên đúng bằng "Điều dưỡng") để WordPress không nối ra dấu gạch thừa.
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
