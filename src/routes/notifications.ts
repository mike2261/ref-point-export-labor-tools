// User-facing notification inbox (PRD §6.3). Self-scoped: the recipient is always the session user,
// never the client — admins read their ORDER_CREATED alerts here, CTVs read theirs, same endpoints.
import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import { parsePage } from '../lib/pagination'
import {
  listNotifications,
  markAllRead,
  markRead,
  toNotification,
  unreadCount,
} from '../lib/notifications'
import type { AppEnv } from '../types'

export const notificationRoutes = new Hono<AppEnv>()

notificationRoutes.use('*', requireAuth)

// GET /api/notifications?page=&limit=&unread=true — newest first, optionally unread-only.
notificationRoutes.get('/', async (c) => {
  const user = c.get('user')!
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listNotifications(c.env.DB, {
    userId: user.id,
    unreadOnly: c.req.query('unread') === 'true',
    page,
    limit,
  })
  return c.json({ notifications: rows.map(toNotification), page, limit, total })
})

// GET /api/notifications/unread-count — cheap badge count.
notificationRoutes.get('/unread-count', async (c) => {
  const user = c.get('user')!
  return c.json({ count: await unreadCount(c.env.DB, user.id) })
})

// POST /api/notifications/read-all — flip every unread notification of the caller.
notificationRoutes.post('/read-all', async (c) => {
  const user = c.get('user')!
  const updated = await markAllRead(c.env.DB, user.id, new Date().toISOString())
  return c.json({ updated })
})

// POST /api/notifications/:id/read — mark one read; 404 when it isn't the caller's (no leak).
notificationRoutes.post('/:id/read', async (c) => {
  const user = c.get('user')!
  const ok = await markRead(c.env.DB, user.id, c.req.param('id'), new Date().toISOString())
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})
