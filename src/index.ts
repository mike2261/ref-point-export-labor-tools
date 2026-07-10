import { Hono } from 'hono'
import { authMiddleware } from './middleware/auth'
import { authRoutes } from './routes/auth'
import { adminRoutes } from './routes/admin'
import type { AppEnv } from './types'

const app = new Hono<AppEnv>()

// Attach the current user (if any) to every request.
app.use('*', authMiddleware)

app.get('/', (c) => c.json({ ok: true, service: 'xkld-tools' }))

app.route('/api/auth', authRoutes)
app.route('/api/admin', adminRoutes)

export default app
