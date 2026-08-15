import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, post, registerUser, seedAdmin, type RegisteredUser } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

async function balances(token: string): Promise<{ a: number; b: number; c: number }> {
  const res = await get('/api/points/balances', token)
  const { a, b, c } = await res.json<{ a: number; b: number; c: number }>()
  return { a, b, c }
}

let downstreamPhoneSeq = 0

/**
 * Register a referrer + a downstream CTV, then activate a customer for the downstream CTV —
 * the referrer earns +100 wallet A (commission) without ever activating a customer themselves,
 * so `hasCustomerReward` stays false for them. This is the only wallet where a real, legitimate
 * app flow leaves a positive, unlocked-independent balance sitting there to redeem.
 */
async function referrerWithCommission(adminToken: string, adminRef: string, phone: string): Promise<RegisteredUser> {
  downstreamPhoneSeq += 1
  const referrer = await registerUser(adminRef, phone)
  const downstream = await registerUser(referrer.referralCode, `0922${String(downstreamPhoneSeq).padStart(6, '0')}`)
  await activateCustomerFor(adminToken, downstream.id)
  return referrer
}

/**
 * Register + activate a customer (mở khoá rút tiền, và cộng +500 vào ví B — từ 15/08/2026 kích
 * hoạt không tất toán ví nữa). Thêm một dòng CUSTOMER_REWARD nữa bằng tay (kèm đơn thật cho khớp
 * khoá ngoại) để có nhiều hơn một nguồn cộng, đại diện cho "một khoản thưởng nữa rơi vào ngoài
 * luồng thường" — redeem() phải xử lý đúng bất kể số dư đến từ đâu.
 */
async function unlockedUserWithExtraB(adminToken: string, adminRef: string, phone: string): Promise<RegisteredUser> {
  const u = await registerUser(adminRef, phone)
  await activateCustomerFor(adminToken, u.id) // +500 B, hasCustomerReward -> true (không còn trừ)
  const orderId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (id, user_id, full_name, phone, order_code, activation_code, status, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, 'Extra Order', '0900000099', ?, ?, 'APPROVED', ?, ?, ?, ?)`,
    ).bind(orderId, u.id, `EXTRA-${orderId.slice(0, 8)}`, `EXTRA-${orderId.slice(0, 8)}`, u.id, now, now, now),
    env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at) VALUES (?, ?, 'B', 'CUSTOMER_REWARD', 100, ?, ?)`,
    ).bind(crypto.randomUUID(), u.id, orderId, now),
  ])
  return u
}

