<?php
// Hai kiểu thẻ:
//   - don-nam / don-nu: 3 ảnh ghép thành 1 thẻ (ảnh nội dung trên, giấy tờ + ảnh ngang dưới).
//   - 5 danh mục còn lại: 1 ảnh vuông / 1 thẻ (ảnh đại diện của sản phẩm, không có gallery).
//
// PHẠM VI HOST — hai tên miền dùng chung một bản WordPress, và xklddieuduong.vn phải giữ nguyên
// giao diện cũ (chỉ dùng chung dữ liệu bài đăng):
//   - don-nam / don-nu: chạy cho MỌI host, đúng như trước giờ vẫn thế.
//   - 5 danh mục 1 ảnh: CHỈ chạy trên nhatbanxkld.com. Trên xklddieuduong.vn chúng vẫn dùng
//     archive mặc định của theme y như cũ.
// Trên nhatbanxkld.com, 5 danh mục này trước đây rơi về archive mặc định nên bài đăng "không lên
// web" và có một khoảng trống lớn dưới header — 2 lỗi được báo lại ngày 13/08/2026.
// Trang riêng của từng bài (single product) trên nhatbanxkld.com: co khoảng trắng từ header
// xuống ảnh — yêu cầu 15/08/2026 ("khoảng trắng từ header xuống ảnh giảm xuống như trang bên
// ngoài ấy, đang bị xa"). Đo trên bản chạy thật: header cao 119px nhưng #wrapper chừa sẵn 170px
// (~51px chết, đúng như ở trang danh mục), rồi .product-main còn đệm thêm 40px nữa — tổng 91px
// trống. Kéo lên 50px và giảm đệm còn 16px thì ảnh bắt đầu ngay dưới header, vẫn còn một khoảng
// thở như lưới ngoài. Không đụng #wrapper để tránh ảnh hưởng các trang khác.
add_action('wp_head', function () {
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== 'nhatbanxkld.com' && $host !== 'www.nhatbanxkld.com') {
        return;
    }
    if (!function_exists('is_product') || !is_product()) {
        return;
    }
    ?>
    <style>
    .product-main { margin-top: -50px; padding-top: 16px; }
    /* Cùng lý do như tiêu đề ngoài lưới: viết hoa chữ cái đầu, không đổi tên bài trong WordPress. */
    .product-title::first-letter { text-transform: uppercase; }
    </style>
    <?php
}, 99);

