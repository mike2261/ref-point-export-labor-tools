import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

async function balances(token: string): Promise<{ f: number; g: number }> {
  const res = await get('/api/points/balances', token)
  const { f, g } = await res.json<{ f: number; g: number }>()
  return { f, g }
}

interface ActivateResponse {
  order: { id: string; status: string; fullName: string; orderCode: string }
  paid: { f: number; g: number }
}

describe('POST /api/admin/orders/activate', () => {
  it('creates an APPROVED order and settles the CTV\'s F wallet to 0, paying the referrer separately', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911111111') // +100 registration
    const ctv = await registerUser(referrer.referralCode, '0922222222') // +100 registration; referrer +20

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'Nguyễn Văn Khách', phone: '0933333333', orderCode: 'DH-TEST-01', idempotencyKey: 'k1' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { order, paid } = await res.json<ActivateResponse>()
    expect(order.status).toBe('APPROVED')
    expect(order.fullName).toBe('Nguyễn Văn Khách')
    expect(order.orderCode).toBe('DH-TEST-01')
    // 100 registration + 500 reward = 600 paid out; G had nothing.
    expect(paid).toEqual({ f: 600, g: 0 })

    // CTV: fully settled — every point they held (not just this order's reward) is gone.
    expect(await balances(ctv.token)).toEqual({ f: 0, g: 0 })
    // Referrer: untouched by the CTV's settlement — keeps accruing normally.
    // 100 registration + 20 referral-signup + 100 customer-referral = 220.
    expect((await balances(referrer.token)).f).toBe(220)

    const ctvNotifs = await (await get('/api/notifications', ctv.token)).json<{
      notifications: { type: string; title: string; body: string }[]
    }>()
    const activationNotifs = ctvNotifs.notifications.filter((n) => n.title === 'Khách hàng đã được kích hoạt')
    expect(activationNotifs).toHaveLength(1)
    expect(activationNotifs[0].type).toBe('REDEMPTION')
    expect(activationNotifs[0].body).toContain('600')

    const referrerNotifs = await (await get('/api/notifications', referrer.token)).json<{
      notifications: { type: string }[]
    }>()
    expect(referrerNotifs.notifications.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toHaveLength(1)
  })

  it('drains an existing G balance too, and skips the G ledger row entirely when G is 0', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0933000001')

    // Give the CTV a G balance the way maintenance accrual would, without waiting a month for it.
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
       VALUES (?, ?, 'G', 'MAINTENANCE_ACCRUAL', 100, 1, ?)`,
    )
      .bind(crypto.randomUUID(), ctv.id, new Date().toISOString())
      .run()
    expect((await balances(ctv.token)).g).toBe(100)

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-02', idempotencyKey: 'k2' },
      admin.token,
    )
    const { paid } = await res.json<ActivateResponse>()
    // 100 registration + 500 reward = 600 F; the 100 G accrued above.
    expect(paid).toEqual({ f: 600, g: 100 })
    expect(await balances(ctv.token)).toEqual({ f: 0, g: 0 })

    const rows = await env.DB.prepare(`SELECT wallet, points FROM point_ledger WHERE user_id = ? AND type = 'REDEMPTION'`)
      .bind(ctv.id)
      .all<{ wallet: string; points: number }>()
    expect(rows.results).toHaveLength(2) // both F and G drained

    // A second activation with an empty G wallet must not write a 0-point G row (CHECK points<>0).
    const second = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'B', phone: '0955555556', orderCode: 'DH-TEST-02B', idempotencyKey: 'k2b' },
      admin.token,
    )
    expect(second.status).toBe(201)
    const rowsAfter = await env.DB.prepare(`SELECT wallet FROM point_ledger WHERE user_id = ? AND type = 'REDEMPTION'`)
      .bind(ctv.id)
      .all<{ wallet: string }>()
    expect(rowsAfter.results.map((r) => r.wallet).sort()).toEqual(['F', 'F', 'G']) // no new G row
  })

  it('pays no referrer bonus when the CTV\'s referrer is the admin (A2-style)', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0944444444')

    await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-03', idempotencyKey: 'k3' },
      admin.token,
    )
    expect(await balances(ctv.token)).toEqual({ f: 0, g: 0 }) // settled, no referrer leg to pay

    const res = await get(`/api/admin/ledger?userId=${admin.id}&type=CUSTOMER_REFERRAL_BONUS`, admin.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)
  })

  it('rejects a replayed idempotencyKey with 409, no duplicate rows', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0966666666')
    const body = { userId: ctv.id, fullName: 'B', phone: '0977777777', orderCode: 'DH-TEST-04', idempotencyKey: 'k4' }

    const first = await post('/api/admin/orders/activate', body, admin.token)
    expect(first.status).toBe(201)
    const second = await post('/api/admin/orders/activate', body, admin.token)
    expect(second.status).toBe(409)

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE order_code = ?')
      .bind('DH-TEST-04')
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('404s for an unknown or non-USER userId', async () => {
    const admin = await seedAdmin()
    const body = { fullName: 'C', phone: '0988888888', orderCode: 'DH-TEST-05', idempotencyKey: 'k5' }

    expect((await post('/api/admin/orders/activate', { ...body, userId: 'does-not-exist' }, admin.token)).status).toBe(404)
    expect((await post('/api/admin/orders/activate', { ...body, userId: admin.id }, admin.token)).status).toBe(404)
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0999999999')
    const body = { userId: ctv.id, fullName: 'D', phone: '0900000009', orderCode: 'DH-TEST-06', idempotencyKey: 'k6' }

    expect((await post('/api/admin/orders/activate', body)).status).toBe(401)
    expect((await post('/api/admin/orders/activate', body, ctv.token)).status).toBe(403)
  })
})
