<?php
// demo.xklddieuduong.vn shares the exact same WP install/settings as xklddieuduong.vn (same
// document root, just a different domain). Settings > Reading is a single site-wide option, so
// setting "Trang chủ" (post 1348) as the front page there would also change the MAIN production
// site's homepage. Instead, filter the two options WordPress itself uses to resolve the front
// page — scoped to only fire when the request's Host header is the demo subdomain — so the main
// site's homepage is completely unaffected.
add_filter('option_show_on_front', function ($value) {
    if (($_SERVER['HTTP_HOST'] ?? '') === 'demo.xklddieuduong.vn') {
        return 'page';
    }
    return $value;
});
add_filter('option_page_on_front', function ($value) {
    if (($_SERVER['HTTP_HOST'] ?? '') === 'demo.xklddieuduong.vn') {
        return 1348;
    }
    return $value;
});