add_action('template_redirect', function () {
    $composite_cats = array('don-nam', 'don-nu');
    $single_cats = array(
        'quy-trinh-chi-phi-don', // Câu hỏi đi Nhật
        'hoc-vien-xuat-canh',    // Học viên xuất cảnh
        'dang-ky-don',           // Đăng ký đi Nhật
        'phong-van-va-nhap-hoc', // Phỏng vấn đơn hàng
        'hoc-vien-tai-nhat',     // Đón tiếp học viên
    );

    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    $is_nhatbanxkld = ($host === 'nhatbanxkld.com' || $host === 'www.nhatbanxkld.com');
    $cats = $is_nhatbanxkld ? array_merge($composite_cats, $single_cats) : $composite_cats;
    if (!is_tax('product_cat', $cats)) {
        return;
    }

    $term = get_queried_object();
    $is_composite = in_array($term->slug, $composite_cats, true);
    $products = wc_get_products(array(
        'category' => array($term->slug),
        'limit' => -1,
        'status' => 'publish',
        'orderby' => 'date',
        'order' => 'DESC',
    ));

    get_header();
    ?>
    <style>
    /* The theme reserves a fixed 170px top offset (#wrapper padding-top) for the fixed header on
       every page, but the header itself only ever renders ~119px tall — the other ~51px is dead
       space. Other templates hide it under a page-title bar or hero image; this bare grid doesn't,
       so it reads as a big gap. Pull the wrap up by that dead amount, keeping our own 24px padding
       as the only intentional space below the header. */
    .xkld-jp-wrap { max-width: 1200px; margin: -50px auto 0; padding: 24px 20px 96px; }
    .xkld-jp-grid { display: grid; grid-template-columns: 1fr; gap: 24px; }
    @media (max-width: 699px) { .xkld-jp-wrap { padding-right: 100px; padding-bottom: 130px; } }
    @media (min-width: 700px) { .xkld-jp-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1100px) { .xkld-jp-grid { grid-template-columns: repeat(3, 1fr); } }
    /* 5 danh mục 1 ảnh: LUÔN 2 thẻ / hàng ở mọi khổ màn hình. Ảnh vuông đều nhau nên 2 cột đọc
       cân đối; chỉ Đơn nam / Đơn nữ mới cần lưới co giãn 1-2-3 cột vì mỗi thẻ một tỷ lệ khác
       nhau. Đặc thù cao hơn (2 class) nên thắng cả hai @media ở trên, không phụ thuộc thứ tự. */
    .xkld-jp-grid.xkld-jp-grid-single { grid-template-columns: repeat(2, 1fr); gap: 16px; }
    @media (max-width: 699px) {
      .xkld-jp-grid.xkld-jp-grid-single { gap: 12px; }
      /* Lưới 1 cột của Đơn nam/Đơn nữ chừa 100px bên phải để không lọt xuống dưới nút gọi/Zalo
         nổi. Lưới 2 cột thì chừa từng đó là thẻ bị bóp còn nửa màn hình, nên trả lại lề thường —
         vẫn giữ khoảng trống đáy để hàng cuối không bị nút che. */
      .xkld-jp-wrap.xkld-jp-wrap-single { padding-right: 20px; }
    }
    .xkld-jp-card { position: relative; cursor: pointer; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.15); background: #fff; display: flex; flex-direction: column; }
    .xkld-jp-card .xkld-jp-top { overflow: hidden; }
    .xkld-jp-card .xkld-jp-top img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .xkld-jp-card .xkld-jp-bottom { display: flex; overflow: hidden; }
    .xkld-jp-card .xkld-jp-bottom > div { overflow: hidden; }
    .xkld-jp-card .xkld-jp-bottom img { display: block; width: 100%; height: 100%; object-fit: contain; }
    /* Thẻ 1 ảnh = ảnh vuông + tiêu đề (không có mô tả). Khung ảnh vuông cố định, ảnh để contain
       nên không bao giờ bị cắt kể cả khi admin lỡ tải lên ảnh không vuông.
       Thẻ này là thẻ <a> dẫn sang trang riêng của bài (xem phần render bên dưới), nên phải tắt
       gạch chân và trả màu chữ về mặc định của thẻ. */
    a.xkld-jp-card, a.xkld-jp-card:hover { text-decoration: none; color: inherit; }
    .xkld-jp-card .xkld-jp-square { aspect-ratio: 1 / 1; overflow: hidden; }
    .xkld-jp-card .xkld-jp-square img { display: block; width: 100%; height: 100%; object-fit: contain; }
    /* Admin gõ tiêu đề tự do nên hay ra "đi Nhật cần những giấy tờ gì" — viết hoa chữ cái đầu ở
       tầng hiển thị, tên bài trong WordPress giữ nguyên. */
    .xkld-jp-card .xkld-jp-title { padding: 12px 14px 16px; text-align: center; font-size: 15px; line-height: 1.35; color: #222; }
    .xkld-jp-card .xkld-jp-title::first-letter { text-transform: uppercase; }
    .xkld-jp-empty { text-align: center; color: #777; padding: 60px 0; }
    .xkld-jp-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.92); display: none; z-index: 9999; align-items: center; justify-content: center; touch-action: pan-y; }
    .xkld-jp-lightbox.open { display: flex; }
    .xkld-jp-lightbox img { max-width: 92vw; max-height: 84vh; object-fit: contain; user-select: none; -webkit-user-select: none; }
    .xkld-jp-lightbox .xkld-jp-close { position: absolute; top: 14px; right: 20px; color: #fff; font-size: 34px; cursor: pointer; line-height: 1; z-index: 2; }
    .xkld-jp-lightbox .xkld-jp-nav { position: absolute; top: 50%; transform: translateY(-50%); color: #fff; font-size: 42px; cursor: pointer; padding: 8px 18px; user-select: none; z-index: 2; }
    .xkld-jp-lightbox .xkld-jp-prev { left: 4px; }
    .xkld-jp-lightbox .xkld-jp-next { right: 4px; }
    .xkld-jp-lightbox .xkld-jp-dots { position: absolute; bottom: 18px; display: flex; gap: 8px; z-index: 2; }
    .xkld-jp-lightbox .xkld-jp-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,.4); }
    .xkld-jp-lightbox .xkld-jp-dot.active { background: #fff; }
    </style>

    <div class="xkld-jp-wrap<?php echo $is_composite ? '' : ' xkld-jp-wrap-single'; ?>">
      <div class="xkld-jp-grid<?php echo $is_composite ? '' : ' xkld-jp-grid-single'; ?>">
        <?php if (empty($products)): ?>
          <div class="xkld-jp-empty">Chưa có bài đăng nào trong danh mục này.</div>
        <?php endif; ?>

        <?php if (!$is_composite): ?>
          <?php foreach ($products as $product):
              // 5 danh mục 1 ảnh: ảnh nằm ở ảnh đại diện (WooCommerce lấy ảnh đầu tiên của
              // 'images' làm featured image, gallery rỗng — xem createWpProduct trong
              // src/lib/wpProducts.ts). Bỏ qua bài chưa có ảnh thay vì render ô trống.
              $image_id = $product->get_image_id();
              if (!$image_id) {
                  continue;
              }
              $image_url = wp_get_attachment_image_url($image_id, 'large');
              if (!$image_url) {
                  continue;
              }
          ?>
          <?php // Bấm vào ảnh HOẶC tiêu đề đều mở TRANG RIÊNG của bài, không mở lightbox — yêu cầu
                // 15/08/2026. Chỉ Đơn nam/Đơn nữ mới xem bằng lightbox (3 ảnh ghép, không có trang
                // riêng vì snippet 1362 tắt click cho hai danh mục đó). Thẻ không có data-images
                // nên vòng gắn sự kiện lightbox bên dưới bỏ qua nó. ?>
          <a class="xkld-jp-card xkld-jp-single" href="<?php echo esc_url($product->get_permalink()); ?>">
            <div class="xkld-jp-square">
              <img src="<?php echo esc_url($image_url); ?>" alt="<?php echo esc_attr($product->get_name()); ?>" loading="lazy">
            </div>
            <div class="xkld-jp-title"><?php echo esc_html($product->get_name()); ?></div>
          </a>
          <?php endforeach; ?>
        <?php else: ?>
        <?php foreach ($products as $product):
            $gallery_ids = $product->get_gallery_image_ids();
            if (count($gallery_ids) < 3) {
                continue;
            }
            $content_id = $gallery_ids[0];
            $doc_id = $gallery_ids[1];
            $ngang_id = $gallery_ids[2];

            $content_meta = wp_get_attachment_metadata($content_id);
            $doc_meta = wp_get_attachment_metadata($doc_id);
            $ngang_meta = wp_get_attachment_metadata($ngang_id);
            if (!$content_meta || !$doc_meta || !$ngang_meta) {
                continue;
            }

            $content_aspect = $content_meta['width'] / $content_meta['height'];
            $doc_aspect = $doc_meta['width'] / $doc_meta['height'];
            $ngang_aspect = $ngang_meta['width'] / $ngang_meta['height'];

            // Every measurement below is "at width = 100" so they compose into one consistent
            // aspect-ratio + flex-grow set — no image is ever cropped, each gets exactly the
            // space its own aspect ratio needs.
            $content_h = 100 / $content_aspect;
            $bottom_h = 100 / ($doc_aspect + $ngang_aspect);
            $doc_w = $bottom_h * $doc_aspect;
            $ngang_w = 100 - $doc_w;
            $card_h = $content_h + $bottom_h;

            $content_url = wp_get_attachment_image_url($content_id, 'large');
            $doc_url = wp_get_attachment_image_url($doc_id, 'large');
            $ngang_url = wp_get_attachment_image_url($ngang_id, 'large');
        ?>
        <div class="xkld-jp-card"
             data-images="<?php echo esc_attr(wp_json_encode(array($content_url, $doc_url, $ngang_url))); ?>"
             style="aspect-ratio: 100 / <?php echo esc_attr(round($card_h, 3)); ?>;">
          <div class="xkld-jp-top" style="flex: <?php echo esc_attr(round($content_h, 3)); ?>;">
            <img src="<?php echo esc_url($content_url); ?>" alt="" loading="lazy">
          </div>
          <div class="xkld-jp-bottom" style="flex: <?php echo esc_attr(round($bottom_h, 3)); ?>;">
            <div style="flex: <?php echo esc_attr(round($doc_w, 3)); ?>;">
              <img src="<?php echo esc_url($doc_url); ?>" alt="" loading="lazy">
            </div>
            <div style="flex: <?php echo esc_attr(round($ngang_w, 3)); ?>;">
              <img src="<?php echo esc_url($ngang_url); ?>" alt="" loading="lazy">
            </div>
          </div>
        </div>
        <?php endforeach; ?>
        <?php endif; ?>
      </div>
    </div>

    <div class="xkld-jp-lightbox" id="xkld-jp-lightbox">
      <span class="xkld-jp-close">&times;</span>
      <span class="xkld-jp-nav xkld-jp-prev">&#8249;</span>
      <img src="" alt="">
      <span class="xkld-jp-nav xkld-jp-next">&#8250;</span>
      <div class="xkld-jp-dots"></div>
    </div>

    <script>
    (function () {
      var lightbox = document.getElementById('xkld-jp-lightbox');
      var imgEl = lightbox.querySelector('img');
      var dotsEl = lightbox.querySelector('.xkld-jp-dots');
      var navEls = lightbox.querySelectorAll('.xkld-jp-nav');
      var images = [];
      var idx = 0;

      function render() {
        imgEl.src = images[idx];
        var dots = dotsEl.querySelectorAll('.xkld-jp-dot');
        for (var i = 0; i < dots.length; i++) {
          dots[i].className = 'xkld-jp-dot' + (i === idx ? ' active' : '');
        }
      }

      function open(imgs, startIdx) {
        images = imgs;
        idx = startIdx;
        var html = '';
        for (var i = 0; i < images.length; i++) {
          html += '<span class="xkld-jp-dot"></span>';
        }
        dotsEl.innerHTML = html;
        // Thẻ 1 ảnh (5 danh mục không ghép ảnh): không có gì để lật, ẩn mũi tên và chấm tròn.
        var single = images.length < 2;
        for (var n = 0; n < navEls.length; n++) {
          navEls[n].style.display = single ? 'none' : '';
        }
        dotsEl.style.display = single ? 'none' : '';
        render();
        lightbox.classList.add('open');
      }

      function close() {
        lightbox.classList.remove('open');
      }

      function next() {
        idx = (idx + 1) % images.length;
        render();
      }

      function prev() {
        idx = (idx - 1 + images.length) % images.length;
        render();
      }

      // Chỉ thẻ có data-images mới mở lightbox (Đơn nam/Đơn nữ). Thẻ 1 ảnh là thẻ <a> dẫn sang
      // trang riêng nên không nằm trong danh sách này.
      var cards = document.querySelectorAll('.xkld-jp-card[data-images]');
      for (var c = 0; c < cards.length; c++) {
        cards[c].addEventListener('click', function () {
          var imgs;
          try {
            imgs = JSON.parse(this.dataset.images);
          } catch (e) {
            return;
          }
          if (imgs && imgs.length) {
            open(imgs, 0);
          }
        });
      }

      lightbox.querySelector('.xkld-jp-close').addEventListener('click', close);
      lightbox.querySelector('.xkld-jp-next').addEventListener('click', next);
      lightbox.querySelector('.xkld-jp-prev').addEventListener('click', prev);
      lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox) {
          close();
        }
      });

      var touchStartX = null;
      lightbox.addEventListener('touchstart', function (e) {
        touchStartX = e.touches[0].clientX;
      });
      lightbox.addEventListener('touchend', function (e) {
        if (touchStartX === null) {
          return;
        }
        var dx = e.changedTouches[0].clientX - touchStartX;
        if (dx > 50) {
          prev();
        } else if (dx < -50) {
          next();
        }
        touchStartX = null;
      });

      document.addEventListener('keydown', function (e) {
        if (!lightbox.classList.contains('open')) {
          return;
        }
        if (e.key === 'Escape') {
          close();
        }
        if (e.key === 'ArrowRight') {
          next();
        }
        if (e.key === 'ArrowLeft') {
          prev();
        }
      });
    })();
    </script>
    <?php
    get_footer();
    exit;
});
