# Job Post Edit, Single-Image Categories & Delete Confirm Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the job-post create flow into the two real WooCommerce product formats (3-image composite for Đơn nam/Đơn nữ vs 1-image+title+description for the other 5 categories), add an edit flow for both formats, drop the now-redundant category picker from both forms, and replace the inline double-click delete with a confirm modal.

**Architecture:** Backend (`xkld-tools`, Hono on Cloudflare Workers) gains `GET /api/admin/job-posts/:id` and `PATCH /api/admin/job-posts/:id`, plus a category-kind branch inside the existing `POST /`. Frontend (`xkld-tools-client`, React + TanStack Router) gets two new shared form components (`CompositeJobPostForm`, `SingleImageJobPostForm`) used by both the create route and a new edit route, a new delete-confirm modal, and category read exclusively from the URL (no `<Select>`).

**Tech Stack:** Hono, Cloudflare Workers, `@cloudflare/vitest-pool-workers`, React 19, TanStack Router/Query, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-11-job-post-edit-and-single-image-categories-design.md`

---

## Task 1: Server — single-image category support in `POST /`

**Files:**
- Modify: `src/lib/wpProducts.ts`
- Modify: `src/routes/jobPosts.ts`
- Test: `test/job-posts.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/job-posts.test.ts`, right after the existing `describe('POST /api/admin/job-posts', ...)` block (after its closing `})`, before `function listJobPosts(...)`):

```ts
function createSingleImageJobPost(
  token: string | undefined,
  f: {
    category?: string
    title?: string
    omitTitle?: boolean
    description?: string
    omitImage?: boolean
    imageType?: string
  } = {},
): Promise<Response> {
  const fd = new FormData()
  fd.append('category', f.category ?? 'don-hang')
  if (!f.omitTitle) fd.append('title', f.title ?? 'Job post title')
  if (f.description !== undefined) fd.append('description', f.description)
  if (!f.omitImage) {
    fd.append(
      'image',
      new File([new Uint8Array([137, 80, 78, 71])], 'image.jpg', { type: f.imageType ?? 'image/jpeg' }),
    )
  }
  return SELF.fetch(`${BASE}/api/admin/job-posts`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('POST /api/admin/job-posts — single-image categories', () => {
  it('validates title and image before touching WordPress', async () => {
    const admin = await seedAdmin()

    expect((await createSingleImageJobPost(admin.token, { omitTitle: true })).status).toBe(400)
    expect((await createSingleImageJobPost(admin.token, { title: '   ' })).status).toBe(400)
    expect((await createSingleImageJobPost(admin.token, { omitImage: true })).status).toBe(400)
    expect((await createSingleImageJobPost(admin.token, { imageType: 'text/plain' })).status).toBe(400)

    expect(wpUploads).toBe(0)
    expect(wpProductCreates).toBe(0)
  })

  it('uploads 1 image and creates a product with title/description, no composite', async () => {
    const admin = await seedAdmin()

    const res = await createSingleImageJobPost(admin.token, {
      category: 'hoc-vien-xuat-canh',
      title: 'Bạn Nguyễn Văn A đăng ký đi Nhật',
      description: 'Chi tiết đơn hàng',
    })
    expect(res.status).toBe(201)

    expect(wpUploads).toBe(1)
    expect(wpProductCreates).toBe(1)
    expect(lastProductBody?.name).toBe('Bạn Nguyễn Văn A đăng ký đi Nhật')
    expect(lastProductBody?.description).toBe('Chi tiết đơn hàng')
    expect(lastProductBody?.categories).toEqual([{ id: 72 }]) // hoc-vien-xuat-canh
    expect(lastProductBody?.images).toEqual([{ id: 901 }])
  })

  it('defaults description to empty string when omitted', async () => {
    const admin = await seedAdmin()
    await createSingleImageJobPost(admin.token, { category: 'don-hang' })
    expect(lastProductBody?.description).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/job-posts.test.ts -t "single-image categories"`
Expected: FAIL — the current `POST /` always requires `composite`/`image1`/`image2`/`image3` and 400s on this test's requests regardless of the assertions above (e.g. the "uploads 1 image..." test fails because `wpUploads` stays 0, not 1).

- [ ] **Step 3: Add `usesThreeImages` and branch `createWpProduct`'s input in `src/lib/wpProducts.ts`**

Replace the file's `export type JobPostCategory = ...` through `export function isJobPostCategory...` block (keep those two as-is) and everything from `export interface CreateWpProductInput` through the end of `createWpProduct` with:

```ts
export type JobPostCategory = keyof typeof CATEGORY_TERM_IDS

const JOB_POST_CATEGORIES = new Set(Object.keys(CATEGORY_TERM_IDS))

export function isJobPostCategory(value: string): value is JobPostCategory {
  return JOB_POST_CATEGORIES.has(value)
}

// Đơn nam/Đơn nữ are 3-photo job orders composited into 1 square image, no title/description
// (docs/superpowers/specs/2026-08-11-job-post-edit-and-single-image-categories-design.md). Every
// other category is a plain 1-photo WooCommerce product with an admin-entered title/description.
const THREE_IMAGE_CATEGORIES: ReadonlySet<JobPostCategory> = new Set(['don-nam', 'don-nu'])

export function usesThreeImages(category: JobPostCategory): category is 'don-nam' | 'don-nu' {
  return THREE_IMAGE_CATEGORIES.has(category)
}

export interface WpProductEnv {
  WP_API_BASE: string
  WP_MEDIA_USER: string
  WP_MEDIA_APP_PASSWORD: string
}

export class WpProductError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`WordPress product creation failed: ${status} ${detail}`)
    this.name = 'WpProductError'
  }
}

export type CreateWpProductInput =
  | { category: 'don-nam' | 'don-nu'; imageIds: [number, number, number, number] }
  | {
      category: Exclude<JobPostCategory, 'don-nam' | 'don-nu'>
      imageId: number
      title: string
      description: string
    }

export interface WpProductResult {
  id: number
  permalink: string
}

export async function createWpProduct(
  env: WpProductEnv,
  input: CreateWpProductInput,
): Promise<WpProductResult> {
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)

  const body =
    'imageIds' in input
      ? {
          // Never shown to or entered by the admin — WooCommerce requires a non-empty title,
          // this just satisfies that (design doc: "Non-goals").
          name: `job-post-${Date.now()}`,
          status: 'publish',
          categories: [{ id: CATEGORY_TERM_IDS[input.category] }],
          images: input.imageIds.map((id) => ({ id })),
        }
      : {
          name: input.title,
          description: input.description,
          status: 'publish',
          categories: [{ id: CATEGORY_TERM_IDS[input.category] }],
          images: [{ id: input.imageId }],
        }

  const res = await fetch(`${env.WP_API_BASE}/wc/v3/products`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }

  const data = (await res.json()) as { id: number; permalink: string }
  return { id: data.id, permalink: data.permalink }
}
```

Leave `listWpProducts`, `deleteWpProduct`, and everything below them in the file untouched for this task.

- [ ] **Step 4: Branch `POST /` in `src/routes/jobPosts.ts`**

Replace the whole file's imports and the `jobPostRoutes.post('/', ...)` handler:

```ts
// Admin tool: create/edit WooCommerce products for the site's job-post categories — see
// docs/superpowers/specs/2026-08-04-job-post-tool-design.md and
// docs/superpowers/specs/2026-08-11-job-post-edit-and-single-image-categories-design.md.
//
// Two product shapes depending on category (usesThreeImages in lib/wpProducts.ts):
//   - Đơn nam/Đơn nữ: 3 uploaded photos composited client-side into 1 square image, no
//     title/description.
//   - Every other category: 1 uploaded photo + an admin-entered title/description.
//
// Unlike posts/guides (routes/admin.ts), this has no D1 table: there's nothing to store beyond
// what create/update writes into WordPress directly. List/get/delete below proxy straight
// through to the WooCommerce API rather than querying D1 — the product IS the record.
import { Hono } from 'hono'
import { requireSuperAdmin } from '../middleware/auth'
import { uploadImageToWp, WpUploadError } from '../lib/wpMedia'
import {
  createWpProduct,
  deleteWpProduct,
  isJobPostCategory,
  listWpProducts,
  usesThreeImages,
  WpProductError,
} from '../lib/wpProducts'
import { parsePage } from '../lib/pagination'
import type { AppEnv } from '../types'

export const jobPostRoutes = new Hono<AppEnv>()

jobPostRoutes.use('*', requireSuperAdmin)

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8 MB — matches routes/admin.ts's posts/guides limit
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_TITLE = 200 // matches routes/admin.ts's posts/guides limit
const MAX_DESCRIPTION = 1000 // matches routes/admin.ts's posts/guides limit
// Client field name -> human label, used only in validation error messages.
const IMAGE_FIELDS = [
  ['composite', 'ảnh ghép'],
  ['image1', 'ảnh nội dung'],
  ['image2', 'ảnh dọc'],
  ['image3', 'ảnh ngang'],
] as const

type ParsedCompositeImages =
  | { ok: true; files: File[]; buffers: ArrayBuffer[] }
  | { ok: false; error: string; status: 400 | 413 }

// Shared by POST / and PATCH /:id (added in Task 3) — both require all 4 composite fields
// together when the category uses the 3-image format (a composite can't be recomputed from
// fewer than 3 source images).
async function parseCompositeImages(body: Record<string, string | File>): Promise<ParsedCompositeImages> {
  const files: File[] = []
  for (const [field, label] of IMAGE_FIELDS) {
    const file = body[field]
    if (!(file instanceof File)) return { ok: false, error: `${label} là bắt buộc`, status: 400 }
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return { ok: false, error: `${label} phải là JPEG, PNG hoặc WebP`, status: 400 }
    }
    files.push(file)
  }

  const buffers: ArrayBuffer[] = []
  for (let i = 0; i < files.length; i++) {
    const buf = await files[i].arrayBuffer()
    if (buf.byteLength === 0) return { ok: false, error: `${IMAGE_FIELDS[i][1]} rỗng`, status: 400 }
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, error: `${IMAGE_FIELDS[i][1]} vượt quá 8MB`, status: 413 }
    }
    buffers.push(buf)
  }
  return { ok: true, files, buffers }
}

