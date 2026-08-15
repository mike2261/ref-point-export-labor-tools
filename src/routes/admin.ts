import { Hono } from 'hono'
import { arktypeValidator } from '@hono/arktype-validator'
import { type } from 'arktype'
import {
  ConflictError,
  TEMPORARY_PASSWORD,
  TEMPORARY_PASSWORD_TTL_MINUTES,
  createUser,
  findById,
  listReferredUsers,
  listUsers,
  resetPasswordByAdmin,
  toAuthUser,
  toAuthUserWithBalances,
  toReferredUser,
  type UserSort,
} from '../lib/users'
import { requireSuperAdmin } from '../middleware/auth'
import { activateCustomer, listOrders, toOrder } from '../lib/orders'
import { redeem } from '../lib/redemptions'
import { grantBonus, listBonusGrants, countCtvUsers, toBonusGrant } from '../lib/bonuses'
import { getBalances, hasCustomerReward, listLedger, toAdminLedgerEntry } from '../lib/ledger'
import { createPost, deletePost, findPostById, listPosts, toPost, updatePost } from '../lib/posts'
import { createGuide, deleteGuide, findGuideById, listGuides, toGuide, updateGuide } from '../lib/guides'
import { uploadImageToWp, WpUploadError } from '../lib/wpMedia'
import { parsePage } from '../lib/pagination'
import { phone, fullName, customerPhone } from '../lib/validators'
import type { LedgerType, OrderStatus, Wallet } from '../domain/points/types'
import type { AppEnv } from '../types'

const ORDER_STATUSES: readonly OrderStatus[] = ['DRAFT', 'PENDING', 'NEEDS_REVISION', 'APPROVED', 'REJECTED']

const LEDGER_TYPES: readonly LedgerType[] = [
  'REGISTRATION_BONUS', 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET', 'ADMIN_BONUS',
  'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'REDEMPTION',
]

const USER_SORTS: readonly UserSort[] = ['a_asc', 'a_desc', 'b_asc', 'b_desc', 'c_asc', 'c_desc']

const createRootUserSchema = type({
  fullName,
  phone,
})

const activateCustomerSchema = type({
  userId: 'string >= 1',
  fullName,
  phone: customerPhone,
  orderCode: '1 <= string <= 100',
  idempotencyKey: 'string >= 1',
}).onUndeclaredKey('reject')

const grantBonusSchema = type({
  scope: 'string',
  'phone?': 'string',
  amount: '1 <= number.integer <= 100000',
  content: '1 <= string <= 500',
  idempotencyKey: 'string >= 1',
}).onUndeclaredKey('reject')

// At least one wallet amount; extra keys rejected. Amounts are positive integers.
const redemptionSchema = type({
  userId: 'string >= 1',
  'a?': 'number.integer > 0',
  'b?': 'number.integer > 0',
  'c?': 'number.integer > 0',
  'note?': 'string <= 500',
  idempotencyKey: 'string >= 1',
})
  .onUndeclaredKey('reject')
  .narrow((d, ctx) => (d.a !== undefined || d.b !== undefined || d.c !== undefined ? true : ctx.mustBe('at least one of a, b, or c')))

export const adminRoutes = new Hono<AppEnv>()

// Everything under /api/admin requires the super admin.
adminRoutes.use('*', requireSuperAdmin)

// Create a referrer-less "root" USER to seed the referral network (PRD FR1). Normal /register
// requires a referrer, so the very first users can only come from here. The admin never types a
// password — every account starts on the same business-approved temporary password used for
// resets (TEMPORARY_PASSWORD), which the CTV is expected to be told out of band.
adminRoutes.post('/users', arktypeValidator('json', createRootUserSchema), async (c) => {
  const { fullName, phone } = c.req.valid('json')
  try {
    const user = await createUser(c.env.DB, { fullName, phone, password: TEMPORARY_PASSWORD, role: 'USER', referrerId: null })
    return c.json({ user }, 201)
  } catch (err) {
    if (err instanceof ConflictError && err.field === 'phone') {
      return c.json({ error: 'phone already registered' }, 409)
    }
    throw err
  }
})

