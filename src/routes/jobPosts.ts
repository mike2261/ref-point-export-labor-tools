// Admin tool: upload 3 images (a pre-made content card + a portrait + a landscape photo) plus
// a client-composited square image made from them, and turn that into a WooCommerce product in
// one of the site's product_cat categories — see
// docs/superpowers/specs/2026-08-04-job-post-tool-design.md.
//
// Unlike posts/guides (routes/admin.ts), this has no D1 table: there's nothing to store or edit
// beyond what create writes into WordPress directly. List/delete below proxy straight through to
// the WooCommerce API rather than querying D1 — the product IS the record.
import { Hono } from 'hono'
import { requireSuperAdmin } from '../middleware/auth'
import { uploadImageToWp, WpUploadError } from '../lib/wpMedia'
import {
  createWpProduct,
  deleteWpProduct,
  isJobPostCategory,
  listWpProducts,
  WpProductError,
} from '../lib/wpProducts'
import { parsePage } from '../lib/pagination'
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
    return c.json({ error: 'invalid category' }, 400)
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
