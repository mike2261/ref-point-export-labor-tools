// Public social-proof feed (PRD §6 social proof): the CTV app — and any marketing surface — reads
// the published posts here. No auth: this is curated, non-sensitive promotional content. Writes are
// admin-only and live under /api/admin/posts.
import { Hono } from 'hono'
import { listPosts, toPost } from '../lib/posts'
import { parsePage } from '../lib/pagination'
import type { AppEnv } from '../types'

export const postRoutes = new Hono<AppEnv>()

// GET /api/posts?page=&limit= — published posts, newest first.
postRoutes.get('/', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listPosts(c.env.DB, { publishedOnly: true, page, limit })
  return c.json({ posts: rows.map(toPost), page, limit, total })
})
