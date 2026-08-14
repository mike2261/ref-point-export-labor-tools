<?php
// Bỏ khối video YouTube "Phỏng vấn đơn hàng điều dưỡng đi Nhật" ở trang chủ — yêu cầu 13/08/2026
// ("👉 chỗ video này xóa đi cho a nhé").
//
// KHÔNG sửa nội dung trang trong UX Builder: hai tên miền dùng chung một bản WordPress và chung
// một trang chủ, xoá trong builder là xklddieuduong.vn cũng mất theo. Cả snippet này chỉ chạy khi
// host là nhatbanxkld.com, nên xklddieuduong.vn giữ nguyên giao diện cũ.
//
// Hai lớp, cố ý làm cả hai:
//   1. CSS trong <head> — ẩn ngay từ lần vẽ đầu tiên, không có nháy hình. Iframe mang
//      loading="lazy" nên phần tử bị ẩn cũng không tải video về, đỡ luôn băng thông.
//   2. JS gỡ hẳn node khỏi DOM sau khi <body> mở — dọn sạch cho SEO và trình đọc màn hình.
//      JS bắt theo ID row, và bắt thêm theo chính mã video phòng khi trang chủ được lưu lại
//      trong UX Builder làm đổi ID row.
add_action('wp_head', function () {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    if (!is_front_page()) {
        return;
    }
    ?>
    <style>#row-131956572 { display: none !important; }</style>
    <?php
}, 99);

add_action('wp_body_open', function () {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    if (!is_front_page()) {
        return;
    }
    ?>
    <script>
    (function () {
        function drop() {
            var row = document.getElementById('row-131956572');
            if (row) {
                row.remove();
            }
            // Dự phòng: gỡ theo mã video, tính cả trường hợp ID row bị đổi khi sửa trang chủ.
            var frames = document.querySelectorAll('iframe[src*="g7rRducZZf8"]');
            for (var i = 0; i < frames.length; i++) {
                var el = frames[i];
                var block = el.closest('.row') || el.closest('.video') || el;
                block.remove();
            }
        }
        drop();
        // Khối video nằm giữa trang nên có thể chưa được parse lúc script này chạy.
        document.addEventListener('DOMContentLoaded', drop);
    })();
    </script>
    <?php
});
