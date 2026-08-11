# Job post edit, single-image categories, and delete confirm modal — design

## Problem

The job-post tool (`docs/superpowers/specs/2026-08-04-job-post-tool-design.md`) shipped
create-only, for two categories ("Đơn nam" / "Đơn nữ"), each post built from 3 uploaded
images composited into one square image, with no title/description (WooCommerce's required
`name` is auto-generated and never shown to the admin).

Since then the tool was extended to cover all 7 categories the site actually uses for job
posts (`docs/superpowers/specs/2026-08-04-job-post-tool-design.md` covers the original 2; the
other 5 — Câu hỏi đi Nhật, Học viên xuất cảnh, Đăng ký đi Nhật, Phỏng vấn đơn hàng, Đón tiếp
học viên — were wired up reusing the same 3-image-composite, no-title flow. That was wrong:
those 5 categories are real WooCommerce products with a single photo, a title, and a
description — the 3-image composite format is specific to Đơn nam/Đơn nữ job orders.

Separately, once every category got its own dashboard tile (each tile deep-links to
`/admin/job-posts?category=X`), the category `<Select>` still present in the create form
became redundant — the category is already fixed by which tile the admin came from.

This spec covers three fixes together, since they touch the same forms and routes:

1. Split the create flow into the two real formats (3-image composite vs 1-image+title+description) by category, and drop the category picker from the form entirely — category always comes from the URL the admin arrived with.
2. Add an edit ("Sửa") flow for existing posts, matching each category's format.
3. Replace the current "click Xoá twice" inline-confirm delete with a confirm modal.

## Non-goals

- Changing a post's category after creation. Category is fixed at creation (implied by which
  dashboard tile / list page the admin posted from) and not editable. Posting into the wrong
  category means delete + recreate in the right one.
- A D1 table for job posts. Still none — WordPress remains the only source of truth, per the
  original spec.
