import { Hono } from 'hono'
import { arktypeValidator } from '@hono/arktype-validator'
import { type } from 'arktype'
import {
  ConflictError,
  TEMPORARY_PASSWORD,
  TEMPORARY_PASSWORD_TTL_MINUTES,
  createUser,
  findById,
  listUsers,
  resetPasswordByAdmin,
  toAuthUser,
} from '../lib/users'
import { requireSuperAdmin } from '../middleware/auth'
import { approveOrder, listOrders, rejectOrder, requestRevision, toOrder } from '../lib/orders'
import { redeem } from '../lib/redemptions'
import { grantGBonus } from '../lib/adminBonus'
import { getBalances, hasCustomerReward, listLedger, toAdminLedgerEntry } from '../lib/ledger'
import { createPost, deletePost, listPosts, toPost, updatePost } from '../lib/posts'
import { uploadImageToWp, WpUploadError } from '../lib/wpMedia'
import { parsePage } from '../lib/pagination'
import { phone, fullName } from '../lib/validators'
import type { LedgerType, OrderStatus, Wallet } from '../domain/points/types'
import type { AppEnv } from '../types'

const ORDER_STATUSES: readonly OrderStatus[] = ['DRAFT', 'PENDING', 'NEEDS_REVISION', 'APPROVED', 'REJECTED']

const requestRevisionSchema = type({ reason: '1 <= string <= 500' }).onUndeclaredKey('reject')
const LEDGER_TYPES: readonly LedgerType[] = [
  'REGISTRATION_BONUS', 'REFERRAL_SIGNUP_BONUS', 'MAINTENANCE_ACCRUAL', 'MAINTENANCE_RESET',
  'CUSTOMER_REWARD', 'CUSTOMER_REFERRAL_BONUS', 'ADMIN_BONUS', 'REDEMPTION',
]

const createRootUserSchema = type({
  fullName,
  phone,
  password: 'string >= 8',
})

// At least one wallet amount; extra keys rejected (tech-spec §10). Amounts are positive integers.
const redemptionSchema = type({
  userId: 'string >= 1',
  'f?': 'number.integer > 0',
  'g?': 'number.integer > 0',
  'note?': 'string <= 500',
  idempotencyKey: 'string >= 1',
})
  .onUndeclaredKey('reject')
  .narrow((d, ctx) => (d.f !== undefined || d.g !== undefined ? true : ctx.mustBe('at least one of f or g')))

const gBonusSchema = type({
  points: 'number.integer > 0',
  reason: '1 <= string <= 500',
  idempotencyKey: '1 <= string <= 200',
}).onUndeclaredKey('reject')

export const adminRoutes = new Hono<AppEnv>()

// Everything under /api/admin requires the super admin.
adminRoutes.use('*', requireSuperAdmin)

// Create a referrer-less "root" USER to seed the referral network (PRD FR1). Normal /register
// requires a referrer, so the very first users can only come from here.
adminRoutes.post('/users', arktypeValidator('json', createRootUserSchema), async (c) => {
  const { fullName, phone, password } = c.req.valid('json')
  try {
    const user = await createUser(c.env.DB, { fullName, phone, password, role: 'USER', referrerId: null })
    return c.json({ user }, 201)
  } catch (err) {
    if (err instanceof ConflictError && err.field === 'phone') {
      return c.json({ error: 'phone already registered' }, 409)
    }
    throw err
  }
})

