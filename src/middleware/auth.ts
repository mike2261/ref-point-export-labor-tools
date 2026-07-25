import { createMiddleware } from 'hono/factory'
import { getBearerToken, verifySession } from '../lib/jwt'
import { findById, toAuthUser } from '../lib/users'
import type { AppEnv } from '../types'

// Runs on every request. Reads the Authorization header; if it verifies, re-loads the user from
// D1 (so role/active status are always current) and attaches it. Never rejects — anonymous is valid.
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const token = getBearerToken(c)
  if (token) {
    try {
      const { sub, ver } = await verifySession(token, c.env.JWT_SECRET)
      const row = await findById(c.env.DB, sub)
      if (row && row.is_active === 1 && row.password_version === ver) {
        c.set('user', toAuthUser(row))
      }
    } catch {
      // Expired or tampered token → degrade to anonymous, never 500.
    }
  }
  await next()
})

// A user signed in with the temporary password may only replace it or log out. This is global
// so new business routes cannot accidentally forget the mandatory-change restriction.
export const enforcePasswordChange = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user')
  if (!user?.requiresPasswordChange) return next()
  const allowed = new Set([
    '/api/auth/change-password',
    '/api/auth/logout',
    '/api/auth/login',
    '/api/auth/password-help',
  ])
  if (!allowed.has(c.req.path)) {
    return c.json({ error: 'password change required', code: 'PASSWORD_CHANGE_REQUIRED' }, 403)
  }
  await next()
})

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401)
  await next()
})

export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  if (user.role !== 'SUPER_ADMIN') return c.json({ error: 'forbidden' }, 403)
  await next()
})
