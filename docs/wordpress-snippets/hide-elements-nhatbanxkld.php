<?php
// Ẩn các phần tử chỉ bỏ trên nhatbanxkld.com, xklddieuduong.vn giữ nguyên:
//
//   A. Khối "PHỎNG VẤN HỌC VIÊN" ở trang chủ (tiêu đề + video YouTube nhúng bên dưới) — yêu cầu
//      13/08/2026 ("👉 chỗ video này xóa đi cho a nhé") và 14/08/2026 ("bỏ cả cái text phỏng vấn
//      học viên ấy").
//   B. Nút "ĐĂNG KÝ" đỏ dính ở góc trái dưới, mọi trang — yêu cầu 14/08/2026 ("Cái chỗ đăng ký ở
//      trên Web em bỏ đi giúp anh nhé"). Nút này trỏ sang xklddieuduong.vn/?page_id=509 nên càng
//      không nên còn trên site mới. Class .form-btn chỉ dùng đúng cho nút này (kiểm tra HTML:
//      1 khai báo CSS + 1 phần tử), nên ẩn theo class là đủ hẹp.
//
// KHÔNG sửa nội dung trang trong UX Builder: hai tên miền dùng chung một bản WordPress và chung
// một trang chủ, xoá trong builder là xklddieuduong.vn cũng mất theo. Cả snippet này chỉ chạy khi
// host là nhatbanxkld.com, nên xklddieuduong.vn giữ nguyên giao diện cũ.
//
// KHÔNG bắt theo ID: Flatsome sinh lại id="section_..." và id="row-..." NGẪU NHIÊN mỗi lần render
// (đã kiểm chứng 14/08/2026: cùng một trang, ba lần tải cho ba ID khác nhau). Bản đầu của snippet
// này bắt theo #row-131956572 nên phần CSS chưa bao giờ khớp — chỉ nhánh JS dự phòng chạy. Neo
// duy nhất ổn định là chính mã video, nên cả hai lớp đều bám vào nó.
//
// Section này chỉ chứa đúng tiêu đề + video (đã kiểm tra HTML), nên bỏ cả section là đúng ý.
//
// Hai lớp, cố ý làm cả hai:
//   1. CSS :has() trong <head> — ẩn ngay từ lần vẽ đầu tiên, không nháy hình. Iframe mang
//      loading="lazy" nên phần tử bị ẩn cũng không tải video về.
//   2. JS gỡ hẳn section khỏi DOM — dọn sạch cho SEO/trình đọc màn hình, và là đường lui cho
//      trình duyệt cũ chưa hỗ trợ :has().
add_action('wp_head', function () {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    ?>
    <style>
    section:has(iframe[src*="g7rRducZZf8"]),
    .row:has(iframe[src*="g7rRducZZf8"]) { display: none !important; }
    .form-btn { display: none !important; }
    </style>
    <?php
}, 99);

add_action('wp_body_open', function () {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    ?>
    <script>
    (function () {
        function drop() {
            var frames = document.querySelectorAll('iframe[src*="g7rRducZZf8"]');
            for (var i = 0; i < frames.length; i++) {
                var el = frames[i];
                // Bỏ cả section (tiêu đề + video). Nếu vì lý do nào đó không có section bọc
                // ngoài thì lui dần: hết .row tới chính khối video.
                var block = el.closest('section') || el.closest('.row') || el.closest('.video') || el;
                block.remove();
            }
        }
        drop();
        // Khối này nằm giữa trang nên lúc script chạy có thể chưa được parse tới.
        document.addEventListener('DOMContentLoaded', drop);
    })();
    </script>
    <?php
});
