import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authMiddleware, enforcePasswordChange } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { adminRoutes } from './routes/admin'
import { pointsRoutes } from './routes/points'
import { notificationRoutes } from './routes/notifications'
import { postRoutes } from './routes/posts'
import { guideRoutes } from './routes/guides'
import { jobPostRoutes } from './routes/jobPosts'
import type { AppEnv } from './types'

const app = new Hono<AppEnv>()

// Bearer-token auth carries no cookie, so there's no CSRF/credentialed-CORS concern — wide open
// for now (docs/superpowers/specs/2026-07-17-bearer-auth-design.md). Tighten to the real client
// origin once one exists.
app.use('*', cors({ origin: '*' }))

// Attach the current user (if any) to every request.
app.use('*', authMiddleware)
app.use('*', enforcePasswordChange)

app.get('/', (c) => c.json({ ok: true, service: 'xkld-tools' }))

app.route('/api/auth', authRoutes)
app.route('/api/admin', adminRoutes)
// No /api/orders router: CTVs no longer create or submit orders at all. An order row is only
// ever born already-APPROVED, via the admin's POST /api/admin/orders/activate.
app.route('/api/points', pointsRoutes)
app.route('/api/notifications', notificationRoutes)
app.route('/api/posts', postRoutes)
app.route('/api/guides', guideRoutes)
app.route('/api/admin/job-posts', jobPostRoutes)

// `app.fetch` works detached; SELF.fetch in the Workers test pool dispatches to this default
// export's fetch, so existing integration tests keep working (tech-spec §2.1).
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<CloudflareBindings>
