<?php
// The 8-tab nav block in the shared Flatsome Header Builder ("custom-menu-grid") is the same
// static HTML on every domain sharing this WP install. nhatbanxkld.com needs its own
// relabeled/reordered version of those 8 tabs in the SAME header slot, while the other site
// (xklddieuduong.vn) keeps the original tabs unchanged. The Header Builder field itself is
// plain HTML (no PHP), so this swaps the header's content client-side, scoped by host only —
// the page body/content stays identical between both domains.
add_action('wp_footer', function () {
    // Live copy: WPCode snippet ID 1395 ("Demo subdomain: swap header 8-tab block").
    // This file is only a mirror — editing it does not change the site.
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    // Reuses the site's own .menu-item / .no-animation classes (already styled: 4-col grid,
    // navy/crimson checkerboard, zoom-in + pulse-glow animation) — same layout and colors as
    // the original header, just different labels/hrefs/order for these tabs.
    ?>
    <style>
    /* The original tabs' longer 2-line labels happen to force the grid's max-content width to
       ~fill its row; our shorter labels don't, so the row's flex-col wrapper (Flatsome's
       ".flex-col.flex-center", a sibling of a ".flex-grow" column) shrink-wraps to content
       instead of stretching, leaving big gaps on both sides instead of running edge-to-edge like
       the original. Force that wrapper (and its descendants) to take the full row width. */
    .header-bottom .flex-col.flex-center { flex: 1 1 auto; width: 100%; }
    .html_topbar_left { flex: 1 1 auto; width: 100%; }
    .custom-menu-grid { width: 100%; }
    </style>
    <script>
    (function () {
        var newTabsHtml = '<a href="/?danh-muc=quy-trinh-chi-phi-don" class="menu-item no-animation">Câu hỏi<br>đi Nhật</a>'
            + '<a href="/?danh-muc=hoc-vien-tai-nhat" class="menu-item">Đón tiếp<br>học viên</a>'
            + '<a href="/?danh-muc=dang-ky-don" class="menu-item no-animation">Đăng ký<br>đi Nhật</a>'
            + '<a href="/?danh-muc=phong-van-va-nhap-hoc" class="menu-item">Phỏng vấn<br>đơn hàng</a>'
            + '<a href="/?danh-muc=hoc-vien-xuat-canh" class="menu-item">Học viên<br>Xuất cảnh</a>'
            + '<a href="/?danh-muc=don-nam" class="menu-item no-animation">Đơn hàng<br>cho Nam</a>'
            + '<a href="/?danh-muc=don-nu" class="menu-item">Đơn hàng<br>cho Nữ</a>'
            + '<a href="https://xkld-tools-client.anhduc22601.workers.dev/login" class="menu-item no-animation">Kết nối</a>';

        var grids = document.querySelectorAll('.custom-menu-grid');
        for (var i = 0; i < grids.length; i++) {
            grids[i].innerHTML = newTabsHtml;
        }
    })();
    </script>
    <?php
}, 20);
