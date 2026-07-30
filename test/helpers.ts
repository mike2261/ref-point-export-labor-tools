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

/** POST /api/orders — creates a DRAFT for the person going abroad. `phone` is the field tests
 * usually vary; orderCode/activationCode default to unique-per-call placeholders since the API
 * no longer generates or dedupes them (the admin verifies these manually). */
export async function createDraftOrder(
  token: string,
  phone: string,
  opts: { fullName?: string; orderCode?: string; activationCode?: string; note?: string } = {},
): Promise<OrderShape> {
  orderCodeSeq += 1
  const res = await post(
    '/api/orders',
    {
      fullName: opts.fullName ?? 'Test Person',
      phone,
      orderCode: opts.orderCode ?? `TEST-CODE-${orderCodeSeq}`,
      activationCode: opts.activationCode ?? `TEST-ACT-${orderCodeSeq}`,
      note: opts.note,
    },
    token,
  )
  if (res.status !== 201) throw new Error(`create order failed: ${res.status} ${await res.text()}`)
  return (await res.json<{ order: OrderShape }>()).order
}

/** Create a DRAFT and immediately submit it (DRAFT → PENDING) — the common case in tests. */
export async function createPendingOrder(
  token: string,
  phone: string,
  opts: { fullName?: string; orderCode?: string; activationCode?: string; note?: string } = {},
): Promise<OrderShape> {
  const draft = await createDraftOrder(token, phone, opts)
  const res = await post(`/api/orders/${draft.id}/submit`, undefined, token)
  if (res.status !== 200) throw new Error(`submit order failed: ${res.status} ${await res.text()}`)
  return (await res.json<{ order: OrderShape }>()).order
}
