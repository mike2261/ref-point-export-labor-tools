import { Hono } from 'hono'
import { authMiddleware } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { adminRoutes } from './routes/admin'
import { orderRoutes } from './routes/orders'
import { pointsRoutes } from './routes/points'
import { scheduled } from './scheduled'
import type { AppEnv } from './types'

const app = new Hono<AppEnv>()

// Attach the current user (if any) to every request.
app.use('*', authMiddleware)

app.get('/', (c) => c.json({ ok: true, service: 'xkld-tools' }))

app.route('/api/auth', authRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/orders', orderRoutes)
app.route('/api/points', pointsRoutes)

// `app.fetch` works detached; SELF.fetch in the Workers test pool dispatches to this default
// export's fetch, so existing integration tests keep working (tech-spec §2.1).
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<CloudflareBindings>
