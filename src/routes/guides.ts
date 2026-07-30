// Public CTV guide feed ("Hướng dẫn CTV"): the CTV app reads the published guides here. No auth —
// curated, non-sensitive content. Writes are admin-only and live under /api/admin/guides.
import { Hono } from 'hono'
import { listGuides, toGuide } from '../lib/guides'
import { parsePage } from '../lib/pagination'
import type { AppEnv } from '../types'

export const guideRoutes = new Hono<AppEnv>()

// GET /api/guides?page=&limit= — published guides, newest first.
guideRoutes.get('/', async (c) => {
  const { page, limit } = parsePage(c.req.query('page'), c.req.query('limit'))
  const { rows, total } = await listGuides(c.env.DB, { publishedOnly: true, page, limit })
  return c.json({ guides: rows.map(toGuide), page, limit, total })
})
