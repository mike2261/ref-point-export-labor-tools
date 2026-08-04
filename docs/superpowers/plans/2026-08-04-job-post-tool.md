# Job Post Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload 3 images (content card + portrait + landscape), preview a client-composited square image made from them, and post a WooCommerce product (in "Đơn nam" or "Đơn nữ") with the composite as the featured image and the 3 originals as the gallery.

**Architecture:** New standalone slice in both repos — a pure layout-math + Canvas compositing module and a new admin route in `xkld-tools-client`; a new WP-product-creation lib function and admin route in `xkld-tools` that reuses the existing `uploadImageToWp()` media-upload helper. No new D1 table — the product lives entirely in WordPress once created.

**Tech Stack:** Hono + D1 + Vitest (`cloudflare:test` pool) on the backend; React + TanStack Router + Canvas API + shadcn/ui on the frontend. WordPress REST API (`wc/v3/products`) via HTTP Basic Auth with the existing Application Password.

**Design doc:** `docs/superpowers/specs/2026-08-04-job-post-tool-design.md`

---

## Confirmed facts (checked live against xklddieuduong.vn — not placeholders)

- `wc/v3/products` exists and is writable. Schema fields used: `name` (string), `status`
  (string), `categories` (array of `{ id: number }`), `images` (array of `{ id: number }` —
  **first entry is the featured image, the rest become the gallery**).
- Category term IDs: **Đơn nam = 75**, **Đơn nữ = 76** (slugs `don-nam` / `don-nu`).
- The site's REST base is queried as `https://xklddieuduong.vn/index.php?rest_route=<path>`
  (plain permalinks — this is `env.WP_API_BASE`, already set in `wrangler.jsonc`). Existing
  code appends a **leading-slash** path, e.g. `` `${env.WP_API_BASE}/wp/v2/media` `` — the new
  code must follow the same shape: `` `${env.WP_API_BASE}/wc/v3/products` ``.
- `wc/v3` write/list access requires the authenticated WP user to have `manage_woocommerce`
  capability (confirmed: an unauthenticated/under-privileged request gets
  `401 woocommerce_rest_cannot_view`). The Worker's `WP_MEDIA_USER` Application Password must
  belong to a user with that capability (Administrator or Shop Manager) — Task 3's manual
  smoke test against the real site is what actually proves this; if it 401s, the fix is
  changing that WP user's role, not the code.

---

## File map

**Backend (`xkld-tools`):**
- Create: `src/lib/wpProducts.ts` — `createWpProduct()`, category→term-ID mapping.
- Create: `src/routes/jobPosts.ts` — `POST /` handler (mounted at `/api/admin/job-posts`).
- Modify: `src/index.ts` — mount the new route.
- Create: `test/job-posts.test.ts` — route tests (auth, validation, happy path, WP failure).

**Frontend (`xkld-tools-client`):**
- Create: `src/lib/composite.ts` — `computeSquareLayout()` (pure) + `composeSquareImage()`
  (Canvas drawing).
- Create: `src/lib/adminJobPosts.ts` — `useCreateJobPost()` mutation hook.
- Create: `src/routes/admin/job-posts.new.tsx` — the form page.
- Modify: `src/components/shell/AdminNavTile.tsx` — add the new route to `AdminRoute`.
- Modify: `src/routes/admin/dashboard.tsx` — add a nav tile.

---

## Task 1: Backend — `createWpProduct()`

**Files:**
- Create: `src/lib/wpProducts.ts`

- [ ] **Step 1: Write the module**

