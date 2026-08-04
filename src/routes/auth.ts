import { Hono } from 'hono'
import { arktypeValidator } from '@hono/arktype-validator'
import { type } from 'arktype'
import { verifyPassword } from '../lib/password'
import { signSession } from '../lib/jwt'
import {
  ConflictError,
  createUser,
  findByPhone,
  findByReferralCode,
  changePassword,
  toAuthUser,
  updateFullName,
} from '../lib/users'
import { requireAuth } from '../middleware/auth'
import { phone, fullName } from '../lib/validators'
import type { AppEnv } from '../types'

// A valid-but-nobody's hash. login runs verifyPassword against this when the phone is unknown,
// so the response takes the same time whether or not the account exists (no user enumeration).
const DUMMY_HASH = 'pbkdf2$100000$4QbIHNIHb2SdTo3UI3c89A==$/NXWDeJwzWvyUev/FvvKA5D51CM+h4n9SU632PWcFtw='

const registerSchema = type({
  fullName,
  phone,
  password: 'string >= 8',
  'referralCode?': 'string >= 1',
})

const loginSchema = type({
  phone,
  password: 'string >= 1',
})

const patchMeSchema = type({
  fullName,
})

const changePasswordSchema = type({
  currentPassword: 'string >= 1',
  newPassword: 'string >= 8',
  confirmPassword: 'string >= 8',
}).onUndeclaredKey('reject')

export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/register', arktypeValidator('json', registerSchema), async (c) => {
  const { fullName, phone, password, referralCode } = c.req.valid('json')

  // A referrer is required — from the body first, then the invite link's ?ref=.
  const code = referralCode ?? c.req.query('ref')
  if (!code) return c.json({ error: 'a referral code is required' }, 400)
  const referrer = await findByReferralCode(c.env.DB, code)
  if (!referrer) return c.json({ error: 'unknown referral code' }, 400)

  try {
    const user = await createUser(c.env.DB, {
      fullName,
      phone,
      password,
      role: 'USER',
      referrerId: referrer.id,
    })
    const token = await signSession(c.env.JWT_SECRET, user.id, 0)
    return c.json({ user, token }, 201)
  } catch (err) {
    if (err instanceof ConflictError && err.field === 'phone') {
      return c.json({ error: 'phone already registered' }, 409)
    }
    throw err
  }
})

authRoutes.post('/login', arktypeValidator('json', loginSchema), async (c) => {
  const { phone, password } = c.req.valid('json')

  const row = await findByPhone(c.env.DB, phone)
  // Always verify (dummy hash if no such user) so timing doesn't reveal whether the phone exists.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH)

  // Vague on purpose: same 401 for unknown phone, wrong password, or deactivated account.
  if (!row || !ok || row.is_active !== 1) {
    return c.json({ error: 'invalid phone or password' }, 401)
  }

  const user = toAuthUser(row)
  if (
    row.must_change_password === 1 &&
    (!row.temporary_password_expires_at || new Date(row.temporary_password_expires_at).getTime() <= Date.now())
  ) {
    return c.json({ error: 'temporary password expired', code: 'TEMPORARY_PASSWORD_EXPIRED' }, 401)
  }
  const token = await signSession(c.env.JWT_SECRET, user.id, row.password_version)
  return c.json({ user, token, requiresPasswordChange: user.requiresPasswordChange })
})

// Contact details for the frontend's manual Zalo password-recovery screen.
authRoutes.get('/password-help', (c) => {
  const zaloUrl = c.env.ZALO_ADMIN_URL ?? null
  const phone = c.env.ZALO_ADMIN_PHONE ?? null
  return c.json({ configured: Boolean(zaloUrl || phone), zaloUrl, zaloQrValue: zaloUrl, phone })
})

// Bearer tokens are stateless — nothing to invalidate server-side (no refresh-token store in
// this design; see docs/superpowers/specs/2026-07-17-bearer-auth-design.md). The client just
// discards its stored token. A token that leaked before logout stays valid until its natural
// 1-day expiry. Route kept for API symmetry — the client always has something to call.
authRoutes.post('/logout', (c) => {
  return c.json({ ok: true })
})

authRoutes.post(
  '/change-password',
  requireAuth,
  arktypeValidator('json', changePasswordSchema),
  async (c) => {
    const { currentPassword, newPassword, confirmPassword } = c.req.valid('json')
    if (newPassword !== confirmPassword) {
      return c.json({ error: 'password confirmation does not match', code: 'PASSWORD_MISMATCH' }, 400)
    }
    if (currentPassword === newPassword) {
      return c.json({ error: 'new password must be different', code: 'PASSWORD_UNCHANGED' }, 400)
    }
    const result = await changePassword(c.env.DB, c.get('user')!.id, currentPassword, newPassword, new Date())
    if (!result.ok) {
      if (result.error === 'TEMPORARY_PASSWORD_EXPIRED') {
        return c.json({ error: 'temporary password expired', code: 'TEMPORARY_PASSWORD_EXPIRED' }, 401)
      }
      return c.json({ error: 'current password is incorrect', code: 'CURRENT_PASSWORD_INCORRECT' }, 422)
    }
    return c.json({ ok: true, reauthenticationRequired: true })
  },
)

authRoutes.get('/me', requireAuth, (c) => {
  return c.json({ user: c.get('user') })
})

authRoutes.patch('/me', requireAuth, arktypeValidator('json', patchMeSchema), async (c) => {
  const current = c.get('user')!
  const { fullName } = c.req.valid('json')
  const user = await updateFullName(c.env.DB, current.id, fullName)
  // Practically unreachable (the request is authenticated), but a vanished row reads cleaner as
  // a 404 than a 200 with a null user (Mike, PR review).
  if (!user) return c.json({ error: 'user not found' }, 404)
  return c.json({ user })
})
