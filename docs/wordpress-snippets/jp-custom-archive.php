<?php
add_action('template_redirect', function () {
    if (!is_tax('product_cat', array('don-nam', 'don-nu'))) {
        return;
    }

    $term = get_queried_object();
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
    .xkld-jp-card { position: relative; cursor: pointer; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.15); background: #fff; display: flex; flex-direction: column; }
    .xkld-jp-card .xkld-jp-top { overflow: hidden; }
    .xkld-jp-card .xkld-jp-top img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .xkld-jp-card .xkld-jp-bottom { display: flex; overflow: hidden; }
    .xkld-jp-card .xkld-jp-bottom > div { overflow: hidden; }
    .xkld-jp-card .xkld-jp-bottom img { display: block; width: 100%; height: 100%; object-fit: contain; }
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

    <div class="xkld-jp-wrap">
      <div class="xkld-jp-grid">
        <?php if (empty($products)): ?>
          <div class="xkld-jp-empty">Chưa có đơn hàng nào trong danh mục này.</div>
        <?php endif; ?>
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
             data-content="<?php echo esc_url($content_url); ?>"
             data-doc="<?php echo esc_url($doc_url); ?>"
             data-ngang="<?php echo esc_url($ngang_url); ?>"
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

      var cards = document.querySelectorAll('.xkld-jp-card');
      for (var c = 0; c < cards.length; c++) {
        cards[c].addEventListener('click', function () {
          open([this.dataset.content, this.dataset.doc, this.dataset.ngang], 0);
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