// Browse/search all users (SUPER_ADMIN + USER rows). `q` matches a full_name/phone substring.
// Each row carries its live F/G balance; `sort` orders by one of them (default: newest first).
adminRoutes.get('/users', async (c) => {
  const sort = c.req.query('sort')
  if (sort !== undefined && !USER_SORTS.includes(sort as UserSort)) {
    return c.json({ error: 'invalid sort' }, 400)
  }
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listUsers(c.env.DB, { q: c.req.query('q'), page, limit, sort: sort as UserSort | undefined })
  return c.json({ users: rows.map(toAuthUserWithBalances), page, limit, total })
})

// Single user lookup — backs the admin user-detail page's header (name/phone/role/status).
adminRoutes.get('/users/:id', async (c) => {
  const row = await findById(c.env.DB, c.req.param('id'))
  if (!row) return c.json({ error: 'user not found' }, 404)
  return c.json({ user: toAuthUser(row) })
})

// The admin performs identity checking in a personal Zalo chat before calling this endpoint.
adminRoutes.post('/users/:id/reset-password', async (c) => {
  const admin = c.get('user')!
  const result = await resetPasswordByAdmin(c.env.DB, c.req.param('id'), admin.id, new Date())
  if (!result.ok) {
    if (result.error === 'NOT_FOUND') return c.json({ error: 'user not found' }, 404)
    return c.json({ error: 'super admin password cannot be reset here', code: 'SUPER_ADMIN_RESET_FORBIDDEN' }, 403)
  }
  return c.json({
    temporaryPassword: TEMPORARY_PASSWORD,
    expiresAt: result.expiresAt,
    expiresInMinutes: TEMPORARY_PASSWORD_TTL_MINUTES,
    requiresPasswordChange: true,
  })
})

// --- Customers (activated orders) ---

// Every row here is an APPROVED order — there is no approval queue any more (see lib/orders.ts).
// `status` stays a supported filter so an existing/legacy row can still be found, but the admin UI
// no longer sends it.
adminRoutes.get('/orders', async (c) => {
  const status = c.req.query('status')
  if (status !== undefined && !ORDER_STATUSES.includes(status as OrderStatus)) {
    return c.json({ error: 'invalid status' }, 400)
  }
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listOrders(c.env.DB, {
    userId: c.req.query('userId'),
    status: status as OrderStatus | undefined,
    q: c.req.query('q'),
    page,
    limit,
  })
  return c.json({ orders: rows.map(toOrder), page, limit, total })
})

// --- Redemption ---

// Manual "Đổi điểm" — reintroduced (was removed when activation started auto-settling B/C on
// every activation; see git history) because wallet A never auto-drains and otherwise has no
// payout path at all. Any of A/B/C may be redeemed in one call; B/C still require the CTV to
// have had a customer reward of their own (validateRedemption), A never does.
adminRoutes.post('/redemptions', arktypeValidator('json', redemptionSchema), async (c) => {
  const admin = c.get('user')!
  const { userId, a, b, c: cAmount, note, idempotencyKey } = c.req.valid('json')

  // Unknown user → 404 before touching the ledger.
  if (!(await findById(c.env.DB, userId))) return c.json({ error: 'user not found' }, 404)

  const result = await redeem(c.env.DB, {
    userId, a, b, c: cAmount, note: note ?? null, idempotencyKey, adminId: admin.id, now: new Date().toISOString(),
  })
  if (result.ok) return c.json({ entries: result.entries, balances: result.balances }, 201)
  if (result.error === 'DUPLICATE') return c.json({ error: 'duplicate redemption', code: 'DUPLICATE_REDEMPTION' }, 409)
  if (result.error === 'LOCKED') return c.json({ error: 'redemption locked', code: 'REDEMPTION_LOCKED' }, 422)
  return c.json({ error: 'insufficient balance', code: 'INSUFFICIENT_BALANCE' }, 422)
})