- Editing the composite images individually (e.g., swapping just the portrait photo) for
  Đơn nam/Đơn nữ. The composite can only be recomputed from all 3 source images at once (the
  tool doesn't persist the 3 originals as separately editable assets), so editing images for
  these two categories means re-supplying all 3.

## Category formats

```
usesThreeImages(category) === true   →  'don-nam' | 'don-nu'
usesThreeImages(category) === false  →  the other 5 categories
```

**Three-image (composite) format** — Đơn nam, Đơn nữ:
- 3 uploaded images (content card, portrait, landscape) composited client-side into 1 square
  image, exactly as today.
- No title or description fields. WooCommerce's required `name` stays auto-generated
  (`job-post-${Date.now()}`), never shown to the admin.
- Product images: composite (featured) + 3 originals (gallery), 4 WP media IDs total.

**Single-image format** — Câu hỏi đi Nhật, Học viên xuất cảnh, Đăng ký đi Nhật, Phỏng vấn đơn
hàng, Đón tiếp học viên:
- 1 uploaded image, no compositing.
- Title (required, non-empty — this becomes the WooCommerce product `name`) and description
  (optional plain text — WooCommerce product `description`).
- Product images: the 1 uploaded image (both featured and only image).

## Category is never chosen in a form

Both the create and edit forms read `category` from the route's URL search param
(`?category=don-nam`, etc.) — the same param the list page (`/admin/job-posts`) already uses.
There is no category `<Select>` anywhere:

- List page's "Đăng đơn hàng" button navigates to `/admin/job-posts/new` carrying the list's
  current `category` in the search params.
- Each row's new "Sửa" button navigates to `/admin/job-posts/$id/edit` carrying the same
  `category`.

If either route is somehow reached without a valid `category` in the URL (shouldn't happen
via normal navigation — both entry points always set it), fall back to `'don-nam'`, matching
the list page's existing fallback.

## Create flow

`/admin/job-posts/new` renders one of two components based on `usesThreeImages(category)`:

- **`CompositeJobPostForm`** — today's 3-upload-slots + composite preview UI, unchanged
  except the category `<Select>` is removed (category comes from the route).
- **`SingleImageJobPostForm`** (new) — 1 `ImageUploadField` + a "Tiêu đề" `Input` (required) +
  a "Mô tả" `Textarea` (optional). Submit disabled until the image and title are present.

Both components are built to also handle edit mode (see below) via an optional prop carrying
existing data, rather than being separate create-only components — the two flows share almost
everything except what happens on submit and whether fields start pre-filled.

## Edit flow

New route `/admin/job-posts/$id/edit`, reading `id` from the path and `category` from search
(same fallback rule as create). On mount, fetches the existing product
(`GET /api/admin/job-posts/:id?category=...`) for pre-fill data.

- **Composite categories**: same 3 upload slots as create, but nothing is pre-filled — the
  admin must pick all 3 images again (can't recompose from fewer than 3, and the tool doesn't
  keep the originals as separately swappable assets). Submitting replaces all 4 images
  (composite + 3 originals) on the existing product; the old WP media becomes orphaned,
  matching the same acceptable-orphan-media behavior the original design already documents for
  failed creates.
- **Single-image categories**: title and description inputs pre-filled from the fetched
  product; the current image shown as a preview with an option to pick a replacement (leaving
  it unset keeps the current image). Submitting always resends title/description (so clearing
  the description field actually clears it) and only sends a new image if the admin picked one.

## Delete confirm modal

Replaces the current pattern (click "Xoá" → button becomes "Xác nhận xoá?" → click again).
New `DeleteJobPostModal` component (in `components/admin/`, alongside `RedeemModal`, built on
the existing `AdminModal` shell): a plain confirmation question with "Huỷ" / "Xoá" buttons, no
image preview (per explicit product decision — the admin already sees the row/thumbnail behind
the modal). `job-posts.index.tsx` holds `deletingJobPost: JobPost | null` state instead of the
current `confirmingDeleteId`.

## Backend (`xkld-tools`)

**`src/lib/wpProducts.ts`**
- `usesThreeImages(category: JobPostCategory): boolean` — true for `don-nam`/`don-nu`.
- `createWpProduct` input becomes one of two shapes, discriminated by whether `imageIds` (4,
  composite category) or `imageId` + `title` + `description` (single-image category) is
  present; builds the WooCommerce create body accordingly (composite: auto title, no
  description; single: admin's title/description).
- New `updateWpProduct(env, id, input)`, `PUT /wc/v3/products/{id}`:
  - Composite: body always includes all 4 new `images`.
  - Single: body always includes `name`/`description`; `images` only included if a
    replacement was uploaded. Fields omitted from a WooCommerce REST `PUT` body leave the
    existing value untouched (a WooCommerce REST API guarantee, not something this endpoint
    has to implement) — this is what lets "edit title only" skip re-uploading the image. This
    behavior gets a direct smoke test against the real site early in implementation (see Risks)
    before the rest of the feature is built on top of it.
- New `getWpProduct(env, id)`, `GET /wc/v3/products/{id}` → `{ id, name, description, images }`
  for the edit form's pre-fill. 404 surfaces as `WpProductError` with `status: 404`, same
  pattern as the existing `WpProductError` usages.

**`src/routes/jobPosts.ts`**
- `POST /` branches on `usesThreeImages(category)`:
  - Composite: unchanged (`composite`, `image1`, `image2`, `image3` all required).
  - Single: `image` (required file) + `title` (required, trimmed non-empty) + `description`
    (optional, defaults to `''`).
- New `GET /:id?category=...`: validates `category`, calls `getWpProduct`, returns
  `{ jobPost: { id, name, description, images } }`.
- New `PUT /:id?category=...`: same per-category field validation as `POST /`, except every
  image field becomes optional for single-image categories (composite categories still
  require all 3 originals together — partial composite replacement isn't supported, per
  Non-goals). Calls `updateWpProduct`.
- `DELETE /:id`: unchanged.

## Frontend (`xkld-tools-client`)

**`src/lib/adminJobPosts.ts`**
- `usesThreeImages(category)` (mirrors the server helper).
- `JobPost` gains `description` (used by the edit pre-fill fetch; the list view doesn't need
  it).
- `useJobPost(id, category)` — `GET` single product for edit pre-fill.
- `useUpdateJobPost(category)` — `PUT` mutation, invalidates the same list query key
  `useCreateJobPost` already invalidates.

**Routes**
- `job-posts.new.tsx`: drop the category `<Select>`; read `category` from
  `Route.useSearch()`; render `CompositeJobPostForm` or `SingleImageJobPostForm` based on
  `usesThreeImages(category)`.
- New `job-posts.$id.edit.tsx`, following the existing `users.$id.index.tsx` flat-file
  convention: fetches via `useJobPost`, renders the same two form components in edit mode
  (passing the fetched data as pre-fill), submits via `useUpdateJobPost`.
- `job-posts.index.tsx`:
  - "Đăng đơn hàng" button and each row's new "Sửa" button both pass `search: { category }`
    through to their target routes.
  - Delete state changes from `confirmingDeleteId: number | null` to
    `deletingJobPost: JobPost | null`; renders `<DeleteJobPostModal>` when set.

**New component**
- `components/admin/DeleteJobPostModal.tsx` — `AdminModal` wrapper per the Delete confirm
  modal section above.

## Error handling

- Same validation-before-upload approach as today: all required fields checked before any WP
  media upload happens; upload failures return before product create/update is attempted.
- Edit: if `GET /:id` 404s (post already deleted from another tab/session), the edit page
  shows an error state with a link back to the list rather than a broken form.
- Composite edit: exactly like create, all 3 images are required together — partial submission
  (1 or 2 of 3) is rejected with a 400, same message style as create's validation.

## Testing

- Server: extend `test/job-posts.test.ts` (or a new `test/job-posts-edit.test.ts`) covering:
  create/update body-shape branching per category kind, `PUT` validation (all-or-nothing
  composite images, required title for single-image), `GET /:id` 404 handling, and that `PUT`
  with only `title`/`description` (no image) omits `images` from the WooCommerce request body.
- Client: `tsc --noEmit` plus a manual pass in the browser against local `wrangler dev`
  (already the established verification path for this tool) — create and edit for one
  composite category and one single-image category, plus the delete modal.

## Risks

- **WooCommerce partial-`PUT` behavior**: the assumption that omitting a field from the `PUT`
  body leaves it unchanged is standard WooCommerce REST API behavior but hasn't been verified
  against this specific site's WooCommerce version. First implementation step: a direct `PUT`
  smoke test against a real (low-stakes/existing test) product on `xklddieuduong.vn`,
  confirming an omitted `images` field doesn't clear the product's images, before wiring the
  rest of the edit feature on top of that assumption.
