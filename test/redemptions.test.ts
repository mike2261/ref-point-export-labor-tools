import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, post, registerUser, seedAdmin, type RegisteredUser } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

async function balanceF(token: string): Promise<number> {
  return (await (await get('/api/points/balances', token)).json<{ f: number }>()).f
}

/**
 * Register a user under the admin and unlock redemption via one activated customer.
 * Activation now SETTLES the CTV in full — every point they hold (registration bonus included)
 * is drained to 0 in that same call, since it's a full cash-out, not just this order's reward.
 * So there's nothing left to redeem against right after it; these tests need a real balance, so
 * a REFERRAL_SIGNUP_BONUS-shaped row is added by hand afterwards (subject_user_id = self, same
 * shape REGISTRATION_BONUS's own row already uses) — standing in for "someone signed up under
 * this CTV after they were settled" — landing F at exactly 100.
 */
async function unlockedUser(adminToken: string, adminRef: string, phone: string): Promise<RegisteredUser> {
  const u = await registerUser(adminRef, phone)
  await activateCustomerFor(adminToken, u.id)
  await env.DB.prepare(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
     VALUES (?, ?, 'F', 'REFERRAL_SIGNUP_BONUS', 100, ?, ?)`,
  )
    .bind(crypto.randomUUID(), u.id, u.id, new Date().toISOString())
    .run()
  return u
}

describe('redemption', () => {
  it('is locked (422) for a user who never had an approved order', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const res = await post(
      '/api/admin/redemptions',
      { userId: a.id, f: 5, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(422)
    expect((await res.json<{ code: string }>()).code).toBe('REDEMPTION_LOCKED')
  })

  it('deducts exactly and leaves the remainder', async () => {
    const admin = await seedAdmin()
    const b = await unlockedUser(admin.token, admin.referralCode, '0912345678') // F = 100

    const res = await post(
      '/api/admin/redemptions',
      { userId: b.id, f: 40, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { entries, balances } = await res.json<{ entries: { wallet: string; points: number }[]; balances: { f: number } }>()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ wallet: 'F', points: -40 })
    expect(balances.f).toBe(60)
    expect(await balanceF(b.token)).toBe(60)
  })

  it('rejects an over-balance redemption (422) and writes nothing', async () => {
    const admin = await seedAdmin()
    const b = await unlockedUser(admin.token, admin.referralCode, '0912345678')
    const before = await ledgerCount()

    const res = await post(
      '/api/admin/redemptions',
      { userId: b.id, f: 10000, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(422)
    expect((await res.json<{ code: string }>()).code).toBe('INSUFFICIENT_BALANCE')
    expect(await ledgerCount()).toBe(before)
  })

  it('a replayed idempotencyKey is a 409 with no extra rows', async () => {
    const admin = await seedAdmin()
    const b = await unlockedUser(admin.token, admin.referralCode, '0912345678')
    const key = crypto.randomUUID()

    const first = await post('/api/admin/redemptions', { userId: b.id, f: 10, idempotencyKey: key }, admin.token)
    expect(first.status).toBe(201)
    const after = await ledgerCount()

    const replay = await post('/api/admin/redemptions', { userId: b.id, f: 10, idempotencyKey: key }, admin.token)
    expect(replay.status).toBe(409)
    expect((await replay.json<{ code: string }>()).code).toBe('DUPLICATE_REDEMPTION')
    expect(await ledgerCount()).toBe(after)
  })

  it('a replay is DUPLICATE (409), not INSUFFICIENT, even after the balance dropped below it', async () => {
    const admin = await seedAdmin()
    const b = await unlockedUser(admin.token, admin.referralCode, '0912345678') // F = 100
    const key = crypto.randomUUID()

    const first = await post('/api/admin/redemptions', { userId: b.id, f: 80, idempotencyKey: key }, admin.token)
    expect(first.status).toBe(201) // F 100 → 20

    // Replaying the same key with 80 would now exceed the 20 remainder — must still read as a replay.
    const replay = await post('/api/admin/redemptions', { userId: b.id, f: 80, idempotencyKey: key }, admin.token)
    expect(replay.status).toBe(409)
    expect((await replay.json<{ code: string }>()).code).toBe('DUPLICATE_REDEMPTION')
  })

  it('draining: consecutive redemptions succeed until the balance runs out', async () => {
    const admin = await seedAdmin()
    const b = await unlockedUser(admin.token, admin.referralCode, '0912345678') // F = 100

    const first = await post('/api/admin/redemptions', { userId: b.id, f: 100, idempotencyKey: crypto.randomUUID() }, admin.token)
    expect(first.status).toBe(201)
    expect(await balanceF(b.token)).toBe(0)

    const beyond = await post('/api/admin/redemptions', { userId: b.id, f: 1, idempotencyKey: crypto.randomUUID() }, admin.token)
    expect(beyond.status).toBe(422)
  })

  it('returns 404 for an unknown user', async () => {
    const admin = await seedAdmin()
    const res = await post(
      '/api/admin/redemptions',
      { userId: crypto.randomUUID(), f: 5, idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(404)
  })
})
