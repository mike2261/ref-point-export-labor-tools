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

// List existing job posts for one category, newest first — backs the admin's "which posts exist,
// which do I need to delete" view.
jobPostRoutes.get('/', async (c) => {
  const category = c.req.query('category') ?? 'don-nam'
  if (!isJobPostCategory(category)) {
    return c.json({ error: 'invalid category' }, 400)
  }
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))

  try {
    const { products, total } = await listWpProducts(c.env, { category, page, limit })
    return c.json({ jobPosts: products, page, limit, total })
  } catch (err) {
    if (err instanceof WpProductError) {
      return c.json({ error: 'product list fetch from WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
    }
    throw err
  }
})

jobPostRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400)

  try {
    const { deleted } = await deleteWpProduct(c.env, id)
    if (!deleted) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  } catch (err) {
    if (err instanceof WpProductError) {
      return c.json({ error: 'product delete on WordPress failed', code: 'WP_PRODUCT_FAILED' }, 502)
    }
    throw err
  }
})