```typescript
// Create a WooCommerce product from already-uploaded WP media IDs. Runs SERVER-SIDE ONLY, same
// as lib/wpMedia.ts's uploadImageToWp — the Application Password never reaches the browser.
//
// Category term IDs are hardcoded: these are two fixed site categories (docs/superpowers/specs/
// 2026-08-04-job-post-tool-design.md), not something an admin picks a new one of, so there's no
// lookup call here — just the two real IDs confirmed live against the site.
const CATEGORY_TERM_IDS = {
  'don-nam': 75,
  'don-nu': 76,
} as const

export type JobPostCategory = keyof typeof CATEGORY_TERM_IDS

export function isJobPostCategory(value: string): value is JobPostCategory {
  return value === 'don-nam' || value === 'don-nu'
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

export interface CreateWpProductInput {
  category: JobPostCategory
  /** First ID is the featured image; the rest become the product gallery. */
  imageIds: [number, number, number, number]
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

  const res = await fetch(`${env.WP_API_BASE}/wc/v3/products`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      // Never shown to or entered by the admin — WooCommerce requires a non-empty title, this
      // just satisfies that (design doc: "Non-goals").
      name: `job-post-${Date.now()}`,
      status: 'publish',
      categories: [{ id: CATEGORY_TERM_IDS[input.category] }],
      images: input.imageIds.map((id) => ({ id })),
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }

  const data = (await res.json()) as { id: number; permalink: string }
  return { id: data.id, permalink: data.permalink }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/ducmai/work/xkld-tools && npx tsc --noEmit`
Expected: no errors mentioning `wpProducts.ts`.

- [ ] **Step 3: Commit**

```bash
cd /home/ducmai/work/xkld-tools
git add src/lib/wpProducts.ts
git commit -m "feat: add createWpProduct for job-post WooCommerce product creation"
```

---

## Task 2: Backend — `POST /api/admin/job-posts` route

**Files:**
- Create: `src/routes/jobPosts.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the route**

```typescript
// Admin tool: upload 3 images (a pre-made content card + a portrait + a landscape photo) plus
// a client-composited square image made from them, and turn that into a WooCommerce product in
// "Đơn nam" or "Đơn nữ" — see docs/superpowers/specs/2026-08-04-job-post-tool-design.md.
//
// Unlike posts/guides (routes/admin.ts), this has no D1 table: nothing to list, edit, or query
// later — the product lives entirely in WordPress once created (design doc "Non-goals").
import { Hono } from 'hono'
import { requireSuperAdmin } from '../middleware/auth'
import { uploadImageToWp, WpUploadError } from '../lib/wpMedia'
import { createWpProduct, isJobPostCategory, WpProductError } from '../lib/wpProducts'
import type { AppEnv } from '../types'

export const jobPostRoutes = new Hono<AppEnv>()

jobPostRoutes.use('*', requireSuperAdmin)

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8 MB — matches routes/admin.ts's posts/guides limit
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
// Client field name -> human label, used only in validation error messages.
const IMAGE_FIELDS = [
  ['composite', 'ảnh ghép'],
  ['image1', 'ảnh nội dung'],
  ['image2', 'ảnh dọc'],
  ['image3', 'ảnh ngang'],
] as const

