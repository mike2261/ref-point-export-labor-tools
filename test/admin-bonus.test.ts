import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { anniversaryDate } from '../src/domain/points/periods'
import { runMaintenance } from '../src/lib/maintenance'
import { get, post, registerUser, seedAdmin } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

describe('Super Admin wallet G bonus', () => {
  it('credits only G and records the reason and administering user', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')

    const res = await post(
      `/api/admin/users/${ctv.id}/g-bonus`,
      { points: 25, reason: '  Thuong hoat dong thang 7  ', idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(res.status).toBe(201)
    const body = await res.json<{
      entry: { userId: string; wallet: string; type: string; points: number; note: string; createdBy: string }
      balances: { before: { f: number; g: number }; after: { f: number; g: number } }
    }>()
    expect(body.entry).toMatchObject({
      userId: ctv.id,
      wallet: 'G',
      type: 'ADMIN_BONUS',
      points: 25,
      note: 'Thuong hoat dong thang 7',
      createdBy: admin.id,
    })
    expect(body.balances.after.f).toBe(body.balances.before.f)
    expect(body.balances.after.g).toBe(body.balances.before.g + 25)

    const history = await get('/api/points/ledger?wallet=G&type=ADMIN_BONUS', ctv.token)
    expect(history.status).toBe(200)
    const { entries } = await history.json<{ entries: { type: string; points: number }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'ADMIN_BONUS', points: 25 })
  })

  it('rejects a replayed idempotency key without a second credit', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const idempotencyKey = crypto.randomUUID()
    const payload = { points: 10, reason: 'Thuong thu cong', idempotencyKey }

    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, payload, admin.token)).status).toBe(201)
    const countAfterFirst = await ledgerCount()
    const replay = await post(`/api/admin/users/${ctv.id}/g-bonus`, payload, admin.token)
    expect(replay.status).toBe(409)
    expect((await replay.json<{ code: string }>()).code).toBe('DUPLICATE_ADMIN_BONUS')
    expect(await ledgerCount()).toBe(countAfterFirst)
  })

  it('requires Super Admin and refuses to award the Super Admin account', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const payload = { points: 10, reason: 'Thuong', idempotencyKey: crypto.randomUUID() }

    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, payload)).status).toBe(401)
    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, payload, ctv.token)).status).toBe(403)

    const own = await post(`/api/admin/users/${admin.id}/g-bonus`, payload, admin.token)
    expect(own.status).toBe(403)
    expect((await own.json<{ code: string }>()).code).toBe('SUPER_ADMIN_BONUS_FORBIDDEN')
  })

  it('validates the recipient, amount, reason and undeclared fields', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const key = () => crypto.randomUUID()

    expect((await post(`/api/admin/users/${crypto.randomUUID()}/g-bonus`, { points: 10, reason: 'x', idempotencyKey: key() }, admin.token)).status).toBe(404)
    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, { points: 0, reason: 'x', idempotencyKey: key() }, admin.token)).status).toBe(400)
    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, { points: -1, reason: 'x', idempotencyKey: key() }, admin.token)).status).toBe(400)
    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, { points: 1.5, reason: 'x', idempotencyKey: key() }, admin.token)).status).toBe(400)
    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, { points: 10, reason: '   ', idempotencyKey: key() }, admin.token)).status).toBe(400)
    expect((await post(`/api/admin/users/${ctv.id}/g-bonus`, { points: 10, reason: 'x', idempotencyKey: key(), wallet: 'F' }, admin.token)).status).toBe(400)
  })

  it('is included in the ordinary three-month G reset', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const user = await env.DB.prepare('SELECT created_at FROM users WHERE id = ?').bind(ctv.id).first<{ created_at: string }>()
    if (!user) throw new Error('test user missing')

    const bonus = await post(
      `/api/admin/users/${ctv.id}/g-bonus`,
      { points: 25, reason: 'Thuong chu ky', idempotencyKey: crypto.randomUUID() },
      admin.token,
    )
    expect(bonus.status).toBe(201)

    await runMaintenance(env.DB, anniversaryDate(new Date(user.created_at), 4))
    const balances = await (await get('/api/points/balances', ctv.token)).json<{ g: number }>()
    expect(balances.g).toBe(10)
  })
})