describe('redemption', () => {
  it('is locked (422) for wallet B when the CTV never had a customer reward', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const res = await post(
      '/api/admin/redemptions',
      { userId: a.id, b: 5, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(422)
    expect((await res.json<{ code: string }>()).code).toBe('REDEMPTION_LOCKED')
  })

  it('wallet A is redeemable even when the CTV never had a customer reward of their own', async () => {
    const admin = await seedAdmin()
    const referrer = await referrerWithCommission(admin.token, admin.referralCode, '0911100001')
    expect((await balances(referrer.token)).a).toBe(100)

    const res = await post(
      '/api/admin/redemptions',
      { userId: referrer.id, a: 40, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { entries, balances: resultBalances } = await res.json<{
      entries: { wallet: string; points: number }[]
      balances: { a: number }
    }>()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ wallet: 'A', points: -40 })
    expect(resultBalances.a).toBe(60)
    expect((await balances(referrer.token)).a).toBe(60)
  })

  it('deducts wallet B exactly and leaves the remainder, once unlocked', async () => {
    const admin = await seedAdmin()
    const b = await unlockedUserWithExtraB(admin.token, admin.referralCode, '0911100002')
    // 100 thưởng đăng ký + 500 kích hoạt + 100 dòng thêm tay = 700, không có dòng trừ nào.
    expect((await balances(b.token)).b).toBe(700)

    const res = await post(
      '/api/admin/redemptions',
      { userId: b.id, b: 40, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { balances: resultBalances } = await res.json<{ balances: { b: number } }>()
    expect(resultBalances.b).toBe(660)
  })

  it('redeems multiple wallets in one call', async () => {
    const admin = await seedAdmin()
    const referrer = await referrerWithCommission(admin.token, admin.referralCode, '0911100003')
    const downstream2 = await registerUser(referrer.referralCode, '0911100013')
    await activateCustomerFor(admin.token, downstream2.id) // referrer: A = 200 total
    expect((await balances(referrer.token)).a).toBe(200)

    // Referrer registered under admin, so their own B is 100 (registration bonus, never drained
    // since they never activated a customer themselves) but B is still LOCKED (no own reward) —
    // so only A is redeemed here.
    const res = await post(
      '/api/admin/redemptions',
      { userId: referrer.id, a: 150, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { entries } = await res.json<{ entries: { wallet: string; points: number }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ wallet: 'A', points: -150 })
  })

  it('rejects an over-balance redemption (422) and writes nothing', async () => {
    const admin = await seedAdmin()
    const referrer = await referrerWithCommission(admin.token, admin.referralCode, '0911100004')
    const before = await ledgerCount()

    const res = await post(
      '/api/admin/redemptions',
      { userId: referrer.id, a: 10000, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(422)
    expect((await res.json<{ code: string }>()).code).toBe('INSUFFICIENT_BALANCE')
    expect(await ledgerCount()).toBe(before)
  })

  it('a replayed idempotencyKey is a 409 with no extra rows', async () => {
    const admin = await seedAdmin()
    const referrer = await referrerWithCommission(admin.token, admin.referralCode, '0911100005')
    const key = crypto.randomUUID()

    const first = await post('/api/admin/redemptions', { userId: referrer.id, a: 10, idempotencyKey: key }, admin.token)
    expect(first.status).toBe(201)
    const after = await ledgerCount()

    const replay = await post('/api/admin/redemptions', { userId: referrer.id, a: 10, idempotencyKey: key }, admin.token)
    expect(replay.status).toBe(409)
    expect((await replay.json<{ code: string }>()).code).toBe('DUPLICATE_REDEMPTION')
    expect(await ledgerCount()).toBe(after)
  })

  it('a replay is DUPLICATE (409), not INSUFFICIENT, even after the balance dropped below it', async () => {
    const admin = await seedAdmin()
    const referrer = await referrerWithCommission(admin.token, admin.referralCode, '0911100006') // A = 100
    const key = crypto.randomUUID()

    const first = await post('/api/admin/redemptions', { userId: referrer.id, a: 80, idempotencyKey: key }, admin.token)
    expect(first.status).toBe(201) // A 100 -> 20

    const replay = await post('/api/admin/redemptions', { userId: referrer.id, a: 80, idempotencyKey: key }, admin.token)
    expect(replay.status).toBe(409)
    expect((await replay.json<{ code: string }>()).code).toBe('DUPLICATE_REDEMPTION')
  })

  it('draining: consecutive redemptions succeed until the balance runs out', async () => {
    const admin = await seedAdmin()
    const referrer = await referrerWithCommission(admin.token, admin.referralCode, '0911100007') // A = 100

    const first = await post(
      '/api/admin/redemptions',
      { userId: referrer.id, a: 100, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(first.status).toBe(201)
    expect((await balances(referrer.token)).a).toBe(0)

    const beyond = await post(
      '/api/admin/redemptions',
      { userId: referrer.id, a: 1, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(beyond.status).toBe(422)
  })

  it('returns 404 for an unknown user', async () => {
    const admin = await seedAdmin()
    const res = await post(
      '/api/admin/redemptions',
      { userId: crypto.randomUUID(), a: 5, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(404)
  })

  it('rejects a body with no wallet amount', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911100008')
    const res = await post(
      '/api/admin/redemptions',
      { userId: a.id, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(400)
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911100009')
    const body = { userId: a.id, a: 5, idempotencyKey: crypto.randomUUID() }

    expect((await post('/api/admin/redemptions', body)).status).toBe(401)
    expect((await post('/api/admin/redemptions', body, a.token)).status).toBe(403)
  })
})
