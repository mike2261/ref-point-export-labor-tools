// User-facing order routes (PRD FR9/FR10, extended per docs/superpowers/specs/2026-07-25-order-
// lifecycle-design.md). Behind requireAuth; SUPER_ADMIN cannot create orders.
import { Hono } from 'hono'
import { arktypeValidator } from '@hono/arktype-validator'
import { type } from 'arktype'
import { requireAuth } from '../middleware/auth'
import { createDraftOrder, findOrderByIdForUser, listOrders, submitOrder, toOrder, updateOrder } from '../lib/orders'
import { parsePage } from '../lib/pagination'
import { phone, fullName } from '../lib/validators'
import type { OrderStatus } from '../domain/points/types'
import type { AppEnv } from '../types'

const ORDER_STATUSES: readonly OrderStatus[] = ['DRAFT', 'PENDING', 'NEEDS_REVISION', 'APPROVED', 'REJECTED']

// fullName/phone are the person going abroad, not the CTV's own account. orderCode/
// activationCode are free text typed by the CTV — no format/uniqueness check here; the admin
// verifies them manually before approving. Extra keys hard-fail 400 (tech-spec §10).
const createOrderSchema = type({
  fullName,
  phone,
  orderCode: '1 <= string <= 100',
  activationCode: '1 <= string <= 100',
  'note?': 'string <= 500',
}).onUndeclaredKey('reject')

const updateOrderSchema = type({
  'fullName?': fullName,
  'phone?': phone,
  'orderCode?': '1 <= string <= 100',
  'activationCode?': '1 <= string <= 100',
  'note?': 'string <= 500',
}).onUndeclaredKey('reject')

export const orderRoutes = new Hono<AppEnv>()

orderRoutes.use('*', requireAuth)

orderRoutes.post('/', arktypeValidator('json', createOrderSchema), async (c) => {
  const user = c.get('user')!
  if (user.role === 'SUPER_ADMIN') return c.json({ error: 'admins cannot create orders' }, 403)

  const { fullName, phone, orderCode, activationCode, note } = c.req.valid('json')
  const now = new Date().toISOString()
  const order = await createDraftOrder(c.env.DB, user.id, { fullName, phone, orderCode, activationCode, note: note ?? null }, now)
  return c.json({ order }, 201)
})

orderRoutes.patch('/:id', arktypeValidator('json', updateOrderSchema), async (c) => {
  const user = c.get('user')!
  const { fullName, phone, orderCode, activationCode, note } = c.req.valid('json')
  const now = new Date().toISOString()
  const result = await updateOrder(c.env.DB, c.req.param('id'), user.id, { fullName, phone, orderCode, activationCode, note }, now)
  if (result.ok) return c.json({ order: result.order })
  if (result.error === 'NOT_FOUND') return c.json({ error: 'not found' }, 404)
  return c.json({ error: 'order is locked (not DRAFT or NEEDS_REVISION)', code: 'LOCKED' }, 422)
})

orderRoutes.post('/:id/submit', async (c) => {
  const user = c.get('user')!
  const now = new Date().toISOString()
  const result = await submitOrder(c.env.DB, c.req.param('id'), user.id, now)
  if (result.ok) return c.json({ order: result.order })
  if (result.error === 'NOT_FOUND') return c.json({ error: 'not found' }, 404)
  if (result.error === 'PENDING_LIMIT') return c.json({ error: 'too many pending orders', code: 'PENDING_LIMIT' }, 409)
  return c.json({ error: 'order is not DRAFT or NEEDS_REVISION', code: 'NOT_EDITABLE', status: result.status }, 409)
})

orderRoutes.get('/', async (c) => {
  const user = c.get('user')!
  const status = c.req.query('status')
  if (status !== undefined && !ORDER_STATUSES.includes(status as OrderStatus)) {
    return c.json({ error: 'invalid status' }, 400)
  }

  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listOrders(c.env.DB, {
    userId: user.id, // self-scoped
    status: status as OrderStatus | undefined,
    page,
    limit,
  })
  return c.json({ orders: rows.map(toOrder), page, limit, total })
})

orderRoutes.get('/:id', async (c) => {
  const user = c.get('user')!
  // A foreign order id returns 404, not 403 — no existence leak (tech-spec §10).
  const row = await findOrderByIdForUser(c.env.DB, c.req.param('id'), user.id)
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json({ order: toOrder(row) })
})