// Admin creates an already-approved order for a customer who already paid the CTV in cash. Chỉ
// CỘNG tiền cho CTV — trả tiền là việc riêng, admin dùng chức năng rút tiền thủ công bên dưới
// (POST /redemptions). Xem activateCustomer() để biết cả lô ghi những gì.
adminRoutes.post('/orders/activate', arktypeValidator('json', activateCustomerSchema), async (c) => {
  const admin = c.get('user')!
  const { userId, fullName, phone, orderCode, idempotencyKey } = c.req.valid('json')
  const result = await activateCustomer(c.env.DB, { userId, fullName, phone, orderCode, idempotencyKey, adminId: admin.id, now: new Date().toISOString() })
  if (result.ok) return c.json({ order: result.order, credited: result.credited }, 201)
  if (result.error === 'NOT_FOUND') return c.json({ error: 'user not found' }, 404)
  return c.json({ error: 'duplicate activation', code: 'DUPLICATE' }, 409)
})

// --- Balances & ledger (PRD FR6/FR7) ---

adminRoutes.get('/users/:id/balances', async (c) => {
  const id = c.req.param('id')
  if (!(await findById(c.env.DB, id))) return c.json({ error: 'user not found' }, 404)
  const [balances, unlocked] = await Promise.all([getBalances(c.env.DB, id), hasCustomerReward(c.env.DB, id)])
  return c.json({ ...balances, redemptionUnlocked: unlocked })
})

adminRoutes.get('/users/:id/referred-ctvs', async (c) => {
  const id = c.req.param('id')
  if (!(await findById(c.env.DB, id))) return c.json({ error: 'user not found' }, 404)
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listReferredUsers(c.env.DB, id, { page, limit })
  return c.json({ users: rows.map(toReferredUser), page, limit, total })
})

adminRoutes.get('/ledger', async (c) => {
  const wallet = c.req.query('wallet')
  const type = c.req.query('type')
  const direction = c.req.query('direction')
  if (wallet !== undefined && wallet !== 'A' && wallet !== 'B' && wallet !== 'C') return c.json({ error: 'invalid wallet' }, 400)
  if (type !== undefined && !LEDGER_TYPES.includes(type as LedgerType)) return c.json({ error: 'invalid type' }, 400)
  if (direction !== undefined && direction !== 'credit' && direction !== 'debit') {
    return c.json({ error: 'invalid direction' }, 400)
  }

  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listLedger(c.env.DB, {
    userId: c.req.query('userId'),
    wallet: wallet as Wallet | undefined,
    type: type as LedgerType | undefined,
    direction: direction as 'credit' | 'debit' | undefined,
    from: c.req.query('from'),
    to: c.req.query('to'),
    q: c.req.query('q'),
    page,
    limit,
  })
  return c.json({ entries: rows.map(toAdminLedgerEntry), page, limit, total })
})

// --- Admin-triggered point bonuses (replaces the old monthly maintenance cron) ---

adminRoutes.post('/bonuses', arktypeValidator('json', grantBonusSchema), async (c) => {
  const admin = c.get('user')!
  const { scope, phone, amount, content, idempotencyKey } = c.req.valid('json')
  if (scope !== 'ALL' && scope !== 'PHONE') return c.json({ error: 'invalid scope' }, 400)
  if (scope === 'PHONE' && !phone) return c.json({ error: 'phone required for scope PHONE' }, 400)
  const result = await grantBonus(c.env.DB, {
    scope, phone, amount, content, idempotencyKey, adminId: admin.id, now: new Date().toISOString(),
  })
  if (result.ok) return c.json({ grant: result.grant }, 201)
  if (result.error === 'PHONE_NOT_FOUND') return c.json({ error: 'phone not found' }, 404)
  return c.json({ error: 'duplicate grant', code: 'DUPLICATE' }, 409)
})

adminRoutes.get('/bonuses', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listBonusGrants(c.env.DB, { page, limit })
  return c.json({ grants: rows.map(toBonusGrant), page, limit, total })
})

adminRoutes.get('/bonuses/preview', async (c) => {
  if (c.req.query('scope') !== 'ALL') return c.json({ error: 'invalid scope' }, 400)
  return c.json({ recipientCount: await countCtvUsers(c.env.DB) })
})

// --- Social-proof posts (the "đã có người đổi thưởng rồi" feed) ---

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8 MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_TITLE = 200
const MAX_DESCRIPTION = 1000

// Admin sees every post, newest first, for management.
adminRoutes.get('/posts', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listPosts(c.env.DB, { publishedOnly: false, page, limit })
  return c.json({ posts: rows.map(toPost), page, limit, total })
})

