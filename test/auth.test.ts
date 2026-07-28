import { env, SELF } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { createUser } from '../src/lib/users'

const BASE = 'https://example.com'

function post(path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return SELF.fetch(`${BASE}${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined })
}

function patch(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return SELF.fetch(`${BASE}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
}

function get(path: string, token?: string) {
  return SELF.fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
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

/** Seed the super admin and log in — the admin endpoints all need a bearer token. */
async function seedAdminWithToken() {
  const admin = await seedAdmin()
  const res = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
  const { token } = await res.json<{ token: string }>()
  return { admin, token }
}

describe('self-registration', () => {
  it('is disabled — POST /api/auth/register answers 410', async () => {
    await seedAdmin()
    const res = await post('/api/auth/register', {
      fullName: 'A',
      phone: '0912345678',
      password: 'userpass123',
    })
    expect(res.status).toBe(410)
  })
})

// Accounts are created by the super admin only. This endpoint covers both the referrer-less
// "root" user and a referred one, so it carries the referral resolution the old /register did.
describe('admin creates users', () => {
  it('creates a USER under a referrer', async () => {
    const { admin, token } = await seedAdminWithToken()
    const res = await post(
      '/api/admin/users',
      {
        fullName: 'Nguyen Van A',
        phone: '0912345678',
        password: 'userpass123',
        referralCode: admin.referralCode, // = admin phone
      },
      token,
    )
    expect(res.status).toBe(201)
    const { user } = await res.json<{ user: { role: string; referrerId: string; referralCode: string } }>()
    expect(user.role).toBe('USER')
    expect(user.referrerId).toBe(admin.id)
    expect(user.referralCode).toBe('0912345678') // defaults to phone
  })

  it('creates a referrer-less root user when no referral code is given', async () => {
    const { token } = await seedAdminWithToken()
    const res = await post(
      '/api/admin/users',
      { fullName: 'Root', phone: '0912345678', password: 'userpass123' },
      token,
    )
    expect(res.status).toBe(201)
    const { user } = await res.json<{ user: { referrerId: string | null } }>()
    expect(user.referrerId).toBeNull()
  })

  it('rejects an unknown referral code with 400', async () => {
    const { token } = await seedAdminWithToken()
    const res = await post(
      '/api/admin/users',
      { fullName: 'A', phone: '0912345678', password: 'userpass123', referralCode: 'does-not-exist' },
      token,
    )
    expect(res.status).toBe(400)
  })

  it('rejects an over-long full name with 400', async () => {
    const { admin, token } = await seedAdminWithToken()
    const res = await post(
      '/api/admin/users',
      {
        fullName: 'x'.repeat(101),
        phone: '0912345678',
        password: 'userpass123',
        referralCode: admin.referralCode,
      },
      token,
    )
    expect(res.status).toBe(400)
  })

  it('rejects a weak password with 400', async () => {
    const { token } = await seedAdminWithToken()
    const res = await post(
      '/api/admin/users',
      { fullName: 'A', phone: '0912345678', password: 'short', referralCode: ADMIN_PHONE },
      token,
    )
    expect(res.status).toBe(400)
  })

  it('rejects a duplicate phone with 409', async () => {
    const { admin, token } = await seedAdminWithToken()
    const body = { fullName: 'A', phone: '0912345678', password: 'userpass123', referralCode: admin.referralCode }
    expect((await post('/api/admin/users', body, token)).status).toBe(201)
    expect((await post('/api/admin/users', body, token)).status).toBe(409)
  })

  it('rejects an unauthenticated caller', async () => {
    await seedAdmin()
    const res = await post('/api/admin/users', {
      fullName: 'A',
      phone: '0912345678',
      password: 'userpass123',
    })
    expect(res.status).toBe(401)
  })
})

describe('login', () => {
  it('logs in with correct phone + password (200 + token)', async () => {
    await seedAdmin()
    const res = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    expect(res.status).toBe(200)
    const { token } = await res.json<{ token: string }>()
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
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
  it('returns the current user with a token, 401 without', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const { token } = await login.json<{ token: string }>()

    const withToken = await get('/api/auth/me', token)
    expect(withToken.status).toBe(200)
    const { user } = await withToken.json<{ user: { phone: string } }>()
    expect(user.phone).toBe(ADMIN_PHONE)

    expect((await get('/api/auth/me')).status).toBe(401)
  })

  it('PATCH /me renames the user', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const { token } = await login.json<{ token: string }>()
    const res = await patch('/api/auth/me', { fullName: 'Renamed Admin' }, token)
    expect(res.status).toBe(200)
    const { user } = await res.json<{ user: { fullName: string } }>()
    expect(user.fullName).toBe('Renamed Admin')
  })

  it('logout is a stateless no-op that always succeeds', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const { token } = await login.json<{ token: string }>()
    expect((await post('/api/auth/logout', undefined, token)).status).toBe(200)
  })
})

describe('admin /users (RBAC)', () => {
  const rootBody = { fullName: 'Root User', phone: '0955555555', password: 'rootpass123' }

  it('lets the super admin create a referrer-less root user (201)', async () => {
    await seedAdmin()
    const login = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
    const { token } = await login.json<{ token: string }>()
    const res = await post('/api/admin/users', rootBody, token)
    expect(res.status).toBe(201)
    const { user } = await res.json<{ user: { role: string; referrerId: string | null } }>()
    expect(user.role).toBe('USER')
    expect(user.referrerId).toBeNull()
  })

  it('forbids a normal USER (403)', async () => {
    const admin = await seedAdmin()
    await createUser(env.DB, {
      fullName: 'A',
      phone: '0912345678',
      password: 'userpass123',
      role: 'USER',
      referrerId: admin.id,
      referrerEarnsBonus: false,
    })
    const login = await post('/api/auth/login', { phone: '0912345678', password: 'userpass123' })
    const { token } = await login.json<{ token: string }>()
    const res = await post('/api/admin/users', rootBody, token)
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
