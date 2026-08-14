<?php
// WP core always renders its own <title> ("Site Title – Tagline" from Settings > General) before
// the custom <title> in WPCode's Global Header field, and browsers use the first <title> in
// <head> — so that shared global field's title text is dead weight, already overridden, not the
// one actually shown. Site Title/Tagline and the Global Header field are both shared with
// xklddieuduong.vn, so neither can be edited directly without changing the other domain too.
// This swaps the rendered title/meta client-side, scoped by host — same approach as
// header-swap.php — leaving both shared configs untouched. xklddieuduong.vn keeps "điều dưỡng"
// in its branding; nhatbanxkld.com drops it per 2026-08-09 rename.
//
// Hooked on wp_body_open (fires right after <body>), not wp_footer — by wp_body_open time
// <head> has already been fully sent, so title/meta are already in the DOM and get fixed
// immediately instead of only at the very end of the page load (was causing a visible flash
// of the old branding while the page loaded).
// PHẦN 2 (thêm 14/08/2026) — chạy PHÍA SERVER, không phải JS.
//
// og:* đã sạch, nhưng <title> của các trang danh mục vẫn lấy tên term: danh mục `don-hang` đang
// tên là "Đơn hàng điều dưỡng" nên Google hiện "Đơn hàng điều dưỡng – Xuất khẩu lao động Nhật
// Bản". Đổi thẳng tên term thì xklddieuduong.vn (dùng chung 1 bản WordPress) cũng mất chữ đó, nên
// lọc theo host giống các snippet khác.
//
// Bắt buộc phải là PHP: JS chỉ sửa document.title SAU khi trang tải xong, còn Google và trình
// xem trước link của Zalo/Facebook đọc HTML thô từ server — chúng không chạy JS, nên bản JS ở
// PHẦN 1 không bao giờ sửa được tiêu đề hiển thị trong kết quả tìm kiếm hay thẻ chia sẻ link.
add_filter('document_title_parts', function ($parts) {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return $parts;
    }
    foreach ($parts as $key => $value) {
        if (!is_string($value)) {
            continue;
        }
        // Bỏ cụm "điều dưỡng" (không phân biệt hoa thường, có dấu) rồi dọn khoảng trắng thừa.
        $cleaned = preg_replace('/\s*điều dưỡng\s*/iu', ' ', $value);
        $parts[$key] = trim(preg_replace('/\s+/u', ' ', $cleaned));
    }
    return array_filter($parts, function ($value) {
        return !is_string($value) || $value !== '';
    });
}, 20);

add_action('wp_body_open', function () {
    // Live copy: WPCode snippet ID 1396 ("nhatbanxkld.com: drop 'điều dưỡng' from title/SEO meta").
    // This file is only a mirror — editing it does not change the site.
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    ?>
    <script>
    (function () {
        document.title = 'Xuất khẩu lao động Nhật Bản | Cơ hội & Thu nhập ổn định';

        var metaMap = {
            'meta[name="description"]': 'Chương trình xuất khẩu lao động Nhật Bản: điều kiện, chi phí, lương thưởng và cơ hội làm việc lâu dài. Hỗ trợ tư vấn miễn phí!',
            'meta[name="keywords"]': 'xuất khẩu lao động Nhật Bản, XKLĐ Nhật Bản, đi Nhật làm việc, việc làm Nhật Bản, xuất khẩu lao động 2025',
            'meta[property="og:title"]': 'Xuất khẩu lao động Nhật Bản',
            'meta[property="og:description"]': 'Chương trình xuất khẩu lao động Nhật Bản: điều kiện, chi phí, lương thưởng và cơ hội làm việc lâu dài.',
            'meta[property="og:site_name"]': 'Xuất khẩu lao động Nhật Bản',
            'meta[name="twitter:title"]': 'Xuất khẩu lao động Nhật Bản',
            'meta[name="twitter:description"]': 'Thông tin chương trình đi Nhật: chi phí, điều kiện, lương thưởng và cơ hội định cư.'
        };

        Object.keys(metaMap).forEach(function (selector) {
            var el = document.querySelector(selector);
            if (el) {
                el.setAttribute('content', metaMap[selector]);
            }
        });
    })();
    </script>
    <?php
});