jobPostRoutes.post('/', async (c) => {
  const body = await c.req.parseBody()

  const category = typeof body['category'] === 'string' ? body['category'] : ''
  if (!isJobPostCategory(category)) {
    return c.json({ error: 'category must be "don-nam" or "don-nu"' }, 400)
  }

  const files: File[] = []
  for (const [field, label] of IMAGE_FIELDS) {
    const file = body[field]
    if (!(file instanceof File)) return c.json({ error: `${label} là bắt buộc` }, 400)
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return c.json({ error: `${label} phải là JPEG, PNG hoặc WebP` }, 400)
    }
    files.push(file)
  }

  const buffers: ArrayBuffer[] = []
  for (let i = 0; i < files.length; i++) {
    const buf = await files[i].arrayBuffer()
    if (buf.byteLength === 0) return c.json({ error: `${IMAGE_FIELDS[i][1]} rỗng` }, 400)
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return c.json({ error: `${IMAGE_FIELDS[i][1]} vượt quá 8MB` }, 413)
    }
    buffers.push(buf)
  }

  let uploads: { id: number; sourceUrl: string }[]
  try {
    uploads = await Promise.all(
      files.map((file, i) => uploadImageToWp(c.env, buffers[i], file.name || 'upload.jpg', file.type)),
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
})
```

- [ ] **Step 2: Mount the route**

In `src/index.ts`, add the import alongside the other route imports:

```typescript
import { jobPostRoutes } from './routes/jobPosts'
```

And mount it alongside the other `/api/admin/*` mounts (after the `adminRoutes` line):

```typescript
app.route('/api/admin/job-posts', jobPostRoutes)
```

- [ ] **Step 3: Typecheck**

Run: `cd /home/ducmai/work/xkld-tools && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/ducmai/work/xkld-tools
git add src/routes/jobPosts.ts src/index.ts
git commit -m "feat: add POST /api/admin/job-posts route"
```

---

## Task 3: Backend — route tests

**Files:**
- Create: `test/job-posts.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, registerUser, seedAdmin } from './helpers'

const WP_MEDIA_URL = 'https://wp.test/wp-content/uploads/2026/08/job.jpg'
const WP_PRODUCT_PERMALINK = 'https://xklddieuduong.vn/?product=123'

// Same approach as test/posts.test.ts: stub global fetch to intercept the Worker's two outbound
// WordPress calls (media upload, product creation). SELF.fetch (test -> Worker) is unaffected.
let wpUploads = 0
let wpProductCreates = 0
let lastProductBody: Record<string, unknown> | null = null

beforeEach(() => {
  wpUploads = 0
  wpProductCreates = 0
  lastProductBody = null
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    if (url.includes('/wp/v2/media')) {
      wpUploads++
      return new Response(
        JSON.stringify({ id: 900 + wpUploads, source_url: `${WP_MEDIA_URL}-${wpUploads}` }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/wc/v3/products')) {
      wpProductCreates++
      lastProductBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({ id: 123, permalink: WP_PRODUCT_PERMALINK }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`)
  })
})
afterEach(() => vi.restoreAllMocks())

interface JobPostFields {
  category?: string
  omitCategory?: boolean
  images?: Partial<Record<'composite' | 'image1' | 'image2' | 'image3', { bytes?: Uint8Array; filename?: string; type?: string }>>
  omitFields?: ('composite' | 'image1' | 'image2' | 'image3')[]
}

function createJobPost(token: string | undefined, f: JobPostFields = {}): Promise<Response> {
  const fd = new FormData()
  if (!f.omitCategory) fd.append('category', f.category ?? 'don-nam')

  const fields: ('composite' | 'image1' | 'image2' | 'image3')[] = ['composite', 'image1', 'image2', 'image3']
  for (const field of fields) {
    if (f.omitFields?.includes(field)) continue
    const spec = f.images?.[field] ?? {}
    const bytes = spec.bytes ?? new Uint8Array([137, 80, 78, 71])
    fd.append(field, new File([bytes], spec.filename ?? `${field}.jpg`, { type: spec.type ?? 'image/jpeg' }))
  }

  return SELF.fetch(`${BASE}/api/admin/job-posts`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('POST /api/admin/job-posts', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111111')

    expect((await createJobPost(undefined)).status).toBe(401)
    expect((await createJobPost(user.token)).status).toBe(403)
  })

  it('validates category and required images before touching WordPress', async () => {
    const admin = await seedAdmin()

    expect((await createJobPost(admin.token, { omitCategory: true })).status).toBe(400)
    expect((await createJobPost(admin.token, { category: 'not-a-real-category' })).status).toBe(400)
    expect((await createJobPost(admin.token, { omitFields: ['image2'] })).status).toBe(400)
    expect(
      (await createJobPost(admin.token, { images: { image1: { type: 'text/plain' } } })).status,
    ).toBe(400)

    expect(wpUploads).toBe(0)
    expect(wpProductCreates).toBe(0)
  })

  it('uploads all 4 images and creates a product with the right category and image order', async () => {
    const admin = await seedAdmin()

    const res = await createJobPost(admin.token, { category: 'don-nu' })
    expect(res.status).toBe(201)
    const { jobPost } = await res.json<{ jobPost: { id: number; permalink: string } }>()
    expect(jobPost).toEqual({ id: 123, permalink: WP_PRODUCT_PERMALINK })

    expect(wpUploads).toBe(4)
    expect(wpProductCreates).toBe(1)
    expect(lastProductBody?.categories).toEqual([{ id: 76 }]) // don-nu
    // 4 uploads happened in composite/image1/image2/image3 order, so their assigned WP media
    // IDs (900+n) land in the same order in the product's images array — composite first
    // (featured), then the 3 originals (gallery).
    expect(lastProductBody?.images).toEqual([{ id: 901 }, { id: 902 }, { id: 903 }, { id: 904 }])
    expect(lastProductBody?.status).toBe('publish')
  })

  it('maps don-nam to its real term id', async () => {
    const admin = await seedAdmin()
    await createJobPost(admin.token, { category: 'don-nam' })
    expect(lastProductBody?.categories).toEqual([{ id: 75 }])
  })

  it('returns 502 and creates no product when a media upload fails', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wp/v2/media')) return new Response('nope', { status: 500 })
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await createJobPost(admin.token)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_UPLOAD_FAILED')
  })

  it('returns 502 when product creation fails after images already uploaded', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wp/v2/media')) {
        wpUploads++
        return new Response(JSON.stringify({ id: 900 + wpUploads, source_url: 'https://wp.test/x.jpg' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/wc/v3/products')) return new Response('nope', { status: 500 })
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await createJobPost(admin.token)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
    expect(wpUploads).toBe(4) // the 4 uploads already happened before the product call failed
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ducmai/work/xkld-tools && npx vitest run test/job-posts.test.ts`
Expected: FAIL — `Cannot find module '../routes/jobPosts'` or similar, since `index.ts`'s
route isn't mounted yet if Task 2 wasn't done first. If Task 2 is already done, these should
mostly PASS already (Tasks 2 and 3 together implement + verify the route) — either order is
fine as long as both land together; if they already pass, skip to Step 3.

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /home/ducmai/work/xkld-tools && npx vitest run test/job-posts.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 4: Run the full backend test suite**

Run: `cd /home/ducmai/work/xkld-tools && npx vitest run`
Expected: PASS — no existing tests broken.

- [ ] **Step 5: Commit**

```bash
cd /home/ducmai/work/xkld-tools
git add test/job-posts.test.ts
git commit -m "test: cover POST /api/admin/job-posts"
```

---

## Task 4: Frontend — square-composite module

**Files:**
- Create: `src/lib/composite.ts`

- [ ] **Step 1: Write the module**

```typescript
// Combine 3 images into 1 square image, client-side, per the chosen layout (design doc
// "Composite layout", Option A): the content image keeps its own aspect ratio across the full
// width (never cropped — it has to stay readable); the remaining height is split evenly between
// the portrait and landscape images, each cropped to fill its half.
const OUTPUT_WIDTH = 1080
// Floor so the bottom row never disappears for an unusually tall content image — the canvas
// then ends up taller than wide in that edge case, which beats cropping the content image's
// text to force a perfect square.
const MIN_BOTTOM_HEIGHT = 200

export interface SquareLayout {
  canvasWidth: number
  canvasHeight: number
  contentHeight: number
  bottomHeight: number
}

/** Pure layout math — no DOM/Canvas — so it's trivial to reason about and hand-check by hand
 *  independently of the actual drawing code below. */
