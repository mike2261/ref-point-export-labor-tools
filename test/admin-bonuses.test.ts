import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

interface GrantResponse {
  grant: {
    id: string
    scope: 'ALL' | 'PHONE'
    targetUserId: string | null
    amount: number
    content: string
    recipientCount: number
  }
}

async function gBalance(userId: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COALESCE(SUM(points),0) AS g FROM point_ledger WHERE user_id = ? AND wallet = 'G'`)
    .bind(userId)
    .first<{ g: number }>()
  return row?.g ?? 0
}

describe('POST /api/admin/bonuses — scope ALL', () => {
  it('credits every USER (not the admin), and only them, with a notification each', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911111111')
    const b = await registerUser(admin.referralCode, '0911111112')

    const res = await post(
      '/api/admin/bonuses',
      { scope: 'ALL', amount: 50, content: 'Thưởng mừng mốc 100 CTV', idempotencyKey: 'k1' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { grant } = await res.json<GrantResponse>()
    expect(grant.scope).toBe('ALL')
    expect(grant.recipientCount).toBe(2)

    expect(await gBalance(a.id)).toBe(50)
    expect(await gBalance(b.id)).toBe(50)

    const notifs = await (await get('/api/notifications', a.token)).json<{
      notifications: { type: string; title: string; body: string }[]
    }>()
    const bonusNotifs = notifs.notifications.filter((n) => n.type === 'ADMIN_BONUS')
    expect(bonusNotifs).toHaveLength(1)
    expect(bonusNotifs[0].body).toContain('50')
    expect(bonusNotifs[0].body).toContain('Thưởng mừng mốc 100 CTV')
  })

  it('a repeated idempotencyKey is a no-op (no double payout)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911111113')

    const first = await post(
      '/api/admin/bonuses',
      { scope: 'ALL', amount: 20, content: 'Thưởng', idempotencyKey: 'dup-key' },
      admin.token,
    )
    expect(first.status).toBe(201)
    expect(await gBalance(a.id)).toBe(20)

    const second = await post(
      '/api/admin/bonuses',
      { scope: 'ALL', amount: 20, content: 'Thưởng', idempotencyKey: 'dup-key' },
      admin.token,
    )
    expect(second.status).toBe(409)
    expect((await second.json<{ code: string }>()).code).toBe('DUPLICATE')
    expect(await gBalance(a.id)).toBe(20) // unchanged — not 40
  })

  it('requires SUPER_ADMIN', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0911111114')
    const body = { scope: 'ALL', amount: 10, content: 'x', idempotencyKey: 'k2' }
    expect((await post('/api/admin/bonuses', body)).status).toBe(401)
    expect((await post('/api/admin/bonuses', body, a.token)).status).toBe(403)
  })
})

describe('POST /api/admin/bonuses — scope PHONE', () => {
  it('credits exactly the phone-matched CTV, not others', async () => {
    const admin = await seedAdmin()
    const target = await registerUser(admin.referralCode, '0922222221')
    const other = await registerUser(admin.referralCode, '0922222222')

    const res = await post(
      '/api/admin/bonuses',
      { scope: 'PHONE', phone: '0922222221', amount: 30, content: 'Thưởng nóng', idempotencyKey: 'k3' },
      admin.token,
    )
    expect(res.status).toBe(201)
    const { grant } = await res.json<GrantResponse>()
    expect(grant.recipientCount).toBe(1)
    expect(grant.targetUserId).toBe(target.id)

    expect(await gBalance(target.id)).toBe(30)
    expect(await gBalance(other.id)).toBe(0)
  })

  it('404s for a phone with no matching CTV', async () => {
    const admin = await seedAdmin()
    const res = await post(
      '/api/admin/bonuses',
      { scope: 'PHONE', phone: '0999999999', amount: 30, content: 'x', idempotencyKey: 'k4' },
      admin.token,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/admin/bonuses', () => {
  it('lists grants newest-first', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0933333331')
    await post('/api/admin/bonuses', { scope: 'ALL', amount: 10, content: 'A', idempotencyKey: 'k5' }, admin.token)
    await post('/api/admin/bonuses', { scope: 'ALL', amount: 15, content: 'B', idempotencyKey: 'k6' }, admin.token)

    const res = await get('/api/admin/bonuses', admin.token)
    const { grants, total } = await res.json<{ grants: { content: string }[]; total: number }>()
    expect(total).toBe(2)
    expect(grants[0].content).toBe('B') // most recent first
  })
})

describe('GET /api/admin/bonuses/preview', () => {
  it('counts current CTV for scope=ALL', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0944444441')
    await registerUser(admin.referralCode, '0944444442')

    const res = await get('/api/admin/bonuses/preview?scope=ALL', admin.token)
    expect(res.status).toBe(200)
    expect((await res.json<{ recipientCount: number }>()).recipientCount).toBe(2)
  })
})
