import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { createUser } from '../src/lib/users'

const BASE = 'https://example.com'

function post(path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  return SELF.fetch(`${BASE}${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined })
}

function patch(path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  return SELF.fetch(`${BASE}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
}

function get(path: string, cookie?: string) {
  return SELF.fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} })
}

// No cookie jar in SELF.fetch — extract the session cookie ourselves.
function sessionCookie(res: Response): string {
  const session = res.headers.getSetCookie().find((c) => c.startsWith('session='))
  if (!session) throw new Error('no session cookie set')
  return session.split(';')[0]
}

// Seed the singleton super admin directly via the shared createUser (same path seed:admin uses).
const ADMIN_PHONE = '0900000000'
const ADMIN_PASSWORD = 'adminpass123'
function seedAdmin() {
  return createUser(env.DB, {
    fullName: 'Super Admin',
    phone: ADMIN_PHONE,
    password: ADMIN_PASSWORD,
    role: 'SUPER_ADMIN',
    referrerId: null,
  })
}

describe('register', () => {
  it('registers a USER under a referrer and sets a session cookie', async () => {
    const admin = await seedAdmin()
    const res = await post('/api/auth/register', {
      fullName: 'Nguyen Van A',
      phone: '0912345678',
      password: 'userpass123',
      referralCode: admin.referralCode, // = admin phone
    })
    expect(res.status).toBe(201)
    expect(sessionCookie(res)).toMatch(/^session=/)
    // Over the https test base the cookie must stay Secure + HttpOnly (prod behavior).
    const rawCookie = res.headers.getSetCookie().find((c) => c.startsWith('session='))!
    expect(rawCookie).toMatch(/Secure/)
    expect(rawCookie).toMatch(/HttpOnly/)
    const { user } = await res.json<{ user: { role: string; referrerId: string; referralCode: string } }>()
    expect(user.role).toBe('USER')
    expect(user.referrerId).toBe(admin.id)
    expect(user.referralCode).toBe('0912345678') // defaults to phone
  })

  it('rejects an over-long full name with 400', async () => {
    const admin = await seedAdmin()
    const res = await post('/api/auth/register', {
      fullName: 'x'.repeat(101),
      phone: '0912345678',
      password: 'userpass123',
      referralCode: admin.referralCode,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing referral code with 400', async () => {
    await seedAdmin()
    const res = await post('/api/auth/register', { fullName: 'A', phone: '0912345678', password: 'userpass123' })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown referral code with 400', async () => {
    await seedAdmin()
    const res = await post('/api/auth/register', {
      fullName: 'A',
      phone: '0912345678',
      password: 'userpass123',
      referralCode: 'does-not-exist',
    })
    expect(res.status).toBe(400)
  })

  it('rejects a weak password with 400', async () => {
    await seedAdmin()
    const res = await post('/api/auth/register', {
      fullName: 'A',
      phone: '0912345678',
      password: 'short',
      referralCode: ADMIN_PHONE,
    })
    expect(res.status).toBe(400)
  })

  it('rejects a duplicate phone with 409', async () => {
    const admin = await seedAdmin()
    const body = { fullName: 'A', phone: '0912345678', password: 'userpass123', referralCode: admin.referralCode }
    expect((await post('/api/auth/register', body)).status).toBe(201)
    expect((await post('/api/auth/register', body)).status).toBe(409)
  })

  it('accepts the referrer via the ?ref= query when no body code is given', async () => {
    const admin = await seedAdmin()
    const res = await post(`/api/auth/register?ref=${admin.referralCode}`, {
      fullName: 'A',
      phone: '0912345678',
      password: 'userpass123',
    })
    expect(res.status).toBe(201)
    const { user } = await res.json<{ user: { referrerId: string } }>()
    expect(user.referrerId).toBe(admin.id)
  })
})

describe('login', () => {
  it('logs in with correct phone + password (200 + cookie)', async () => {
    await seedAdmin()
    const res = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toMatch(/^session=/)
  })

  it('normalizes +84 to 0 on login', async () => {
    await seedAdmin()
    const res = await post('/api/auth/login', { phone: '+84900000000', password: ADMIN_PASSWORD })
    expect(res.status).toBe(200)
  })

  it('returns a vague 401 for a wrong password', async () => {
    await seedAdmin()
    const res = await post('/api/auth/login', { phone: ADMIN_PHONE, password: 'wrongpass123' })
    expect(res.status).toBe(401)
  })

  it('returns the same 401 for an unknown phone (no enumeration)', async () => {
    await seedAdmin()
    const res = await post('/api/auth/login', { phone: '0988888888', password: 'whatever123' })
    expect(res.status).toBe(401)
  })
})

describe('me + logout', () => {
  it('returns the current user with a cookie, 401 without', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const cookie = sessionCookie(login)

    const withCookie = await get('/api/auth/me', cookie)
    expect(withCookie.status).toBe(200)
    const { user } = await withCookie.json<{ user: { phone: string } }>()
    expect(user.phone).toBe(ADMIN_PHONE)

    expect((await get('/api/auth/me')).status).toBe(401)
  })

  it('PATCH /me renames the user', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const cookie = sessionCookie(login)
    const res = await patch('/api/auth/me', { fullName: 'Renamed Admin' }, cookie)
    expect(res.status).toBe(200)
    const { user } = await res.json<{ user: { fullName: string } }>()
    expect(user.fullName).toBe('Renamed Admin')
  })

  it('logout clears the session', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const cookie = sessionCookie(login)
    expect((await post('/api/auth/logout', undefined, cookie)).status).toBe(200)
  })
})

describe('admin /users (RBAC)', () => {
  const rootBody = { fullName: 'Root User', phone: '0955555555', password: 'rootpass123' }

  it('lets the super admin create a referrer-less root user (201)', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const cookie = sessionCookie(login)
    const res = await post('/api/admin/users', rootBody, cookie)
    expect(res.status).toBe(201)
    const { user } = await res.json<{ user: { role: string; referrerId: string | null } }>()
    expect(user.role).toBe('USER')
    expect(user.referrerId).toBeNull()
  })

  it('forbids a normal USER (403)', async () => {
    const admin = await seedAdmin()
    const reg = await post('/api/auth/register', {
      fullName: 'A',
      phone: '0912345678',
      password: 'userpass123',
      referralCode: admin.referralCode,
    })
    const userCookie = sessionCookie(reg)
    const res = await post('/api/admin/users', rootBody, userCookie)
    expect(res.status).toBe(403)
  })

  it('rejects an anonymous request (401)', async () => {
    await seedAdmin()
    const res = await post('/api/admin/users', rootBody)
    expect(res.status).toBe(401)
  })
})

describe('single super admin invariant', () => {
  it('the DB rejects a second super admin', async () => {
    await seedAdmin()
    await expect(
      createUser(env.DB, {
        fullName: 'Impostor',
        phone: '0911111111',
        password: 'impostor123',
        role: 'SUPER_ADMIN',
        referrerId: null,
      }),
    ).rejects.toThrow()
  })
})