export function computeSquareLayout(contentAspectRatio: number): SquareLayout {
  const canvasWidth = OUTPUT_WIDTH
  const contentHeight = Math.round(canvasWidth / contentAspectRatio)
  const bottomHeight = Math.max(MIN_BOTTOM_HEIGHT, canvasWidth - contentHeight)
  const canvasHeight = contentHeight + bottomHeight
  return { canvasWidth, canvasHeight, contentHeight, bottomHeight }
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Không đọc được ảnh, file có thể bị hỏng.'))
    }
    img.src = url
  })
}

/** Draws `img` into the rect (dx, dy, dw, dh), center-cropped to fill it completely (the
 *  CSS `object-fit: cover` behavior, implemented by hand since <canvas> has no such mode). */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const srcAspect = img.naturalWidth / img.naturalHeight
  const dstAspect = dw / dh
  let sx: number, sy: number, sw: number, sh: number
  if (srcAspect > dstAspect) {
    // Source is relatively wider than the destination — crop its left/right edges.
    sh = img.naturalHeight
    sw = sh * dstAspect
    sx = (img.naturalWidth - sw) / 2
    sy = 0
  } else {
    // Source is relatively taller — crop its top/bottom edges.
    sw = img.naturalWidth
    sh = sw / dstAspect
    sx = 0
    sy = (img.naturalHeight - sh) / 2
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

/** Compose the 3 source files into 1 square JPEG. Rejects if any file isn't a decodable image. */
export async function composeSquareImage(content: File, portrait: File, landscape: File): Promise<Blob> {
  const [contentImg, portraitImg, landscapeImg] = await Promise.all([
    loadImage(content),
    loadImage(portrait),
    loadImage(landscape),
  ])

  const layout = computeSquareLayout(contentImg.naturalWidth / contentImg.naturalHeight)

  const canvas = document.createElement('canvas')
  canvas.width = layout.canvasWidth
  canvas.height = layout.canvasHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ canvas 2D.')

  // Top strip: content image at full width, natural aspect ratio, not cropped.
  ctx.drawImage(contentImg, 0, 0, layout.canvasWidth, layout.contentHeight)

  // Bottom strip: portrait (left half) + landscape (right half), each cropped to fill.
  const halfWidth = layout.canvasWidth / 2
  drawCover(ctx, portraitImg, 0, layout.contentHeight, halfWidth, layout.bottomHeight)
  drawCover(ctx, landscapeImg, halfWidth, layout.contentHeight, layout.canvasWidth - halfWidth, layout.bottomHeight)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Không tạo được ảnh ghép.'))),
      'image/jpeg',
      0.92,
    )
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/ducmai/work/xkld-tools-client && npx tsc -b --noEmit`
Expected: no errors mentioning `composite.ts`. (This project has no client-side test runner —
Task 8's manual browser check is the real verification for this module, matching how
`ImageUploadField` and the rest of the admin UI is currently validated in this codebase.)

- [ ] **Step 3: Commit**

```bash
cd /home/ducmai/work/xkld-tools-client
git add src/lib/composite.ts
git commit -m "feat: add client-side square image compositor"
```

---

## Task 5: Frontend — `useCreateJobPost()` hook

**Files:**
- Create: `src/lib/adminJobPosts.ts`

- [ ] **Step 1: Write the hook**

```typescript
import { useMutation } from '@tanstack/react-query'
import { reqMultipart } from './api'
import { AppError } from './error'

export type JobPostCategory = 'don-nam' | 'don-nu'

export interface JobPostResult {
  id: number
  permalink: string
}

export interface CreateJobPostInput {
  category: JobPostCategory
  composite: Blob
  image1: File
  image2: File
  image3: File
}

// No admin.ts-style invalidateQueries here: unlike posts/guides, there's no list view for job
// posts to keep in sync (design doc "Data model" — nothing to list, edit, or query later).
export function useCreateJobPost() {
  return useMutation<{ jobPost: JobPostResult }, AppError, CreateJobPostInput>({
    mutationFn: ({ category, composite, image1, image2, image3 }) => {
      const form = new FormData()
      form.set('category', category)
      form.set('composite', composite, 'composite.jpg')
      form.set('image1', image1)
      form.set('image2', image2)
      form.set('image3', image3)
      return reqMultipart<{ jobPost: JobPostResult }>('/api/admin/job-posts', form)
    },
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/ducmai/work/xkld-tools-client && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/ducmai/work/xkld-tools-client
git add src/lib/adminJobPosts.ts
git commit -m "feat: add useCreateJobPost mutation hook"
```

---

## Task 6: Frontend — the admin form page

**Files:**
- Create: `src/routes/admin/job-posts.new.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AdminShell, AdminCard } from '@/components/shell/AdminShell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ImageUploadField } from '@/components/admin/ImageUploadField'
import { composeSquareImage } from '@/lib/composite'
import { useCreateJobPost, type JobPostCategory } from '@/lib/adminJobPosts'

export const Route = createFileRoute('/admin/job-posts/new')({
  component: NewJobPostPage,
})

function NewJobPostPage() {
  const navigate = useNavigate()
  const [category, setCategory] = useState<JobPostCategory | ''>('')
  const [image1, setImage1] = useState<File | null>(null) // content card
  const [image2, setImage2] = useState<File | null>(null) // portrait
  const [image3, setImage3] = useState<File | null>(null) // landscape

  const [composite, setComposite] = useState<Blob | null>(null)
  const [compositePreviewUrl, setCompositePreviewUrl] = useState<string | null>(null)
  const [compositeError, setCompositeError] = useState<string | null>(null)

  const createJobPost = useCreateJobPost()

  // Recompute the composite the moment all 3 images are present, so the admin sees exactly
  // what will be posted before submitting (design doc: preview required).
  useEffect(() => {
    if (!image1 || !image2 || !image3) {
      setComposite(null)
      setCompositeError(null)
      return
    }
    let cancelled = false
    composeSquareImage(image1, image2, image3)
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

  const canSubmit = Boolean(composite && image1 && image2 && image3 && category)
  const submit = () => {
    if (!composite || !image1 || !image2 || !image3 || !category) return
    createJobPost.mutate(
      { category, composite, image1, image2, image3 },
      { onSuccess: () => navigate({ to: '/admin/dashboard' }) },
    )
  }

  return (
    <AdminShell title="Đăng đơn hàng" onBack={() => navigate({ to: '/admin/dashboard' })}>
      <AdminCard className="px-5 py-5">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) submit()
          }}
        >
          <div className="grid gap-5 sm:grid-cols-3">
            <ImageUploadField onChange={setImage1} />
            <ImageUploadField onChange={setImage2} />
            <ImageUploadField onChange={setImage3} />
          </div>

          <div className="flex flex-col gap-1.5 sm:w-64">
            <Label htmlFor="category">Danh mục</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as JobPostCategory)}>
              <SelectTrigger id="category">
                <SelectValue placeholder="Chọn danh mục" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="don-nam">Đơn nam</SelectItem>
                <SelectItem value="don-nu">Đơn nữ</SelectItem>
              </SelectContent>
            </Select>
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

          {createJobPost.isError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
              {createJobPost.error.message}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={!canSubmit || createJobPost.isPending}>
              {createJobPost.isPending ? 'Đang đăng…' : 'Đăng'}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate({ to: '/admin/dashboard' })}>
              Huỷ
            </Button>
          </div>
        </form>
      </AdminCard>
    </AdminShell>
  )
}
```

Note: `ImageUploadField`'s built-in label always reads "Ảnh" (see `src/components/admin/ImageUploadField.tsx`)
— it isn't parameterized for a custom label. This step ships all 3 upload slots visually
identical (relying on left-to-right position: content, portrait, landscape) rather than editing
a shared component's label prop as a drive-by change. If that ambiguity turns out to confuse
admins in practice, giving `ImageUploadField` an optional `label` prop is a one-line follow-up
— left out here to keep this task's diff scoped to the new feature.

- [ ] **Step 2: Regenerate the route tree**

TanStack Router's Vite plugin generates `src/routeTree.gen.ts` from the files under
`src/routes/` while the dev server runs. Start it briefly so the new route is registered on
disk:

Run: `cd /home/ducmai/work/xkld-tools-client && timeout 8 pnpm dev || true`
Expected: the command starts Vite (prints a `Local:` URL) and exits after the timeout. Then
check the route landed:

Run: `grep -c "job-posts/new" src/routeTree.gen.ts`
Expected: a number > 0.

- [ ] **Step 3: Typecheck**

Run: `cd /home/ducmai/work/xkld-tools-client && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/ducmai/work/xkld-tools-client
git add src/routes/admin/job-posts.new.tsx src/routeTree.gen.ts
git commit -m "feat: add job post creation page"
```

---

## Task 7: Frontend — wire into admin nav

**Files:**
- Modify: `src/components/shell/AdminNavTile.tsx`
- Modify: `src/routes/admin/dashboard.tsx`

- [ ] **Step 1: Add the route to `AdminRoute`**

In `src/components/shell/AdminNavTile.tsx`, change:

```typescript
export type AdminRoute =
  | '/admin/users'
  | '/admin/orders'
  | '/admin/bonuses'
  | '/admin/posts'
  | '/admin/guides'
