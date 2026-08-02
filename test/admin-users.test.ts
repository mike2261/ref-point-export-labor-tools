import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { get, registerUser, seedAdmin } from './helpers'

interface UserRow {
  id: string
  fullName: string
  phone: string
  balanceF: number
  balanceG: number
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

  it('each row carries the real F/G balances', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // +100 F registration

    const res = await get('/api/admin/users?q=0912345678', admin.token)
    const { users } = await res.json<ListUsersResponse>()
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ balanceF: 100, balanceG: 0 })
  })

  it('sort=f_asc / f_desc orders by F balance', async () => {
    const admin = await seedAdmin()
    const low = await registerUser(admin.referralCode, '0911111111', 'Low') // F = 100
    const high = await registerUser(admin.referralCode, '0922222222', 'High') // F = 100 + 300 = 400
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
       VALUES (?, ?, 'F', 'REFERRAL_SIGNUP_BONUS', 300, ?, ?)`,
    )
      .bind(crypto.randomUUID(), high.id, high.id, new Date().toISOString())
      .run()

    const asc = await (await get('/api/admin/users?sort=f_asc', admin.token)).json<ListUsersResponse>()
    const ascIds = asc.users.map((u) => u.id)
    expect(ascIds.indexOf(low.id)).toBeLessThan(ascIds.indexOf(high.id))

    const desc = await (await get('/api/admin/users?sort=f_desc', admin.token)).json<ListUsersResponse>()
    const descIds = desc.users.map((u) => u.id)
    expect(descIds.indexOf(high.id)).toBeLessThan(descIds.indexOf(low.id))
  })

  it('sort=g_asc / g_desc orders by G balance', async () => {
    const admin = await seedAdmin()
    const low = await registerUser(admin.referralCode, '0933333333', 'LowG')
    const high = await registerUser(admin.referralCode, '0944444444', 'HighG')
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
       VALUES (?, ?, 'G', 'MAINTENANCE_ACCRUAL', 100, 1, ?)`,
    )
      .bind(crypto.randomUUID(), high.id, new Date().toISOString())
      .run()

    const desc = await (await get('/api/admin/users?sort=g_desc', admin.token)).json<ListUsersResponse>()
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
