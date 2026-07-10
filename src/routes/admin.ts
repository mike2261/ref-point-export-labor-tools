import { Hono } from 'hono'
import { arktypeValidator } from '@hono/arktype-validator'
import { type } from 'arktype'
import { ConflictError, createUser } from '../lib/users'
import { requireSuperAdmin } from '../middleware/auth'
import { phone, fullName } from '../lib/validators'
import type { AppEnv } from '../types'

const createRootUserSchema = type({
  fullName,
  phone,
  password: 'string >= 8',
})

export const adminRoutes = new Hono<AppEnv>()

// Everything under /api/admin requires the super admin.
adminRoutes.use('*', requireSuperAdmin)

// Create a referrer-less "root" USER to seed the referral network (PRD FR1). Normal /register
// requires a referrer, so the very first users can only come from here.
adminRoutes.post('/users', arktypeValidator('json', createRootUserSchema), async (c) => {
  const { fullName, phone, password } = c.req.valid('json')
  try {
    const user = await createUser(c.env.DB, {
      fullName,
      phone,
      password,
      role: 'USER',
      referrerId: null,
    })
    return c.json({ user }, 201)
  } catch (err) {
    if (err instanceof ConflictError && err.field === 'phone') {
      return c.json({ error: 'phone already registered' }, 409)
    }
    throw err
  }
})
