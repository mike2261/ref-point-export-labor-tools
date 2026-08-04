import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { activateCustomerFor, get, registerUser, seedAdmin } from './helpers'

interface UserRow {
  id: string
  fullName: string
  phone: string
  balanceA: number
  balanceB: number
  balanceC: number
}

interface ListUsersResponse {
  users: UserRow[]
  page: number
  limit: number
  total: number
}

describe('GET /api/admin/users', () => {
  it('lists every user, including the admin itself', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678', 'Alice')
    await registerUser(admin.referralCode, '0987654321', 'Bob')

    const res = await get('/api/admin/users', admin.token)
    expect(res.status).toBe(200)
    const { users, total } = await res.json<ListUsersResponse>()
    expect(total).toBe(3)
    expect(users.map((u) => u.phone).sort()).toEqual(['0900000000', '0912345678', '0987654321'])
  })

  it('q filters by a full_name substring', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678', 'Alice Nguyen')
    await registerUser(admin.referralCode, '0987654321', 'Bob Tran')

    const res = await get('/api/admin/users?q=Alice', admin.token)
    const { users, total } = await res.json<ListUsersResponse>()
    expect(total).toBe(1)
    expect(users[0].fullName).toBe('Alice Nguyen')
  })

  it('q filters by a phone substring', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678', 'Alice')
    await registerUser(admin.referralCode, '0987654321', 'Bob')

    const res = await get('/api/admin/users?q=91234', admin.token)
    const { users, total } = await res.json<ListUsersResponse>()
    expect(total).toBe(1)
    expect(users[0].phone).toBe('0912345678')
  })

  it('q with no match returns an empty list', async () => {
    const admin = await seedAdmin()
    const res = await get('/api/admin/users?q=nobody-matches-this', admin.token)
    const { users, total } = await res.json<ListUsersResponse>()
    expect(users).toEqual([])
    expect(total).toBe(0)
  })

  it('paginates with page/limit', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678', 'Alice')
    await registerUser(admin.referralCode, '0987654321', 'Bob')

    const res = await get('/api/admin/users?page=1&limit=2', admin.token)
    const { users, page, limit, total } = await res.json<ListUsersResponse>()
    expect(page).toBe(1)
    expect(limit).toBe(2)
    expect(total).toBe(3)
    expect(users).toHaveLength(2)
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    expect((await get('/api/admin/users')).status).toBe(401)
    expect((await get('/api/admin/users', user.token)).status).toBe(403)
  })

  it('each row carries the real A/B/C balances', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // +100 B registration

    const res = await get('/api/admin/users?q=0912345678', admin.token)
    const { users } = await res.json<ListUsersResponse>()
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ balanceA: 0, balanceB: 100, balanceC: 0 })
  })

  it('sort=b_asc / b_desc orders by B balance', async () => {
    const admin = await seedAdmin()
    const undrained = await registerUser(admin.referralCode, '0911111111', 'Undrained') // B = 100
    const drained = await registerUser(admin.referralCode, '0922222222', 'Drained') // B = 100, then settled to 0 by its own activation
    await activateCustomerFor(admin.token, drained.id)

    const asc = await (await get('/api/admin/users?sort=b_asc', admin.token)).json<ListUsersResponse>()
    const ascIds = asc.users.map((u) => u.id)
    expect(ascIds.indexOf(drained.id)).toBeLessThan(ascIds.indexOf(undrained.id)) // 0 sorts before 100

    const desc = await (await get('/api/admin/users?sort=b_desc', admin.token)).json<ListUsersResponse>()
    const descIds = desc.users.map((u) => u.id)
    expect(descIds.indexOf(undrained.id)).toBeLessThan(descIds.indexOf(drained.id))
  })

  it('sort=c_asc / c_desc orders by C balance', async () => {
    const admin = await seedAdmin()
    const low = await registerUser(admin.referralCode, '0933333333', 'LowC')
    const high = await registerUser(admin.referralCode, '0944444444', 'HighC')
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
       VALUES (?, ?, 'C', 'MAINTENANCE_ACCRUAL', 100, 1, ?)`,
    )
      .bind(crypto.randomUUID(), high.id, new Date().toISOString())
      .run()

    const desc = await (await get('/api/admin/users?sort=c_desc', admin.token)).json<ListUsersResponse>()
    const descIds = desc.users.map((u) => u.id)
    expect(descIds.indexOf(high.id)).toBeLessThan(descIds.indexOf(low.id))
  })

  it('rejects an unknown sort value with 400', async () => {
    const admin = await seedAdmin()
    const res = await get('/api/admin/users?sort=bogus', admin.token)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/admin/users/:id', () => {
  it('returns the user', async () => {
    const admin = await seedAdmin()
    const alice = await registerUser(admin.referralCode, '0912345678', 'Alice')

    const res = await get(`/api/admin/users/${alice.id}`, admin.token)
    expect(res.status).toBe(200)
    const { user } = await res.json<{ user: UserRow }>()
    expect(user.id).toBe(alice.id)
    expect(user.fullName).toBe('Alice')
    expect(user.phone).toBe('0912345678')
  })

  it('returns 404 for an unknown id', async () => {
    const admin = await seedAdmin()
    const res = await get('/api/admin/users/does-not-exist', admin.token)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'user not found' })
  })

  it('is 401 for anonymous and 403 for a logged-in USER', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    expect((await get(`/api/admin/users/${user.id}`)).status).toBe(401)
    expect((await get(`/api/admin/users/${user.id}`, user.token)).status).toBe(403)
  })
})

describe('GET /api/admin/users/:id/referred-ctvs', () => {
  it('lists the given user\'s direct referrals', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    await registerUser(a.referralCode, '0911111111', 'Referred One')

    const res = await get(`/api/admin/users/${a.id}/referred-ctvs`, admin.token)
    expect(res.status).toBe(200)
    const { users, total } = await res.json<{ users: { fullName: string }[]; total: number }>()
    expect(total).toBe(1)
    expect(users[0].fullName).toBe('Referred One')
  })

  it('returns 404 for an unknown id', async () => {
    const admin = await seedAdmin()
    const res = await get('/api/admin/users/does-not-exist/referred-ctvs', admin.token)
    expect(res.status).toBe(404)
  })
})