function parseTitleAndDescription(
  body: Record<string, string | File>,
): { ok: true; title: string; description: string } | { ok: false; error: string } {
  const title = typeof body['title'] === 'string' ? body['title'].trim() : ''
  const description = typeof body['description'] === 'string' ? body['description'].trim() : ''
  if (title.length === 0) return { ok: false, error: 'title là bắt buộc' }
  if (title.length > MAX_TITLE) return { ok: false, error: `title tối đa ${MAX_TITLE} ký tự` }
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, error: `description tối đa ${MAX_DESCRIPTION} ký tự` }
  }
  return { ok: true, title, description }
}

jobPostRoutes.post('/', async (c) => {
  const body = await c.req.parseBody()

  const category = typeof body['category'] === 'string' ? body['category'] : ''
  if (!isJobPostCategory(category)) {
    return c.json({ error: 'invalid category' }, 400)
  }

  if (usesThreeImages(category)) {
    const parsed = await parseCompositeImages(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

    let uploads: { id: number; sourceUrl: string }[]
    try {
      uploads = await Promise.all(
        parsed.files.map((file, i) =>
          uploadImageToWp(c.env, parsed.buffers[i], file.name || 'upload.jpg', file.type),
        ),
      )
    } catch (err) {
      if (err instanceof WpUploadError) {
        return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
      }
      throw err
    }

    const [compositeId, image1Id, image2Id, image3Id] = uploads.map((u) => u.id)
    try {
      const product = await createWpProduct(c.env, {
        category,
        imageIds: [compositeId, image1Id, image2Id, image3Id],
      })
      return c.json({ jobPost: product }, 201)
    } catch (err) {
      if (err instanceof WpProductError) {
        return c.json({ error: 'product creation on WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
      }
      throw err
    }
  }

  const parsedText = parseTitleAndDescription(body)
  if (!parsedText.ok) return c.json({ error: parsedText.error }, 400)

  const image = body['image']
  if (!(image instanceof File)) return c.json({ error: 'ảnh là bắt buộc' }, 400)
  if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
    return c.json({ error: 'ảnh phải là JPEG, PNG hoặc WebP' }, 400)
  }
  const buf = await image.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'ảnh rỗng' }, 400)
  if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'ảnh vượt quá 8MB' }, 413)

  let upload: { id: number; sourceUrl: string }
  try {
    upload = await uploadImageToWp(c.env, buf, image.name || 'upload.jpg', image.type)
  } catch (err) {
    if (err instanceof WpUploadError) {
      return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
    }
    throw err
  }

  try {
    const product = await createWpProduct(c.env, {
      category,
      imageId: upload.id,
      title: parsedText.title,
      description: parsedText.description,
    })
    return c.json({ jobPost: product }, 201)
  } catch (err) {
    if (err instanceof WpProductError) {
      return c.json({ error: 'product creation on WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
    }
    throw err
  }
})
```

Leave the `GET /` and `DELETE /:id` handlers below this untouched for this task.

- [ ] **Step 5: Run the full job-posts test file**

Run: `npx vitest run test/job-posts.test.ts`
Expected: PASS — all existing tests plus the 3 new ones in this task.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/wpProducts.ts src/routes/jobPosts.ts test/job-posts.test.ts
git commit -m "$(cat <<'EOF'
feat: support single-image job-post categories in create

Đơn nam/Đơn nữ keep the 3-image composite flow; the other 5 categories
now create a plain 1-image WooCommerce product with an admin-entered
title/description instead of reusing the composite format they never
actually matched.
EOF
)"
```

---

## Task 2: Server — `GET /:id` for edit pre-fill

**Files:**
- Modify: `src/lib/wpProducts.ts`
- Modify: `src/routes/jobPosts.ts`
- Test: `test/job-posts.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/job-posts.test.ts`, right after the `describe('GET /api/admin/job-posts', ...)` block closes (before `describe('DELETE /api/admin/job-posts/:id', ...)`):