// Browse/search all users (SUPER_ADMIN + USER rows). `q` matches a full_name/phone substring.
adminRoutes.get('/users', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listUsers(c.env.DB, { q: c.req.query('q'), page, limit })
  return c.json({ users: rows.map(toAuthUser), page, limit, total })
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

// --- Orders (PRD FR2/FR3/FR4) ---

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

adminRoutes.post('/orders/:id/approve', async (c) => {
  const admin = c.get('user')!
  const result = await approveOrder(c.env.DB, c.req.param('id'), admin.id, new Date().toISOString())
  if (result.ok) return c.json({ order: result.order })
  if (result.error === 'NOT_FOUND') return c.json({ error: 'not found' }, 404)
  if (result.error === 'ALREADY_DECIDED') {
    return c.json({ error: 'order already decided', code: 'ALREADY_DECIDED', status: result.status }, 409)
  }
  return c.json({ error: 'order is not PENDING', code: 'NOT_PENDING', status: result.status }, 409)
})

adminRoutes.post('/orders/:id/reject', async (c) => {
  const admin = c.get('user')!
  const result = await rejectOrder(c.env.DB, c.req.param('id'), admin.id, new Date().toISOString())
  if (result.ok) return c.json({ order: result.order })
  if (result.error === 'NOT_FOUND') return c.json({ error: 'not found' }, 404)
  if (result.error === 'ALREADY_DECIDED') {
    return c.json({ error: 'order already decided', code: 'ALREADY_DECIDED', status: result.status }, 409)
  }
  return c.json({ error: 'order is not PENDING', code: 'NOT_PENDING', status: result.status }, 409)
})

// PENDING → NEEDS_REVISION; the CTV edits and resubmits (design's revision loop).
adminRoutes.post('/orders/:id/request-revision', arktypeValidator('json', requestRevisionSchema), async (c) => {
  const admin = c.get('user')!
  const { reason } = c.req.valid('json')
  const result = await requestRevision(c.env.DB, c.req.param('id'), admin.id, reason, new Date().toISOString())
  if (result.ok) return c.json({ order: result.order })
  if (result.error === 'NOT_FOUND') return c.json({ error: 'not found' }, 404)
  if (result.error === 'ALREADY_DECIDED') {
    return c.json({ error: 'order already decided', code: 'ALREADY_DECIDED', status: result.status }, 409)
  }
  return c.json({ error: 'order is not PENDING', code: 'NOT_PENDING', status: result.status }, 409)
})

// --- Redemption (PRD FR5) ---

adminRoutes.post('/redemptions', arktypeValidator('json', redemptionSchema), async (c) => {
  const admin = c.get('user')!
  const { userId, f, g, note, idempotencyKey } = c.req.valid('json')

  // Unknown user → 404 before touching the ledger.
  if (!(await findById(c.env.DB, userId))) return c.json({ error: 'user not found' }, 404)

  const result = await redeem(c.env.DB, {
    userId, f, g, note: note ?? null, idempotencyKey, adminId: admin.id, now: new Date().toISOString(),
  })
  if (result.ok) return c.json({ entries: result.entries, balances: result.balances }, 201)
  if (result.error === 'DUPLICATE') return c.json({ error: 'duplicate redemption', code: 'DUPLICATE_REDEMPTION' }, 409)
  if (result.error === 'LOCKED') return c.json({ error: 'redemption locked', code: 'REDEMPTION_LOCKED' }, 422)
  return c.json({ error: 'insufficient balance', code: 'INSUFFICIENT_BALANCE' }, 422)
})

// Manually credit a CTV's maintenance wallet. Because G is derived from the ledger, the existing
// three-month maintenance reset automatically applies to this credit.
adminRoutes.post('/users/:id/g-bonus', arktypeValidator('json', gBonusSchema), async (c) => {
  const admin = c.get('user')!
  const user = await findById(c.env.DB, c.req.param('id'))
  if (!user) return c.json({ error: 'user not found' }, 404)
  if (user.role === 'SUPER_ADMIN') {
    return c.json({ error: 'cannot grant points to super admin', code: 'SUPER_ADMIN_BONUS_FORBIDDEN' }, 403)
  }

  const { points, reason, idempotencyKey } = c.req.valid('json')
  const trimmedReason = reason.trim()
  if (!trimmedReason) return c.json({ error: 'reason is required' }, 400)

  const result = await grantGBonus(c.env.DB, {
    userId: user.id,
    points,
    reason: trimmedReason,
    idempotencyKey,
    adminId: admin.id,
    now: new Date().toISOString(),
  })
  if (!result.ok) {
    return c.json({ error: 'duplicate bonus', code: 'DUPLICATE_ADMIN_BONUS' }, 409)
  }
  return c.json({
    entry: result.entry,
    balances: { before: result.before, after: result.after },
  }, 201)
})

// --- Balances & ledger (PRD FR6/FR7) ---

adminRoutes.get('/users/:id/balances', async (c) => {
  const id = c.req.param('id')
  if (!(await findById(c.env.DB, id))) return c.json({ error: 'user not found' }, 404)
  const [balances, unlocked] = await Promise.all([getBalances(c.env.DB, id), hasCustomerReward(c.env.DB, id)])
  return c.json({ ...balances, redemptionUnlocked: unlocked })
})

adminRoutes.get('/ledger', async (c) => {
  const wallet = c.req.query('wallet')
  const type = c.req.query('type')
  const direction = c.req.query('direction')
  if (wallet !== undefined && wallet !== 'F' && wallet !== 'G') return c.json({ error: 'invalid wallet' }, 400)
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

// --- Social-proof posts (the "đã có người đổi thưởng rồi" feed) ---

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8 MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_TITLE = 200
const MAX_DESCRIPTION = 1000

// Admin sees every post (published + hidden), newest first, for management.
adminRoutes.get('/posts', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listPosts(c.env.DB, { publishedOnly: false, page, limit })
  return c.json({ posts: rows.map(toPost), page, limit, total })
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

// Edit title/description and/or toggle visibility.
adminRoutes.patch('/posts/:id', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (body === null || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400)

  const patch: { title?: string; description?: string; published?: boolean } = {}
  const { title, description, published } = body as Record<string, unknown>

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > MAX_TITLE) {
      return c.json({ error: `title must be 1–${MAX_TITLE} chars` }, 400)
    }
    patch.title = title.trim()
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) {
      return c.json({ error: `description at most ${MAX_DESCRIPTION} chars` }, 400)
    }
    patch.description = description.trim()
  }
  if (published !== undefined) {
    if (typeof published !== 'boolean') return c.json({ error: 'published must be a boolean' }, 400)
    patch.published = published
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