```

to:

```typescript
export type AdminRoute =
  | '/admin/users'
  | '/admin/orders'
  | '/admin/bonuses'
  | '/admin/posts'
  | '/admin/guides'
  | '/admin/job-posts/new'
```

- [ ] **Step 2: Add a dashboard tile**

In `src/routes/admin/dashboard.tsx`, add `Briefcase` to the `lucide-react` import:

```typescript
import { BookOpen, Briefcase, FileText, Gift, Image, Users } from 'lucide-react'
```

And add a tile after the existing `/admin/guides` tile (inside the nav grid `<div>`):

```tsx
<AdminNavTile
  to="/admin/job-posts/new"
  icon={Briefcase}
  label="Đăng đơn hàng"
  hint="Đăng đơn hàng Nam/Nữ lên website"
  tint="sky"
/>
```

- [ ] **Step 3: Typecheck**

Run: `cd /home/ducmai/work/xkld-tools-client && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /home/ducmai/work/xkld-tools-client
git add src/components/shell/AdminNavTile.tsx src/routes/admin/dashboard.tsx
git commit -m "feat: surface job post tool on the admin dashboard"
```

---

## Task 8: Manual verification

No automated test can drive an actual browser Canvas or hit the real WordPress site, and this
is exactly the kind of change (image compositing look, live WP write) the design's own Testing
section calls for verifying by hand. Do this against the **local dev servers first**, then
once against the **real site** to confirm the `wc/v3/products` call actually succeeds with the
deployed `WP_MEDIA_USER` credentials (this is also what proves or disproves the
`manage_woocommerce` capability question noted at the top of this plan).

- [ ] **Step 1: Start both dev servers**

```bash
cd /home/ducmai/work/xkld-tools && pnpm dev &      # http://localhost:8787
cd /home/ducmai/work/xkld-tools-client && pnpm dev &  # prints its own local URL
```

- [ ] **Step 2: Walk the flow in the browser**

1. Log in as the seeded super admin, open the dashboard, click the new "Đăng đơn hàng" tile.
2. Upload 3 real sample images — the ones in
   `docs/🍀 CHỌN ĐƠN ĐI NHẬT 🍀 [04-08-2026 20_31].zip` are a good real-world test set (one
   landscape ~600×400, one portrait ~826×1248, one text-card image).
3. Confirm the composite preview appears automatically once all 3 are picked, and visually
   matches the approved layout: content image full-width and uncropped on top, portrait +
   landscape split evenly underneath.
4. Pick a category, click "Đăng". Confirm no error and that the response's `permalink` is a
   real-looking WooCommerce product URL.

- [ ] **Step 3: Verify on WordPress**

Open the returned `permalink` in a browser. Confirm:
- The product is published and in the correct category (Đơn nam / Đơn nữ).
- The featured/listing image is the composite.
- Opening the product detail page's image gallery cycles through the 3 original images (not
  the composite) — this is WooCommerce's default gallery lightbox, unmodified.

- [ ] **Step 4: Stop the dev servers**

```bash
kill %1 %2
```
