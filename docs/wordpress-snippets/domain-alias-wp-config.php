<?php
// APPLIED 2026-08-08 to /home/tjfdzbikhosting/public_html/wp-config.php on the iNET cPanel
// host. This file is only a mirror of what lives there — editing it does not change the site.
//
// Lives in wp-config.php (above the "That's all, stop editing!" line), NOT in WPCode —
// WPCode snippets run too late, after WP has already decided to redirect.
//
// One WP install serves both xklddieuduong.vn and nhatbanxkld.com off the same document root.
// The database's siteurl/home hold a single value, so WP's canonical redirect sends every
// request for the "other" domain back to that one — visiting nhatbanxkld.com would bounce to
// xklddieuduong.vn. Overriding WP_HOME/WP_SITEURL per request makes WP treat whichever domain
// was asked for as its own address, so both serve the same content under their own URL and
// neither redirects to the other.
$xkld_host = strtolower($_SERVER['HTTP_HOST'] ?? '');
if ($xkld_host === 'nhatbanxkld.com' || $xkld_host === 'www.nhatbanxkld.com') {
    define('WP_HOME', 'https://' . $xkld_host);
    define('WP_SITEURL', 'https://' . $xkld_host);
}