// Single post lookup, for the admin edit page.
adminRoutes.get('/posts/:id', async (c) => {
  const post = await findPostById(c.env.DB, c.req.param('id'))
  if (!post) return c.json({ error: 'not found' }, 404)
  return c.json({ post })
})

// Create a post: multipart form (image file + title + description). The image is proxied up to
// WordPress here so the Application Password never leaves the Worker; only the WP URL is stored.
adminRoutes.post('/posts', async (c) => {
  const admin = c.get('user')!
  const body = await c.req.parseBody()

  const image = body['image']
  const title = typeof body['title'] === 'string' ? body['title'].trim() : ''
  const description = typeof body['description'] === 'string' ? body['description'].trim() : ''

  if (!(image instanceof File)) return c.json({ error: 'image file is required' }, 400)
  if (title.length === 0) return c.json({ error: 'title is required' }, 400)
  if (title.length > MAX_TITLE) return c.json({ error: `title at most ${MAX_TITLE} chars` }, 400)
  if (description.length > MAX_DESCRIPTION) {
    return c.json({ error: `description at most ${MAX_DESCRIPTION} chars` }, 400)
  }
  if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
    return c.json({ error: 'image must be jpeg, png or webp' }, 400)
  }

  const buf = await image.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'image is empty' }, 400)
  if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'image too large (max 8MB)' }, 413)

  let upload
  try {
    upload = await uploadImageToWp(c.env, buf, image.name || 'upload.jpg', image.type)
  } catch (err) {
    if (err instanceof WpUploadError) {
      return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
    }
    throw err
  }

  const post = await createPost(c.env.DB, {
    title,
    description,
    imageUrl: upload.sourceUrl,
    wpMediaId: upload.id,
    published: true,
    createdBy: admin.id,
    now: new Date().toISOString(),
  })
  return c.json({ post }, 201)
})

// Edit title/description and/or replace the image. Multipart (not JSON) so the image field can
// carry an optional new file — same upload-then-store-the-URL flow as create, just conditional.
adminRoutes.patch('/posts/:id', async (c) => {
  const body = await c.req.parseBody()
  const patch: { title?: string; description?: string; imageUrl?: string; wpMediaId?: number | null } = {}

  if (body['title'] !== undefined) {
    const title = typeof body['title'] === 'string' ? body['title'].trim() : ''
    if (title.length === 0 || title.length > MAX_TITLE) {
      return c.json({ error: `title must be 1–${MAX_TITLE} chars` }, 400)
    }
    patch.title = title
  }
  if (body['description'] !== undefined) {
    const description = typeof body['description'] === 'string' ? body['description'].trim() : ''
    if (description.length > MAX_DESCRIPTION) {
      return c.json({ error: `description at most ${MAX_DESCRIPTION} chars` }, 400)
    }
    patch.description = description
  }
  if (body['image'] !== undefined) {
    const image = body['image']
    if (!(image instanceof File)) return c.json({ error: 'image must be a file' }, 400)
    if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
      return c.json({ error: 'image must be jpeg, png or webp' }, 400)
    }
    const buf = await image.arrayBuffer()
    if (buf.byteLength === 0) return c.json({ error: 'image is empty' }, 400)
    if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'image too large (max 8MB)' }, 413)

    let upload
    try {
      upload = await uploadImageToWp(c.env, buf, image.name || 'upload.jpg', image.type)
    } catch (err) {
      if (err instanceof WpUploadError) {
        return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
      }
      throw err
    }
    patch.imageUrl = upload.sourceUrl
    patch.wpMediaId = upload.id
  }

  const post = await updatePost(c.env.DB, c.req.param('id'), patch)
  if (!post) return c.json({ error: 'not found' }, 404)
  return c.json({ post })
})

