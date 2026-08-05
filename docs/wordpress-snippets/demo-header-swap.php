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
    ?>
    <script>
    (function () {
        var newTabsHtml = '<a href="/?danh-muc=quy-trinh-chi-phi-don" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#e91e8c;color:#fff;font-weight:bold;border-radius:6px;text-decoration:none;">Câu hỏi<br>đi Nhật</a>'
            + '<a href="/?danh-muc=hoc-vien-tai-nhat" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#f5c518;color:#1a1a1a;font-weight:bold;border-radius:6px;text-decoration:none;">Đón tiếp<br>học viên</a>'
            + '<a href="/?danh-muc=dang-ky-don" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#e91e8c;color:#fff;font-weight:bold;border-radius:6px;text-decoration:none;">Đăng ký<br>đi Nhật</a>'
            + '<a href="/?danh-muc=phong-van-va-nhap-hoc" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#f5c518;color:#1a1a1a;font-weight:bold;border-radius:6px;text-decoration:none;">Phỏng vấn<br>đơn hàng</a>'
            + '<a href="/?danh-muc=hoc-vien-xuat-canh" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#f5c518;color:#1a1a1a;font-weight:bold;border-radius:6px;text-decoration:none;">Học viên<br>Xuất cảnh</a>'
            + '<a href="/?danh-muc=don-nam" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#e91e8c;color:#fff;font-weight:bold;border-radius:6px;text-decoration:none;">Đơn hàng<br>cho Nam</a>'
            + '<a href="/?danh-muc=don-nu" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#e91e8c;color:#fff;font-weight:bold;border-radius:6px;text-decoration:none;">Đơn hàng<br>cho Nữ</a>'
            + '<a href="https://xkld-tools-client.anhduc22601.workers.dev/register" style="flex:1 1 200px;text-align:center;padding:16px 10px;background:#e91e8c;color:#fff;font-weight:bold;border-radius:6px;text-decoration:none;">Kết nối</a>';

        var grids = document.querySelectorAll('.custom-menu-grid');
        for (var i = 0; i < grids.length; i++) {
            grids[i].style.display = 'flex';
            grids[i].style.flexWrap = 'wrap';
            grids[i].style.gap = '6px';
            grids[i].innerHTML = newTabsHtml;
        }
    })();
    </script>
    <?php
}, 20);
