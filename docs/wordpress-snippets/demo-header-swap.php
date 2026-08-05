<?php
// The 8-tab nav block in the shared Flatsome Header Builder ("custom-menu-grid") is the same
// static HTML on every domain sharing this WP install. The demo subdomain needs its own
// relabeled/reordered version of those 8 tabs in the SAME header slot, while the main production
// site (xklddieuduong.vn) keeps the original tabs unchanged. The Header Builder field itself is
// plain HTML (no PHP), so this swaps the header's content client-side, scoped to the demo host
// only — the page body/content stays identical between both domains.
add_action('wp_footer', function () {
    if (($_SERVER['HTTP_HOST'] ?? '') !== 'demo.xklddieuduong.vn') {
        return;
    }
    // Reuses the site's own .menu-item / .no-animation classes (already styled: 4-col grid,
    // navy/crimson checkerboard, zoom-in + pulse-glow animation) — same layout and colors as
    // the original header, just different labels/hrefs/order for the demo tabs.
    ?>
    <script>
    (function () {
        var newTabsHtml = '<a href="/?danh-muc=quy-trinh-chi-phi-don" class="menu-item no-animation">Câu hỏi<br>đi Nhật</a>'
            + '<a href="/?danh-muc=hoc-vien-tai-nhat" class="menu-item">Đón tiếp<br>học viên</a>'
            + '<a href="/?danh-muc=dang-ky-don" class="menu-item no-animation">Đăng ký<br>đi Nhật</a>'
            + '<a href="/?danh-muc=phong-van-va-nhap-hoc" class="menu-item">Phỏng vấn<br>đơn hàng</a>'
            + '<a href="/?danh-muc=hoc-vien-xuat-canh" class="menu-item">Học viên<br>Xuất cảnh</a>'
            + '<a href="/?danh-muc=don-nam" class="menu-item no-animation">Đơn hàng<br>cho Nam</a>'
            + '<a href="/?danh-muc=don-nu" class="menu-item">Đơn hàng<br>cho Nữ</a>'
            + '<a href="https://xkld-tools-client.anhduc22601.workers.dev/register" class="menu-item no-animation">Kết nối</a>';

        var grids = document.querySelectorAll('.custom-menu-grid');
        for (var i = 0; i < grids.length; i++) {
            grids[i].innerHTML = newTabsHtml;
        }
    })();
    </script>
    <?php
}, 20);