adminRoutes.delete('/posts/:id', async (c) => {
  const ok = await deletePost(c.env.DB, c.req.param('id'))
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// --- CTV guides ("Hướng dẫn CTV") — same shape and rules as posts, above ---

// Admin sees every guide, newest first, for management.
adminRoutes.get('/guides', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listGuides(c.env.DB, { publishedOnly: false, page, limit })
  return c.json({ guides: rows.map(toGuide), page, limit, total })
})

// Single guide lookup, for the admin edit page.
adminRoutes.get('/guides/:id', async (c) => {
  const guide = await findGuideById(c.env.DB, c.req.param('id'))
  if (!guide) return c.json({ error: 'not found' }, 404)
  return c.json({ guide })
})

// Create a guide: multipart form (image file + title + description). The image is proxied up to
// WordPress here so the Application Password never leaves the Worker; only the WP URL is stored.
adminRoutes.post('/guides', async (c) => {
  const admin = c.get('user')!
  const body = await c.req.parseBody()

  const image = body['image']
  const title = typeof body['title'] === 'string' ? body['title'].trim() : ''
  const description = typeof body['description'] === 'string' ? body['description'].trim() : ''

  if (!(image instanceof File)) return c.json({ error: 'image file is required' }, 400)
  if (title.length === 0) return c.json({ error: 'title is required' }, 400)
  if (title.length > MAX_TITLE) return c.json({ error: `title at most ${MAX_TITLE} chars` }, 400)
  if (description.length > MAX_DESCRIPTION) {
    return c.json({ error: `description at most ${MAX_DESCRIPTION} chars` }, 400)
  }
  if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
    return c.json({ error: 'image must be jpeg, png or webp' }, 400)
  }

  const buf = await image.arrayBuffer()
  if (buf.byteLength === 0) return c.json({ error: 'image is empty' }, 400)
  if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'image too large (max 8MB)' }, 413)

  let upload
  try {
    upload = await uploadImageToWp(c.env, buf, image.name || 'upload.jpg', image.type)
  } catch (err) {
    if (err instanceof WpUploadError) {
      return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
    }
    throw err
  }

  const guide = await createGuide(c.env.DB, {
    title,
    description,
    imageUrl: upload.sourceUrl,
    wpMediaId: upload.id,
    published: true,
    createdBy: admin.id,
    now: new Date().toISOString(),
  })
  return c.json({ guide }, 201)
})

// Edit title/description and/or replace the image. Multipart (not JSON) so the image field can
// carry an optional new file — same upload-then-store-the-URL flow as create, just conditional.
adminRoutes.patch('/guides/:id', async (c) => {
  const body = await c.req.parseBody()
  const patch: { title?: string; description?: string; imageUrl?: string; wpMediaId?: number | null } = {}

  if (body['title'] !== undefined) {
    const title = typeof body['title'] === 'string' ? body['title'].trim() : ''
    if (title.length === 0 || title.length > MAX_TITLE) {
      return c.json({ error: `title must be 1–${MAX_TITLE} chars` }, 400)
    }
    patch.title = title
  }
  if (body['description'] !== undefined) {
    const description = typeof body['description'] === 'string' ? body['description'].trim() : ''
    if (description.length > MAX_DESCRIPTION) {
      return c.json({ error: `description at most ${MAX_DESCRIPTION} chars` }, 400)
    }
    patch.description = description
  }
  if (body['image'] !== undefined) {
    const image = body['image']
    if (!(image instanceof File)) return c.json({ error: 'image must be a file' }, 400)
    if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
      return c.json({ error: 'image must be jpeg, png or webp' }, 400)
    }
    const buf = await image.arrayBuffer()
    if (buf.byteLength === 0) return c.json({ error: 'image is empty' }, 400)
    if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'image too large (max 8MB)' }, 413)

    let upload
    try {
      upload = await uploadImageToWp(c.env, buf, image.name || 'upload.jpg', image.type)
    } catch (err) {
      if (err instanceof WpUploadError) {
        return c.json({ error: 'image upload to WordPress failed', code: 'WP_UPLOAD_FAILED' }, 502)
      }
      throw err
    }
    patch.imageUrl = upload.sourceUrl
    patch.wpMediaId = upload.id
  }

  const guide = await updateGuide(c.env.DB, c.req.param('id'), patch)
  if (!guide) return c.json({ error: 'not found' }, 404)
  return c.json({ guide })
})

adminRoutes.delete('/guides/:id', async (c) => {
  const ok = await deleteGuide(c.env.DB, c.req.param('id'))
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})