```ts
function getJobPost(token: string | undefined, id: number | string, category = 'don-hang'): Promise<Response> {
  return SELF.fetch(`${BASE}/api/admin/job-posts/${id}?category=${category}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET /api/admin/job-posts/:id', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111114')

    expect((await getJobPost(undefined, 123)).status).toBe(401)
    expect((await getJobPost(user.token, 123)).status).toBe(403)
  })

  it('rejects a non-numeric id', async () => {
    const admin = await seedAdmin()
    expect((await getJobPost(admin.token, 'abc')).status).toBe(400)
  })

  it('rejects an invalid category', async () => {
    const admin = await seedAdmin()
    expect((await getJobPost(admin.token, 123, 'not-a-real-category')).status).toBe(400)
  })

  it('strips wpautop <p> wrapping from description and returns title/images', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      expect(url).toContain('/wc/v3/products/123')
      return new Response(
        JSON.stringify({
          id: 123,
          name: 'Bạn A đăng ký đi Nhật',
          description: '<p>Dòng 1</p>\n<p>Dòng 2</p>',
          images: [{ id: 901, src: 'https://wp.test/photo.jpg' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const res = await getJobPost(admin.token, 123)
    expect(res.status).toBe(200)
    const body = await res.json<{ jobPost: { id: number; name: string; description: string; images: unknown[] } }>()
    expect(body.jobPost).toEqual({
      id: 123,
      name: 'Bạn A đăng ký đi Nhật',
      description: 'Dòng 1\n\nDòng 2',
      images: [{ id: 901, src: 'https://wp.test/photo.jpg' }],
    })
  })

  it('returns 404 when the product does not exist', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 404 }))

    const res = await getJobPost(admin.token, 999)
    expect(res.status).toBe(404)
  })

  it('returns 502 when WordPress fails for a reason other than not-found', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 500 }))

    const res = await getJobPost(admin.token, 123)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/job-posts.test.ts -t "GET /api/admin/job-posts/:id"`
Expected: FAIL — the route doesn't exist yet (404 from the router itself, not from the handler's own not-found path — every assertion in this block currently fails).

- [ ] **Step 3: Add `getWpProduct` to `src/lib/wpProducts.ts`**

Add at the end of the file, after `deleteWpProduct`:

```ts
export interface WpProductDetail {
  id: number
  name: string
  description: string
  images: { id: number; src: string }[]
}

// WooCommerce wraps `description` in wpautop-generated <p> tags on the way out — this tool only
// ever writes plain text into it (via createWpProduct/updateWpProduct's single-image branch), so
// a blunt tag-strip is enough to hand the admin's original text back to the edit form's textarea.
function stripWpautop(html: string): string {
  return html.replace(/<\/p>\s*<p>/g, '\n\n').replace(/<[^>]+>/g, '').trim()
}

export async function getWpProduct(env: WpProductEnv, id: number): Promise<WpProductDetail> {
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)

  const res = await fetch(`${env.WP_API_BASE}/wc/v3/products/${id}`, {
    headers: {
      Authorization: auth,
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }

  const data = (await res.json()) as { id: number; name: string; description: string; images: { id: number; src: string }[] }
  return { id: data.id, name: data.name, description: stripWpautop(data.description), images: data.images }
}
```

- [ ] **Step 4: Add the `GET /:id` route to `src/routes/jobPosts.ts`**

Add `getWpProduct` to the `from '../lib/wpProducts'` import list (alongside `createWpProduct`, `deleteWpProduct`, etc.), then add this route right after the existing `jobPostRoutes.get('/', ...)` handler and before `jobPostRoutes.delete('/:id', ...)`:

```ts
// Single product lookup, for the edit page's pre-fill (title/description/images).
jobPostRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400)

  const category = c.req.query('category') ?? ''
  if (!isJobPostCategory(category)) {
    return c.json({ error: 'invalid category' }, 400)
  }

  try {
    const product = await getWpProduct(c.env, id)
    return c.json({ jobPost: product })
  } catch (err) {
    if (err instanceof WpProductError) {
      if (err.status === 404) return c.json({ error: 'not found' }, 404)
      return c.json({ error: 'product fetch from WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
    }
    throw err
  }
})
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/job-posts.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/wpProducts.ts src/routes/jobPosts.ts test/job-posts.test.ts
git commit -m "$(cat <<'EOF'
feat: add GET /api/admin/job-posts/:id for edit pre-fill

Strips the <p> tags WooCommerce's REST API wraps the description in on
the way out, so the edit form's textarea gets back plain text matching
what the admin originally typed.
EOF
)"
```

---

## Task 3: Server — `PATCH /:id` (edit both formats)

**Files:**
- Modify: `src/lib/wpProducts.ts`
- Modify: `src/routes/jobPosts.ts`
- Test: `test/job-posts.test.ts`

- [ ] **Step 1: Verify WooCommerce's partial-`PUT` behavior against the real site**

This confirms the assumption the rest of this task depends on: a `PUT` to `/wc/v3/products/{id}` that omits the `images` field leaves the product's current images untouched, rather than clearing them. Uses the single-image create endpoint from Task 1 (already working) to make one real throwaway product to test against.

Make sure the local Worker is running in another terminal (`npx wrangler dev` from the repo root — it proxies to the real `xklddieuduong.vn` site).

Log in and capture a bearer token (use the local super-admin credentials this repo's README/DEMO-ACCOUNTS.md documents for local testing):

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"<local super-admin identifier>","password":"<local super-admin password>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
echo "$ADMIN_TOKEN"
```

Expected: a non-empty JWT string printed.

Create one throwaway product in the `don-hang` category, using any small local JPEG file:

```bash
curl -s -X POST http://localhost:8787/api/admin/job-posts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "category=don-hang" \
  -F "title=PUT-TEST-DELETE-ME" \
  -F "description=temporary, safe to delete" \
  -F "image=@/path/to/any/local/test.jpg;type=image/jpeg"
```

Expected: `{"jobPost":{"id":<TEST_ID>,"permalink":"..."}}` — note `<TEST_ID>`.

Raw `PUT` against WooCommerce directly, sending only `name`, no `images` field at all:

```bash
source <(grep -E '^WP_MEDIA_USER|^WP_MEDIA_APP_PASSWORD' .dev.vars | sed 's/^/export /')
curl -s -u "$WP_MEDIA_USER:$WP_MEDIA_APP_PASSWORD" \
  -X PUT "https://xklddieuduong.vn/index.php?rest_route=/wc/v3/products/<TEST_ID>" \
  -H "Content-Type: application/json" \
  -d '{"name":"PUT-TEST-RENAMED"}'
```

Expected: response JSON has `"name":"PUT-TEST-RENAMED"` **and** a non-empty `"images"` array still containing the image uploaded above. If `images` comes back empty instead, the assumption is false — stop and flag this before continuing; `updateWpProduct` in Step 3 below would need to always resend the current image IDs instead of omitting the field on a text-only edit.

