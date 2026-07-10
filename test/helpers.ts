import { env, SELF } from 'cloudflare:test'
import { createUser } from '../src/lib/users'

export const BASE = 'https://example.com'

export function post(path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export function get(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} })
}

// No cookie jar in SELF.fetch — pull the session cookie out ourselves.
export function sessionCookie(res: Response): string {
  const session = res.headers.getSetCookie().find((c) => c.startsWith('session='))
  if (!session) throw new Error('no session cookie set')
  return session.split(';')[0]
}

export const ADMIN_PHONE = '0900000000'
export const ADMIN_PASSWORD = 'adminpass123'

/** Seed the singleton super admin (same path seed:admin uses) and return its login cookie. */
export async function seedAdmin(): Promise<{ id: string; referralCode: string; cookie: string }> {
  const admin = await createUser(env.DB, {
    fullName: 'Super Admin',
    phone: ADMIN_PHONE,
    password: ADMIN_PASSWORD,
    role: 'SUPER_ADMIN',
    referrerId: null,
  })
  const res = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
  return { id: admin.id, referralCode: admin.referralCode, cookie: sessionCookie(res) }
}

export interface RegisteredUser {
  id: string
  referralCode: string
  cookie: string
}

/** Register a USER under `referralCode`; returns their id, own referral code, and session cookie. */
export async function registerUser(
  referralCode: string,
  phone: string,
  fullName = 'Test User',
  password = 'userpass123',
): Promise<RegisteredUser> {
  const res = await post('/api/auth/register', { fullName, phone, password, referralCode })
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`)
  const { user } = await res.json<{ user: { id: string; referralCode: string } }>()
  return { id: user.id, referralCode: user.referralCode, cookie: sessionCookie(res) }
}
