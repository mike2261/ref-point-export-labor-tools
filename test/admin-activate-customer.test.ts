import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

async function balanceF(token: string): Promise<number> {
  const res = await get('/api/points/balances', token)
  const { f } = await res.json<{ f: number }>()
  return f
}

interface ActivateResponse {
  order: { id: string; status: string; fullName: string; orderCode: string }
}

describe('POST /api/admin/orders/activate', () => {
  it('creates an APPROVED order, nets the CTV F wallet to 0 for this order, pays the referrer, and sends one notification', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911111111') // +100 registration
    const ctv = await registerUser(referrer.referralCode, '0922222222') // +100 registration; referrer +20

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'Nguyễn Văn Khách', phone: '0933333333', orderCode: 'DH-TEST-01', idempotencyKey: 'k1' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { order } = await res.json<ActivateResponse>()
    expect(order.status).toBe('APPROVED')
    expect(order.fullName).toBe('Nguyễn Văn Khách')
    expect(order.orderCode).toBe('DH-TEST-01')

    // CTV: +100 registration, +500 reward, -500 redemption → net 100.
    expect(await balanceF(ctv.token)).toBe(100)
    // Referrer: +100 registration, +20 referral-signup, +100 customer-referral → 220.
    expect(await balanceF(referrer.token)).toBe(220)

    const ctvNotifs = await (await get('/api/notifications', ctv.token)).json<{
      notifications: { type: string; title: string }[]
    }>()
    const activationNotifs = ctvNotifs.notifications.filter((n) => n.title === 'Khách hàng đã được kích hoạt')
    expect(activationNotifs).toHaveLength(1)
    expect(activationNotifs[0].type).toBe('REDEMPTION')

    const referrerNotifs = await (await get('/api/notifications', referrer.token)).json<{
      notifications: { type: string }[]
    }>()
    expect(referrerNotifs.notifications.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toHaveLength(1)
  })

  it('pays no referrer bonus when the CTV\'s referrer is the admin (A2-style)', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0944444444')

    await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-02', idempotencyKey: 'k2' },
      admin.token,
    )
    expect(await balanceF(ctv.token)).toBe(100) // 100 registration only — net zero from activation

    const res = await get(`/api/admin/ledger?userId=${admin.id}&type=CUSTOMER_REFERRAL_BONUS`, admin.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)
  })

  it('rejects a replayed idempotencyKey with 409, no duplicate rows', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0966666666')
    const body = { userId: ctv.id, fullName: 'B', phone: '0977777777', orderCode: 'DH-TEST-03', idempotencyKey: 'k3' }

    const first = await post('/api/admin/orders/activate', body, admin.token)
    expect(first.status).toBe(201)
    const second = await post('/api/admin/orders/activate', body, admin.token)
    expect(second.status).toBe(409)

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE order_code = ?')
      .bind('DH-TEST-03')
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('404s for an unknown or non-USER userId', async () => {
    const admin = await seedAdmin()
    const body = { fullName: 'C', phone: '0988888888', orderCode: 'DH-TEST-04', idempotencyKey: 'k4' }

    expect((await post('/api/admin/orders/activate', { ...body, userId: 'does-not-exist' }, admin.token)).status).toBe(404)
    expect((await post('/api/admin/orders/activate', { ...body, userId: admin.id }, admin.token)).status).toBe(404)
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0999999999')
    const body = { userId: ctv.id, fullName: 'D', phone: '0900000009', orderCode: 'DH-TEST-05', idempotencyKey: 'k5' }

    expect((await post('/api/admin/orders/activate', body)).status).toBe(401)
    expect((await post('/api/admin/orders/activate', body, ctv.token)).status).toBe(403)
  })
})
