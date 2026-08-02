import { env, SELF } from 'cloudflare:test'
import { createUser } from '../src/lib/users'

export const BASE = 'https://example.com'

export function post(path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export function get(path: string, token?: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
}

export function patch(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return SELF.fetch(`${BASE}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
}

// Pull the bearer token out of a login/register JSON response.
export async function authToken(res: Response): Promise<string> {
  const { token } = await res.json<{ token: string }>()
  if (!token) throw new Error('no token in response body')
  return token
}

export const ADMIN_PHONE = '0900000000'
export const ADMIN_PASSWORD = 'adminpass123'

/** Seed the singleton super admin (same path seed:admin uses) and return its login token. */
export async function seedAdmin(): Promise<{ id: string; referralCode: string; token: string }> {
  const admin = await createUser(env.DB, {
    fullName: 'Super Admin',
    phone: ADMIN_PHONE,
    password: ADMIN_PASSWORD,
    role: 'SUPER_ADMIN',
    referrerId: null,
  })
  const res = await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })
  return { id: admin.id, referralCode: admin.referralCode, token: await authToken(res) }
}

export interface RegisteredUser {
  id: string
  referralCode: string
  token: string
}

/** Register a USER under `referralCode`; returns their id, own referral code, and auth token. */
export async function registerUser(
  referralCode: string,
  phone: string,
  fullName = 'Test User',
  password = 'userpass123',
): Promise<RegisteredUser> {
  const res = await post('/api/auth/register', { fullName, phone, password, referralCode })
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`)
  const { user, token } = await res.json<{ user: { id: string; referralCode: string }; token: string }>()
  return { id: user.id, referralCode: user.referralCode, token }
}

export interface OrderShape {
  id: string
  status: string
  fullName: string
  phone: string
  orderCode: string
  activationCode: string
}

let orderCodeSeq = 0

/**
 * Admin-activates one customer for `userId` — the only way an order comes into existence now
 * (POST /api/admin/orders/activate). Writes an already-APPROVED order plus CUSTOMER_REWARD, then
 * SETTLES the CTV IN FULL: every point they hold in both wallets (not just this order's reward)
 * is drained to 0 in the same batch, exactly as production does. So the CTV ends up
 * redemption-UNLOCKED but at F = 0, G = 0 — any test that needs a real balance afterwards has to
 * add it back by hand (see unlockedUser() in redemptions.test.ts for the pattern).
 */
export async function activateCustomerFor(
  adminToken: string,
  userId: string,
  opts: { fullName?: string; phone?: string; orderCode?: string } = {},
): Promise<OrderShape> {
  orderCodeSeq += 1
  const res = await post(
    '/api/admin/orders/activate',
    {
      userId,
      fullName: opts.fullName ?? 'Test Customer',
      phone: opts.phone ?? `09000000${String(orderCodeSeq).padStart(2, '0')}`,
      orderCode: opts.orderCode ?? `TEST-CODE-${orderCodeSeq}`,
      idempotencyKey: crypto.randomUUID(),
    },
    adminToken,
  )
  if (res.status !== 201) throw new Error(`activate customer failed: ${res.status} ${await res.text()}`)
  return (await res.json<{ order: OrderShape }>()).order
}