Clean up the throwaway product:

```bash
curl -s -X DELETE http://localhost:8787/api/admin/job-posts/<TEST_ID> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: `{"ok":true}`.

- [ ] **Step 2: Write the failing tests**

Add to `test/job-posts.test.ts`, at the end of the file (after the `describe('DELETE /api/admin/job-posts/:id', ...)` block):

```ts
function patchJobPost(
  token: string | undefined,
  id: number | string,
  category: string,
  fields: {
    title?: string
    description?: string
    image?: { bytes?: Uint8Array; type?: string }
    composite?: boolean
  } = {},
): Promise<Response> {
  const fd = new FormData()
  if (fields.title !== undefined) fd.append('title', fields.title)
  if (fields.description !== undefined) fd.append('description', fields.description)
  if (fields.image) {
    fd.append(
      'image',
      new File([fields.image.bytes ?? new Uint8Array([137, 80, 78, 71])], 'image.jpg', {
        type: fields.image.type ?? 'image/jpeg',
      }),
    )
  }
  if (fields.composite) {
    for (const field of ['composite', 'image1', 'image2', 'image3'] as const) {
      fd.append(field, new File([new Uint8Array([137, 80, 78, 71])], `${field}.jpg`, { type: 'image/jpeg' }))
    }
  }
  return SELF.fetch(`${BASE}/api/admin/job-posts/${id}?category=${category}`, {
    method: 'PATCH',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('PATCH /api/admin/job-posts/:id', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111115')

    expect((await patchJobPost(undefined, 123, 'don-hang', { title: 'x' })).status).toBe(401)
    expect((await patchJobPost(user.token, 123, 'don-hang', { title: 'x' })).status).toBe(403)
  })

  it('single-image category: requires a non-empty title', async () => {
    const admin = await seedAdmin()
    expect((await patchJobPost(admin.token, 123, 'don-hang', { title: '   ' })).status).toBe(400)
  })

  it('single-image category: updates title/description without re-uploading the image', async () => {
    const admin = await seedAdmin()
    let putBody: Record<string, unknown> | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      expect(url).toContain('/wc/v3/products/123')
      expect(init?.method).toBe('PUT')
      putBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ id: 123, permalink: WP_PRODUCT_PERMALINK }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const res = await patchJobPost(admin.token, 123, 'don-hang', { title: 'Tiêu đề mới', description: 'Mô tả mới' })
    expect(res.status).toBe(200)
    expect(putBody).toEqual({ name: 'Tiêu đề mới', description: 'Mô tả mới' }) // no `images` key at all
    expect(wpUploads).toBe(0) // no image sent, so no upload happened
  })

  it('single-image category: uploads and includes a new image only when one is provided', async () => {
    const admin = await seedAdmin()
    let putBody: Record<string, unknown> | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wp/v2/media')) {
        return new Response(JSON.stringify({ id: 950, source_url: 'https://wp.test/new.jpg' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/wc/v3/products/123')) {
        putBody = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({ id: 123, permalink: WP_PRODUCT_PERMALINK }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await patchJobPost(admin.token, 123, 'don-hang', { title: 'x', description: '', image: {} })
    expect(res.status).toBe(200)
    expect(putBody).toEqual({ name: 'x', description: '', images: [{ id: 950 }] })
  })

  it('composite category: rejects a partial image set', async () => {
    const admin = await seedAdmin()
    const fd = new FormData()
    fd.append('composite', new File([new Uint8Array([1])], 'c.jpg', { type: 'image/jpeg' }))
    fd.append('image1', new File([new Uint8Array([1])], 'i1.jpg', { type: 'image/jpeg' }))
    // image2/image3 omitted on purpose
    const res = await SELF.fetch(`${BASE}/api/admin/job-posts/123?category=don-nam`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${admin.token}` },
      body: fd,
    })
    expect(res.status).toBe(400)
  })

  it('composite category: replaces all 4 images', async () => {
    const admin = await seedAdmin()
    let putBody: Record<string, unknown> | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wp/v2/media')) {
        wpUploads++
        return new Response(JSON.stringify({ id: 900 + wpUploads, source_url: 'https://wp.test/x.jpg' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/wc/v3/products/123')) {
        expect(init?.method).toBe('PUT')
        putBody = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({ id: 123, permalink: WP_PRODUCT_PERMALINK }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await patchJobPost(admin.token, 123, 'don-nam', { composite: true })
    expect(res.status).toBe(200)
    expect(putBody).toEqual({ images: [{ id: 901 }, { id: 902 }, { id: 903 }, { id: 904 }] })
  })

  it('returns 502 when the WordPress update fails', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 500 }))

    const res = await patchJobPost(admin.token, 123, 'don-hang', { title: 'x', description: '' })
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/job-posts.test.ts -t "PATCH /api/admin/job-posts/:id"`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 4: Add `updateWpProduct` to `src/lib/wpProducts.ts`**

Add after `createWpProduct`, before `listWpProducts`:

```ts
export type UpdateWpProductInput =
  | { imageIds: [number, number, number, number] }
  | { imageId?: number; title: string; description: string }

export async function updateWpProduct(
  env: WpProductEnv,
  id: number,
  input: UpdateWpProductInput,
): Promise<WpProductResult> {
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)

  // Fields omitted from the body are left untouched by WooCommerce's REST API (confirmed live
  // against the site — see this task's Step 1) — that's what lets a single-image category's
  // title-only edit skip re-uploading the image.
  const body =
    'imageIds' in input
      ? { images: input.imageIds.map((imgId) => ({ id: imgId })) }
      : {
          name: input.title,
          description: input.description,
          ...(input.imageId !== undefined ? { images: [{ id: input.imageId }] } : {}),
        }

  const res = await fetch(`${env.WP_API_BASE}/wc/v3/products/${id}`, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }

  const data = (await res.json()) as { id: number; permalink: string }
  return { id: data.id, permalink: data.permalink }
}
```

- [ ] **Step 5: Add the `PATCH /:id` route to `src/routes/jobPosts.ts`**

Add `updateWpProduct` to the `from '../lib/wpProducts'` import list, then add this route right after `jobPostRoutes.get('/:id', ...)` and before `jobPostRoutes.delete('/:id', ...)`:

```ts
jobPostRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400)

  const category = c.req.query('category') ?? ''
  if (!isJobPostCategory(category)) {
    return c.json({ error: 'invalid category' }, 400)
  }

  const body = await c.req.parseBody()

  if (usesThreeImages(category)) {
    const parsed = await parseCompositeImages(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

    let uploads: { id: number; sourceUrl: string }[]
    try {
      uploads = await Promise.all(
        parsed.files.map((file, i) =>
          uploadImageToWp(c.env, parsed.buffers[i], file.name || 'upload.jpg', file.type),
        ),
      )
    } catch (err) {
      if (err instanceof WpUploadError) {
        return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
      }
      throw err
    }

    const [compositeId, image1Id, image2Id, image3Id] = uploads.map((u) => u.id)
    try {
      const product = await updateWpProduct(c.env, id, {
        imageIds: [compositeId, image1Id, image2Id, image3Id],
      })
      return c.json({ jobPost: product })
    } catch (err) {
      if (err instanceof WpProductError) {
        return c.json({ error: 'product update on WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
      }
      throw err
    }
  }

  const parsedText = parseTitleAndDescription(body)
  if (!parsedText.ok) return c.json({ error: parsedText.error }, 400)

  let imageId: number | undefined
  if (body['image'] !== undefined) {
    const image = body['image']
    if (!(image instanceof File)) return c.json({ error: 'ảnh phải là file' }, 400)
    if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
      return c.json({ error: 'ảnh phải là JPEG, PNG hoặc WebP' }, 400)
    }
    const buf = await image.arrayBuffer()
    if (buf.byteLength === 0) return c.json({ error: 'ảnh rỗng' }, 400)
    if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'ảnh vượt quá 8MB' }, 413)

    try {
      const upload = await uploadImageToWp(c.env, buf, image.name || 'upload.jpg', image.type)
      imageId = upload.id
    } catch (err) {
      if (err instanceof WpUploadError) {
        return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
      }
      throw err
    }
  }

  try {
    const product = await updateWpProduct(c.env, id, {
      title: parsedText.title,
      description: parsedText.description,
      imageId,
    })
    return c.json({ jobPost: product })
  } catch (err) {
    if (err instanceof WpProductError) {
      return c.json({ error: 'product update on WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
    }
    throw err
  }
})
```

- [ ] **Step 6: Run the full job-posts test file**

Run: `npx vitest run test/job-posts.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full server test suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/wpProducts.ts src/routes/jobPosts.ts test/job-posts.test.ts
git commit -m "$(cat <<'EOF'
feat: add PATCH /api/admin/job-posts/:id for editing

Composite categories (Đơn nam/Đơn nữ) require all 3 source images
together, same as create. Single-image categories always resend
title/description and only re-upload the image when the admin picked a
replacement — verified live that WooCommerce's PUT leaves images alone
when the field is omitted.
EOF
)"
```

---

## Task 4: Client — `adminJobPosts.ts` (types, create/edit/detail hooks)

**Files:**
- Modify: `xkld-tools-client/src/lib/adminJobPosts.ts`

- [ ] **Step 1: Replace the file's category/create section**

Replace everything from the top of the file through the end of `useCreateJobPost` with:

```ts
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { req, reqMultipart, type Paginated } from './api'
import { AppError } from './error'

export type JobPostCategory =
  | 'don-nam'
  | 'don-nu'
  | 'don-hang'
  | 'hoc-vien-xuat-canh'
  | 'dang-ky-don'
  | 'phong-van-va-nhap-hoc'
  | 'hoc-vien-tai-nhat'

export const CATEGORY_LABEL: Record<JobPostCategory, string> = {
  'don-nam': 'Đơn nam',
  'don-nu': 'Đơn nữ',
  'don-hang': 'Câu hỏi đi Nhật',
  'hoc-vien-xuat-canh': 'Học viên xuất cảnh',
  'dang-ky-don': 'Đăng ký đi Nhật',
  'phong-van-va-nhap-hoc': 'Phỏng vấn đơn hàng',
  'hoc-vien-tai-nhat': 'Đón tiếp học viên',
}

export function isJobPostCategory(value: unknown): value is JobPostCategory {
  return typeof value === 'string' && value in CATEGORY_LABEL
}

// Đơn nam/Đơn nữ are 3-photo job orders composited client-side; every other category is a plain
// 1-photo product with a title/description (mirrors src/lib/wpProducts.ts's server-side split).
const THREE_IMAGE_CATEGORIES: ReadonlySet<JobPostCategory> = new Set(['don-nam', 'don-nu'])

export function usesThreeImages(category: JobPostCategory): category is 'don-nam' | 'don-nu' {
  return THREE_IMAGE_CATEGORIES.has(category)
}

export interface JobPostResult {
  id: number
  permalink: string
}

export type CreateJobPostInput =
  | { category: 'don-nam' | 'don-nu'; composite: Blob; image1: File; image2: File; image3: File }
  | {
      category: Exclude<JobPostCategory, 'don-nam' | 'don-nu'>
      title: string
      description: string
      image: File
    }

export function useCreateJobPost() {
  const queryClient = useQueryClient()
  return useMutation<{ jobPost: JobPostResult }, AppError, CreateJobPostInput>({
    mutationFn: (input) => {
      const form = new FormData()
      form.set('category', input.category)
      if ('composite' in input) {
        form.set('composite', input.composite, 'composite.jpg')
        form.set('image1', input.image1)
        form.set('image2', input.image2)
        form.set('image3', input.image3)
      } else {
        form.set('title', input.title)
        form.set('description', input.description)
        form.set('image', input.image)
      }
      return reqMultipart<{ jobPost: JobPostResult }>('/api/admin/job-posts', form)
    },
    onSuccess: (_data, { category }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'job-posts', category] })
    },
  })
}
```

- [ ] **Step 2: Add `JobPostDetail`, `useJobPost`, and `useUpdateJobPost` after `useJobPosts`**

Find the existing `useJobPosts` function (unchanged — keep it as-is) and add these right after it, before `useDeleteJobPost`:

```ts
/** Full product detail (list rows don't include description) — used by the edit form's pre-fill. */
export interface JobPostDetail {
  id: number
  name: string
  description: string
  images: { id: number; src: string }[]
}

export function useJobPost(id: number, category: JobPostCategory) {
  return useQuery<{ jobPost: JobPostDetail }, AppError, JobPostDetail>({
    queryKey: ['admin', 'job-posts', 'detail', category, id] as const,
    queryFn: () => req<{ jobPost: JobPostDetail }>(`/api/admin/job-posts/${id}?category=${category}`),
    select: (data) => data.jobPost,
  })
}

export type UpdateJobPostInput =
  | { composite: Blob; image1: File; image2: File; image3: File }
  | { title: string; description: string; image: File | null }

export function useUpdateJobPost(id: number, category: JobPostCategory) {
  const queryClient = useQueryClient()
  return useMutation<{ jobPost: JobPostResult }, AppError, UpdateJobPostInput>({
    mutationFn: (input) => {
      const form = new FormData()
      if ('composite' in input) {
        form.set('composite', input.composite, 'composite.jpg')
        form.set('image1', input.image1)
        form.set('image2', input.image2)
        form.set('image3', input.image3)
      } else {
        form.set('title', input.title)
        form.set('description', input.description)
        if (input.image) form.set('image', input.image)
      }
      return reqMultipart<{ jobPost: JobPostResult }>(
        `/api/admin/job-posts/${id}?category=${category}`,
        form,
        'PATCH',
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'job-posts', category] })
    },
  })
}
```

Leave `JobPost`, `useJobPosts`, and `useDeleteJobPost` exactly as they are.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors in `job-posts.new.tsx` (still imports/uses the removed `CATEGORY_LABEL`-as-`<Select>` pattern and the old single-shape `CreateJobPostInput`) — expected at this point, fixed in Task 7. No errors should come from `adminJobPosts.ts` itself.

- [ ] **Step 4: Commit**

```bash
git add src/lib/adminJobPosts.ts
git commit -m "$(cat <<'EOF'
feat: add usesThreeImages, edit hooks to adminJobPosts.ts

useJobPost/useUpdateJobPost back the new edit page; CreateJobPostInput
becomes a union so useCreateJobPost can build the right FormData shape
per category kind. Client code still using the old shapes is fixed in
the following tasks.
EOF
)"
```

---

## Task 5: Client — `CompositeJobPostForm` component

**Files:**
- Create: `xkld-tools-client/src/components/admin/CompositeJobPostForm.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ImageUploadField } from '@/components/admin/ImageUploadField'
import { composeJobPostImage } from '@/lib/composite'

interface CompositeJobPostFormProps {
  submitLabel: string
  pendingLabel: string
  isPending: boolean
  submitError?: string
  onCancel: () => void
  onSubmit: (images: { composite: Blob; image1: File; image2: File; image3: File }) => void
}

/** 3-upload-slots + composite preview UI for Đơn nam/Đơn nữ — shared by the create route
 *  (job-posts.new.tsx) and the edit route (job-posts.$id.tsx). Edit always requires picking all
 *  3 images again (a composite can't be recomputed from fewer than 3 sources), so there's no
 *  pre-fill here — every field starts empty regardless of create vs edit. */
export function CompositeJobPostForm({
  submitLabel,
  pendingLabel,
  isPending,
  submitError,
  onCancel,
  onSubmit,
}: CompositeJobPostFormProps) {
  const [image1, setImage1] = useState<File | null>(null) // content card
  const [image2, setImage2] = useState<File | null>(null) // portrait
  const [image3, setImage3] = useState<File | null>(null) // landscape

  const [composite, setComposite] = useState<Blob | null>(null)
  const [compositePreviewUrl, setCompositePreviewUrl] = useState<string | null>(null)
  const [compositeError, setCompositeError] = useState<string | null>(null)

  // Recompute the composite the moment all 3 images are present, so the admin sees exactly what
  // will be posted before submitting (design doc: preview required).
  useEffect(() => {
    if (!image1 || !image2 || !image3) {
      setComposite(null)
      setCompositeError(null)
      return
    }
    let cancelled = false
    composeJobPostImage(image1, image2, image3)
      .then((blob) => {
        if (!cancelled) {
          setComposite(blob)
          setCompositeError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setComposite(null)
          setCompositeError(err instanceof Error ? err.message : 'Không ghép được ảnh.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [image1, image2, image3])

  useEffect(() => {
    if (!composite) {
      setCompositePreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(composite)
    setCompositePreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [composite])

  const canSubmit = Boolean(composite && image1 && image2 && image3)
  const submit = () => {
    if (!composite || !image1 || !image2 || !image3) return
    onSubmit({ composite, image1, image2, image3 })
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) submit()
      }}
    >
      <div className="grid gap-5 sm:grid-cols-3">
        <ImageUploadField label="Ảnh nội dung" onChange={setImage1} />
        <ImageUploadField label="Ảnh dọc" onChange={setImage2} />
        <ImageUploadField label="Ảnh ngang" onChange={setImage3} />
      </div>

      {compositeError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{compositeError}</p>
      )}

      {compositePreviewUrl && (
        <div className="flex flex-col gap-1.5">
          <Label>Ảnh ghép (xem trước)</Label>
          <img
            src={compositePreviewUrl}
            alt="Ảnh ghép xem trước"
            className="w-full max-w-xs rounded-lg border object-contain"
          />
        </div>
      )}

      {submitError && <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{submitError}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={!canSubmit || isPending}>
          {isPending ? pendingLabel : submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Huỷ
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from this file (the pre-existing `job-posts.new.tsx` errors from Task 4 are still present — untouched until Task 7).

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/CompositeJobPostForm.tsx
git commit -m "feat: extract CompositeJobPostForm for reuse by create and edit"
```

---

## Task 6: Client — `SingleImageJobPostForm` component

**Files:**
- Create: `xkld-tools-client/src/components/admin/SingleImageJobPostForm.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ImageUploadField } from '@/components/admin/ImageUploadField'

interface SingleImageJobPostFormProps {
  submitLabel: string
  pendingLabel: string
  isPending: boolean
  submitError?: string
  initialTitle?: string
  initialDescription?: string
  existingImageUrl?: string
  /** True on create (an image must be picked); false on edit (keeping the current image is
   *  valid — the admin only needs to pick a file when they want to replace it). Only meaningful
   *  the moment this component mounts — the caller must not render it until any async pre-fill
   *  data (edit mode) has already arrived, since initialTitle/initialDescription only seed state
   *  once. */
  imageRequired: boolean
  onCancel: () => void
  onSubmit: (data: { title: string; description: string; image: File | null }) => void
}

/** 1-image + title + description UI for the 5 non-composite categories — shared by the create
 *  route (job-posts.new.tsx) and the edit route (job-posts.$id.tsx). */
export function SingleImageJobPostForm({
  submitLabel,
  pendingLabel,
  isPending,
  submitError,
  initialTitle = '',
  initialDescription = '',
  existingImageUrl,
  imageRequired,
  onCancel,
  onSubmit,
}: SingleImageJobPostFormProps) {
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [image, setImage] = useState<File | null>(null)

  const canSubmit = title.trim().length > 0 && (!imageRequired || image !== null)
  const submit = () => {
    if (!canSubmit) return
    onSubmit({ title: title.trim(), description: description.trim(), image })
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) submit()
      }}
    >
      <div className="grid gap-5 md:grid-cols-3">
        <div className="flex flex-col gap-4 md:col-span-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-post-title">Tiêu đề</Label>
            <Input id="job-post-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="job-post-description">Mô tả</Label>
            <Textarea
              id="job-post-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={8}
            />
          </div>
        </div>

        <ImageUploadField existingImageUrl={existingImageUrl} onChange={setImage} />
      </div>

      {submitError && <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{submitError}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={!canSubmit || isPending}>
          {isPending ? pendingLabel : submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Huỷ
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/SingleImageJobPostForm.tsx
git commit -m "feat: add SingleImageJobPostForm for the 5 non-composite categories"
```

---

## Task 7: Client — rewrite `job-posts.new.tsx`

**Files:**
- Modify: `xkld-tools-client/src/routes/admin/job-posts.new.tsx`

- [ ] **Step 1: Replace the whole file**

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AdminShell, AdminCard } from '@/components/shell/AdminShell'
import { CompositeJobPostForm } from '@/components/admin/CompositeJobPostForm'
import { SingleImageJobPostForm } from '@/components/admin/SingleImageJobPostForm'
import { isJobPostCategory, useCreateJobPost, usesThreeImages, type JobPostCategory } from '@/lib/adminJobPosts'

export const Route = createFileRoute('/admin/job-posts/new')({
  // Category comes from the list page's URL (each dashboard tile deep-links to one category) —
  // same validateSearch shape as job-posts.index.tsx. There is no category picker in this form.
  validateSearch: (search: Record<string, unknown>): { category?: JobPostCategory } => ({
    category: isJobPostCategory(search.category) ? search.category : undefined,
  }),
  component: NewJobPostPage,
})

function NewJobPostPage() {
  const navigate = useNavigate()
  const { category = 'don-nam' } = Route.useSearch()
  const createJobPost = useCreateJobPost()

  const goToList = () => navigate({ to: '/admin/job-posts', search: { category } })

  return (
    <AdminShell title="Đăng đơn hàng" onBack={goToList}>
      <AdminCard className="px-5 py-5">
        {usesThreeImages(category) ? (
          <CompositeJobPostForm
            submitLabel="Đăng"
            pendingLabel="Đang đăng…"
            isPending={createJobPost.isPending}
            submitError={createJobPost.error?.message}
            onCancel={goToList}
            onSubmit={(images) => createJobPost.mutate({ category, ...images }, { onSuccess: goToList })}
          />
        ) : (
          <SingleImageJobPostForm
            submitLabel="Đăng"
            pendingLabel="Đang đăng…"
            isPending={createJobPost.isPending}
            submitError={createJobPost.error?.message}
            imageRequired
            onCancel={goToList}
            onSubmit={({ title, description, image }) => {
              if (!image) return
              createJobPost.mutate({ category, title, description, image }, { onSuccess: goToList })
            }}
          />
        )}
      </AdminCard>
    </AdminShell>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors from this file. (`job-posts.index.tsx` still has stale references fixed in Task 10 — ignore those for now.)

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/job-posts.new.tsx
git commit -m "$(cat <<'EOF'
feat: drop category picker from job-posts.new.tsx, branch by format

Category now comes from the URL (the list page's current tab) instead
of a <Select> — redundant since every category already has its own
dashboard tile. Renders CompositeJobPostForm or SingleImageJobPostForm
depending on the category.
EOF
)"
```

---

## Task 8: Client — new edit route `job-posts.$id.tsx`

**Files:**
- Create: `xkld-tools-client/src/routes/admin/job-posts.$id.tsx`

- [ ] **Step 1: Write the route**

Follows the same file-naming convention as `guides.$id.tsx` (the single-item page IS the edit page, no separate `/edit` path segment).

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AdminShell, AdminCard } from '@/components/shell/AdminShell'
import { CompositeJobPostForm } from '@/components/admin/CompositeJobPostForm'
import { SingleImageJobPostForm } from '@/components/admin/SingleImageJobPostForm'
import {
  isJobPostCategory,
  useJobPost,
  useUpdateJobPost,
  usesThreeImages,
  type JobPostCategory,
} from '@/lib/adminJobPosts'

export const Route = createFileRoute('/admin/job-posts/$id')({
  validateSearch: (search: Record<string, unknown>): { category?: JobPostCategory } => ({
    category: isJobPostCategory(search.category) ? search.category : undefined,
  }),
  component: EditJobPostPage,
})

function EditJobPostPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { category = 'don-nam' } = Route.useSearch()
  const numericId = Number(id)

  const { data: jobPost, isError, error } = useJobPost(numericId, category)
  const updateJobPost = useUpdateJobPost(numericId, category)

  const goToList = () => navigate({ to: '/admin/job-posts', search: { category } })

  if (isError) {
    return (
      <AdminShell title="Sửa đơn hàng" onBack={goToList}>
        <AdminCard className="px-5 py-5 text-sm text-slate-500">
          {error.status === 404 ? 'Không tìm thấy bài đăng.' : error.message}
        </AdminCard>
      </AdminShell>
    )
  }

  // Guarding on `!jobPost` (rather than the query's isPending) both shows a loading state and
  // narrows jobPost to defined for the rest of the component — SingleImageJobPostForm's
  // initialTitle/initialDescription only seed state once at mount, so it must not render before
  // the real values are known.
  if (!jobPost) {
    return (
      <AdminShell title="Sửa đơn hàng" onBack={goToList}>
        <AdminCard className="px-5 py-5 text-sm text-slate-500">Đang tải…</AdminCard>
      </AdminShell>
    )
  }

  return (
    <AdminShell title="Sửa đơn hàng" onBack={goToList}>
      <AdminCard className="px-5 py-5">
        {usesThreeImages(category) ? (
          <CompositeJobPostForm
            submitLabel="Lưu"
            pendingLabel="Đang lưu…"
            isPending={updateJobPost.isPending}
            submitError={updateJobPost.error?.message}
            onCancel={goToList}
            onSubmit={(images) => updateJobPost.mutate(images, { onSuccess: goToList })}
          />
        ) : (
          <SingleImageJobPostForm
            submitLabel="Lưu"
            pendingLabel="Đang lưu…"
            isPending={updateJobPost.isPending}
            submitError={updateJobPost.error?.message}
            initialTitle={jobPost.name}
            initialDescription={jobPost.description}
            existingImageUrl={jobPost.images[0]?.src}
            imageRequired={false}
            onCancel={goToList}
            onSubmit={(data) => updateJobPost.mutate(data, { onSuccess: goToList })}
          />
        )}
      </AdminCard>
    </AdminShell>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/job-posts.\$id.tsx
git commit -m "$(cat <<'EOF'
feat: add job-posts/$id edit route

Composite categories require re-uploading all 3 source images (can't
recompute a composite from fewer); single-image categories pre-fill
title/description and let the current image stay untouched unless the
admin picks a replacement.
EOF
)"
```

---

## Task 9: Client — `DeleteJobPostModal` component

**Files:**
- Create: `xkld-tools-client/src/components/admin/DeleteJobPostModal.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { AdminModal } from '@/components/shell/AdminModal'
import { Button } from '@/components/ui/button'
import { useDeleteJobPost, type JobPost, type JobPostCategory } from '@/lib/adminJobPosts'

/** Replaces the old "click Xoá twice" inline pattern with a real confirm modal — plain
 *  confirmation text, no image preview (the admin already sees the row behind the modal). */
export function DeleteJobPostModal({
  jobPost,
  category,
  onClose,
}: {
  jobPost: JobPost
  category: JobPostCategory
  onClose: () => void
}) {
  const deleteJobPost = useDeleteJobPost(category)

  return (
    <AdminModal
      title="Xoá bài đăng"
      description="Bạn có chắc muốn xoá bài đăng này? Hành động này không thể hoàn tác."
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant="destructive"
            disabled={deleteJobPost.isPending}
            onClick={() => deleteJobPost.mutate(jobPost.id, { onSuccess: onClose })}
          >
            {deleteJobPost.isPending ? 'Đang xoá…' : 'Xoá'}
          </Button>
        </>
      }
    >
      {deleteJobPost.isError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{deleteJobPost.error.message}</p>
      )}
    </AdminModal>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/DeleteJobPostModal.tsx
git commit -m "feat: add DeleteJobPostModal"
```

---

## Task 10: Client — rewrite `job-posts.index.tsx` (Sửa button, delete modal, search passthrough)

**Files:**
- Modify: `xkld-tools-client/src/routes/admin/job-posts.index.tsx`

- [ ] **Step 1: Replace the whole file**

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { AdminShell, AdminCard } from '@/components/shell/AdminShell'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Pagination } from '@/components/Pagination'
import { DeleteJobPostModal } from '@/components/admin/DeleteJobPostModal'
import {
  CATEGORY_LABEL,
  isJobPostCategory,
  useJobPosts,
  type JobPost,
  type JobPostCategory,
} from '@/lib/adminJobPosts'

export const Route = createFileRoute('/admin/job-posts/')({
  // The selected category tile lives in the URL so a dashboard tile can deep-link into it and a
  // refresh reopens the same tab.
  validateSearch: (search: Record<string, unknown>): { category?: JobPostCategory } => ({
    category: isJobPostCategory(search.category) ? search.category : undefined,
  }),
  component: AdminJobPostsPage,
})

function JobPostRow({
  jobPost,
  onEdit,
  onRequestDelete,
}: {
  jobPost: JobPost
  onEdit: () => void
  onRequestDelete: () => void
}) {
  return (
    <TableRow>
      <TableCell>
        {jobPost.images[0] ? (
          <img src={jobPost.images[0].src} alt="" className="h-12 w-12 rounded object-cover" />
        ) : (
          <div className="h-12 w-12 rounded bg-slate-100" />
        )}
      </TableCell>
      <TableCell>{new Date(jobPost.dateCreated).toLocaleDateString('vi-VN')}</TableCell>
      <TableCell>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            Sửa
          </Button>
          <Button size="sm" variant="outline" onClick={onRequestDelete}>
            Xoá
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

// Fixed-height placeholder rows shown only on the very first load for a category (no cached
// data yet) — matches the real row height so the table doesn't jump once data arrives.
function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableRow key={i}>
          <TableCell>
            <div className="h-12 w-12 animate-pulse rounded bg-slate-100" />
          </TableCell>
          <TableCell>
            <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
          </TableCell>
          <TableCell>
            <div className="h-8 w-14 animate-pulse rounded bg-slate-100" />
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

function AdminJobPostsPage() {
  const navigate = useNavigate()
  const { category = 'don-nam' } = Route.useSearch()
  const [page, setPage] = useState(1)
  const [deletingJobPost, setDeletingJobPost] = useState<JobPost | null>(null)
  const { data, isPending } = useJobPosts(category, page)

  return (
    <AdminShell
      title={CATEGORY_LABEL[category]}
      subtitle={data ? `${data.total} bài` : 'Đang tải…'}
      backTo="/admin/dashboard"
      action={
        <Button
          className="gap-1.5"
          onClick={() => navigate({ to: '/admin/job-posts/new', search: { category } })}
        >
          <Plus className="h-4 w-4" />
          Đăng đơn hàng
        </Button>
      }
    >
      <AdminCard>
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="px-5 font-bold text-slate-600">Ảnh</TableHead>
              <TableHead className="font-bold text-slate-600">Ngày đăng</TableHead>
              <TableHead className="px-5 font-bold text-slate-600">Hành động</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <SkeletonRows />}
            {data?.jobPosts.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center text-sm text-slate-500">
                  Chưa có đơn hàng nào trong danh mục này.
                </TableCell>
              </TableRow>
            )}
            {data?.jobPosts.map((jobPost) => (
              <JobPostRow
                key={jobPost.id}
                jobPost={jobPost}
                onEdit={() =>
                  navigate({
                    to: '/admin/job-posts/$id',
                    params: { id: String(jobPost.id) },
                    search: { category },
                  })
                }
                onRequestDelete={() => setDeletingJobPost(jobPost)}
              />
            ))}
          </TableBody>
        </Table>
      </AdminCard>

      <Pagination page={data?.page ?? page} limit={data?.limit ?? 1} total={data?.total ?? 0} onPageChange={setPage} />

      {deletingJobPost && (
        <DeleteJobPostModal jobPost={deletingJobPost} category={category} onClose={() => setDeletingJobPost(null)} />
      )}
    </AdminShell>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in the client project.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin/job-posts.index.tsx
git commit -m "$(cat <<'EOF'
feat: add Sửa button and delete confirm modal to job-posts list

Replaces the inline "click Xoá twice" pattern with DeleteJobPostModal.
The "Đăng đơn hàng" button and each row's new "Sửa" button both carry
the list's current category through via the URL.
EOF
)"
```

---

## Task 11: Full regression — server tests, client typecheck, manual browser walkthrough

**Files:** none (verification only — may produce a follow-up fix commit if something's broken)

- [ ] **Step 1: Run the full server test suite**

Run (from `xkld-tools/`): `npx vitest run`
Expected: all tests pass (151+ existing plus this plan's new ones).

- [ ] **Step 2: Run the server typecheck**

Run (from `xkld-tools/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the client typecheck**

Run (from `xkld-tools-client/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual browser walkthrough — composite category (Đơn nam)**

With both `npx wrangler dev` (xkld-tools, :8787) and `npx vite` (xkld-tools-client, :5173) running:

1. Log into the local admin UI, go to the "Đơn nam" dashboard tile.
2. Click "Đăng đơn hàng" — confirm there is no category dropdown, only the 3 image slots.
3. Upload 3 real images, confirm the composite preview renders, submit, confirm redirect back to the list and the new post appears.
4. Click "Sửa" on that row — confirm the edit page shows the same 3 empty upload slots (no pre-fill), upload 3 new images, submit, confirm it saves.
5. Click "Xoá" on a row — confirm a modal appears (not the old inline double-click), confirm "Huỷ" closes it without deleting, confirm "Xoá" deletes and the row disappears.

- [ ] **Step 5: Manual browser walkthrough — single-image category (e.g. Câu hỏi đi Nhật)**

1. Go to the "Câu hỏi đi Nhật" dashboard tile.
2. Click "Đăng đơn hàng" — confirm 1 image slot + Tiêu đề + Mô tả fields, no category dropdown.
3. Try submitting with an empty title — confirm the submit button stays disabled.
4. Fill title + image (description optional), submit, confirm redirect and the new post appears.
5. Click "Sửa" on that row — confirm title/description are pre-filled and the current image shows as the existing preview.
6. Change only the title (leave image untouched), save — confirm it saves without requiring a new image.
7. Delete via the confirm modal, same as Step 4 above.

- [ ] **Step 6: Fix anything broken, then re-run Steps 1–3**

If any manual check in Steps 4–5 fails, fix the underlying code, re-run the full server test suite and both typechecks, and re-verify the specific failing check in the browser before proceeding.

- [ ] **Step 7: Final commit (only if Step 6 required fixes)**

```bash
git add -A
git commit -m "fix: address issues found in job-post edit manual walkthrough"
```

If Step 6 required no fixes, skip this step — there's nothing new to commit.
