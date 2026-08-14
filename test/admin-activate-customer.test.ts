import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

async function balances(token: string): Promise<{ a: number; b: number; c: number }> {
  const res = await get('/api/points/balances', token)
  const { a, b, c } = await res.json<{ a: number; b: number; c: number }>()
  return { a, b, c }
}

interface ActivateResponse {
  order: { id: string; status: string; fullName: string; orderCode: string }
  paid: { b: number; c: number }
}

describe('POST /api/admin/orders/activate', () => {
  it('creates an APPROVED order and settles the CTV\'s B wallet to 0, paying the referrer\'s A wallet separately', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911111111') // +100 B registration
    const ctv = await registerUser(referrer.referralCode, '0922222222') // +100 B registration; referrer earns nothing yet

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
    // 100 registration + 500 reward = 600 paid out of B; C had nothing.
    expect(paid).toEqual({ b: 600, c: 0 })

    // CTV: B/C fully settled — every point they held there is gone.
    expect(await balances(ctv.token)).toEqual({ a: 0, b: 0, c: 0 })
    // Referrer: B untouched (just their own 100 registration bonus — no signup bonus exists
    // anymore). A gets exactly the 100 commission from the CTV's activation, and is NOT drained
    // (the referrer hasn't activated their own customer).
    expect(await balances(referrer.token)).toEqual({ a: 100, b: 100, c: 0 })

    const ctvNotifs = await (await get('/api/notifications', ctv.token)).json<{
      notifications: { type: string; title: string; body: string }[]
    }>()
    const activationNotifs = ctvNotifs.notifications.filter((n) => n.title === 'Khách hàng đã được kích hoạt')
    expect(activationNotifs).toHaveLength(1)
    expect(activationNotifs[0].type).toBe('REDEMPTION')
    // Thông báo hiển thị tiền, không hiển thị điểm: 600 điểm → 6.000.000đ.
    expect(activationNotifs[0].body).toContain('6.000.000')

    const referrerNotifs = await (await get('/api/notifications', referrer.token)).json<{
      notifications: { type: string }[]
    }>()
    expect(referrerNotifs.notifications.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toHaveLength(1)
  })

  it('a CTV who already holds an A balance (commission from a CTV they referred) keeps it after activating their own customer', async () => {
    const admin = await seedAdmin()
    const referrer = await registerUser(admin.referralCode, '0911199991')
    const referredCtv = await registerUser(referrer.referralCode, '0911199992')

    // The referred CTV lands a customer — referrer earns +100 A.
    await post(
      '/api/admin/orders/activate',
      { userId: referredCtv.id, fullName: 'Khach A', phone: '0911199993', orderCode: 'DH-TEST-0A', idempotencyKey: 'ka' },
      admin.token,
    )
    expect(await balances(referrer.token)).toEqual({ a: 100, b: 100, c: 0 })

    // The referrer now lands their own customer — B settles, A must be untouched.
    const res = await post(
      '/api/admin/orders/activate',
      { userId: referrer.id, fullName: 'Khach B', phone: '0911199994', orderCode: 'DH-TEST-0B', idempotencyKey: 'kb' },
      admin.token,
    )
    const { paid } = await res.json<ActivateResponse>()
    expect(paid).toEqual({ b: 600, c: 0 }) // 100 registration + 500 reward
    expect(await balances(referrer.token)).toEqual({ a: 100, b: 0, c: 0 }) // A survives untouched
  })

  it('drains an existing C balance too, and skips the C ledger row entirely when C is 0', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0933000001')

    // Give the CTV a C balance the way maintenance accrual would, without waiting a month for it.
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
       VALUES (?, ?, 'C', 'MAINTENANCE_ACCRUAL', 100, 1, ?)`,
    )
      .bind(crypto.randomUUID(), ctv.id, new Date().toISOString())
      .run()
    expect((await balances(ctv.token)).c).toBe(100)

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-02', idempotencyKey: 'k2' },
      admin.token,
    )
    const { paid } = await res.json<ActivateResponse>()
    // 100 registration + 500 reward = 600 B; the 100 C accrued above.
    expect(paid).toEqual({ b: 600, c: 100 })
    expect(await balances(ctv.token)).toEqual({ a: 0, b: 0, c: 0 })

    const rows = await env.DB.prepare(`SELECT wallet, points FROM point_ledger WHERE user_id = ? AND type = 'REDEMPTION'`)
      .bind(ctv.id)
      .all<{ wallet: string; points: number }>()
    // B splits into -500 (customer) + -100 (leftover registration), plus C's -100.
    expect(rows.results).toHaveLength(3)

    // A second activation with an empty C wallet, and no leftover registration bonus (already
    // drained above), must write only the customer-portion B row — no 0-point rows (CHECK points<>0).
    const second = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'B', phone: '0955555556', orderCode: 'DH-TEST-02B', idempotencyKey: 'k2b' },
      admin.token,
    )
    expect(second.status).toBe(201)
    const rowsAfter = await env.DB.prepare(`SELECT wallet FROM point_ledger WHERE user_id = ? AND type = 'REDEMPTION'`)
      .bind(ctv.id)
      .all<{ wallet: string }>()
    expect(rowsAfter.results.map((r) => r.wallet).sort()).toEqual(['B', 'B', 'B', 'C']) // no new C row, one new B row
  })

  it('splits the B drain by source (sourceType) and orders the reward credit above its own settlement', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0933000099') // +100 B registration, not yet drained

    const res = await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'Khach Split', phone: '0955555599', orderCode: 'DH-TEST-SPLIT', idempotencyKey: 'ksplit' },
      admin.token,
    )
    expect(res.status).toBe(201)

    const list = await get('/api/points/ledger?wallet=B', ctv.token)
    const { entries } = await list.json<{ entries: { type: string; points: number; sourceType: string | null }[] }>()
    expect(entries).toHaveLength(4)

    // The B drain is exactly two REDEMPTION rows, correctly attributed by sourceType.
    const redemptions = entries.filter((e) => e.type === 'REDEMPTION').map((e) => ({ points: e.points, sourceType: e.sourceType }))
    expect(redemptions).toHaveLength(2)
    expect(redemptions).toContainEqual({ points: -500, sourceType: 'CUSTOMER_REWARD' })
    expect(redemptions).toContainEqual({ points: -100, sourceType: 'REGISTRATION_BONUS' })

    // Newest first: the +500 credit and its own -500 settlement share the same instant — the
    // credit must still sort above both same-instant REDEMPTION rows, not the other way round.
    expect(entries[0]).toMatchObject({ type: 'CUSTOMER_REWARD', points: 500 })
    // The original +100 registration credit (an earlier, different timestamp) is oldest, last.
    expect(entries[3]).toMatchObject({ type: 'REGISTRATION_BONUS', points: 100 })
  })

  it('pays no referrer bonus when the CTV\'s referrer is the admin (A2-style)', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0944444444')

    await post(
      '/api/admin/orders/activate',
      { userId: ctv.id, fullName: 'A', phone: '0955555555', orderCode: 'DH-TEST-03', idempotencyKey: 'k3' },
      admin.token,
    )
    expect(await balances(ctv.token)).toEqual({ a: 0, b: 0, c: 0 }) // settled, no referrer leg to pay

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
