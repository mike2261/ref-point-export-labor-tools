# Job post tool — design

## Problem

The XKLĐ business posts job openings ("đơn hàng") on the WordPress/WooCommerce site
(xklddieuduong.vn) as products in two categories: "Đơn nam" and "Đơn nữ". Today this is done
by hand in wp-admin. Each post needs 3 images:

1. **Content image** — a text card summarizing the job (job code, gender/count, age range,
   role, province, salary, interview date). Prepared externally by the admin (e.g. in Canva);
   this tool does not generate it.
2. **Portrait image** — e.g. an official recruiter announcement table, or similar.
3. **Landscape image** — e.g. a workplace photo.

Reference examples: `docs/🍀 CHỌN ĐƠN ĐI NHẬT 🍀 [04-08-2026 20_31].zip` (3 sample images) and
`docs/photo_2026-08-04_16-59-56.jpg` / `docs/Screenshot from 2026-08-04 20-21-17.png` (site
screenshots showing the existing category tabs and post feed).

This is a new, standalone feature — unrelated to the existing "posts" (social-proof feed) or
"guides" admin sections, which serve a different product (the CTV/referral app).

## Goal

An admin tool (in `xkld-tools` + `xkld-tools-client`) where an admin uploads the 3 images,
picks a category, and the tool:

- Composites the 3 images into one square image (client-side, so the admin can preview it
  before posting).
- Uploads the composite (as the product's featured image) and the 3 originals (as the
  product's gallery) to WordPress.
- Creates a WooCommerce product in the chosen category with these images.

No title, description, or price is entered by the admin — this isn't a real storefront
listing, just a way to get the post live with the right images and category.

## Non-goals

- Generating the content image (image 1) from structured fields (job code, salary, etc.) —
  out of scope. The admin prepares that image externally.
- Any WordPress theme/CSS changes. The composite is a real, flattened image — WooCommerce's
  existing product templates render it like any other product image, with no theme changes.
- Editing/deleting job posts after creation (create-only for v1, matching the "3 images + a
  category, nothing else" scope — there's nothing to edit).

## Composite layout

Confirmed via visual review of 3 layout options using the real sample images:

```
┌─────────────────────────┐
│                         │
│      Content image      │  ← full width, original aspect ratio preserved (not cropped —
│      (full, uncropped)  │    the text must stay readable)
│                         │
├────────────┬────────────┤
│            │            │
│  Portrait  │  Landscape │  ← remaining square height, split evenly, each cropped to fill
│  (cropped) │  (cropped) │    its half (object-fit: cover equivalent)
│            │            │
└────────────┴────────────┘
```

The overall output is square. The content image keeps its own aspect ratio and is not
cropped; the canvas height is whatever the content image's width implies, plus a bottom
strip (also full width, split into two equal columns) sized so the total composite is
square. Portrait and landscape images are cropped (center-cropped) to fill their half.

## Product image structure

- **Featured image** (shown in category/shop grid listings): the composite.
- **Gallery** (shown in the product detail lightbox, click-through): the 3 original images,
  in order (content, portrait, landscape) — the composite is *not* included here, so viewers
  clicking through see the real, uncropped originals.

## Architecture

### Where compositing happens

Client-side, in the browser, via the Canvas API. Chosen over server-side (Worker)
compositing because:

- It gives an instant preview the moment all 3 images are selected — no round trip needed.
- Cloudflare Workers have no native Canvas; server-side compositing would need an external
  image-processing dependency for no real benefit here.

### Admin UI (`xkld-tools-client`)

New route `/admin/job-posts/new`, following the existing `posts.new.tsx` /
`ImageUploadField` conventions:

- Three labeled upload slots: "Ảnh nội dung", "Ảnh dọc", "Ảnh ngang" (reusing
  `ImageUploadField`).
- Category select: Đơn nam / Đơn nữ.
- As soon as all 3 images are picked, render the composite preview (canvas → data URL) inline
  before submission.
- Submit button disabled until all 3 images + a category are present.
- On submit: build a multipart form (composite blob + 3 original files + category) and POST
  it to the Worker.

### Backend (`xkld-tools`)

New endpoint `POST /api/admin/job-posts`, admin-auth-gated like the existing `adminRoutes`:

1. Parse multipart form: `composite`, `image1`, `image2`, `image3` (files), `category`
   (`don-nam` | `don-nu`). Validate: all 4 files present, correct MIME types (reuse the
   existing `ALLOWED_IMAGE_TYPES` / `MAX_IMAGE_BYTES` constants), category is one of the two
   allowed values.
2. Upload all 4 images to the WP media library via the existing `uploadImageToWp()` (in
   parallel).
3. Create a WooCommerce product via the WP REST API:
   - `featured_media` = composite's media ID.
   - Gallery = the 3 originals' media IDs (mechanism depends on which endpoint works — see
     Open questions).
   - Category = the term ID for `don-nam` or `don-nu` (looked up by slug once, at
     implementation time — these are fixed site categories, not user input).
   - `title`: auto-generated internally (e.g. a timestamp-based string) — never shown to or
     entered by the admin. WordPress requires a non-empty post title; this satisfies that
     without adding a field nobody wants to fill in.
   - `status`: publish immediately.
4. Return the created product's ID/link so the admin has a way to jump to it on the site.

### Data model

No new D1 table. Unlike `posts`/`guides`, there's nothing to list, edit, or query later — the
product lives entirely in WordPress once created. If a "recent job posts" admin view turns
out to be wanted later, that's a separate follow-up (YAGNI for v1).

## Error handling

- Any of the 4 image uploads failing → return an error immediately; do not attempt product
  creation. No partial product is created.
- Product creation failing after images already uploaded to WP media → return a clear error.
  The already-uploaded media isn't cleaned up automatically (matches the existing
  `uploadImageToWp` posts/guides flow, which has the same characteristic) — orphaned media in
  the library is a harmless, acceptable cost.
- Client-side: if canvas compositing fails (e.g. corrupt image), show an inline error and
  don't allow submission.

## Open questions (resolve at implementation time, not blocking spec approval)

- **WooCommerce API surface**: try creating the product via `wp/v2/product` (WordPress's
  standard REST API, reusing the existing Application Password auth already used for media
  uploads) first. If that user's role lacks sufficient WooCommerce capabilities (e.g. setting
  product categories/gallery isn't exposed there), fall back to WooCommerce's dedicated
  `wc/v3/products` endpoint, which needs its own consumer key/secret — to be generated in WP
  if needed.
- **Gallery field name**: whichever endpoint is used, confirm the exact field for attaching
  multiple gallery image IDs (WooCommerce's REST API uses an `images` array with the first
  entry doubling as the featured image in `wc/v3`; `wp/v2/product` may expose gallery
  differently or not at all — needs a quick spike against the real site before committing to
  one endpoint).
- **Category term IDs**: look up the `don-nam` / `don-nu` term IDs (or confirm slug-based
  assignment works) against the real site during implementation.

## Testing

- Composite generation: unit-testable in isolation if extracted as a pure function
  (image data in → canvas drawing instructions), though the actual Canvas API calls need a
  browser/jsdom-with-canvas environment — verify manually in the browser as the primary check,
  matching how `ImageUploadField` and similar UI is currently validated in this codebase (no
  existing component tests to match a pattern against).
- Backend: Vitest against the Workers pool (existing pattern), covering validation (missing
  image, bad MIME type, invalid category) and mocking `uploadImageToWp` / the WP product
  creation call the same way other admin routes are tested.
