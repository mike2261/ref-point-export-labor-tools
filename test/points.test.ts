import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, post, registerUser, seedAdmin } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

describe('registration bonuses', () => {
  it('credits only the registrant\'s own registration bonus — referring someone earns nothing on its own', async () => {
    const admin = await seedAdmin() // SUPER_ADMIN earns no points
    const a = await registerUser(admin.referralCode, '0912345678') // A +100
    const b = await registerUser(a.referralCode, '0987654321') // B +100, A earns nothing

    const aBal = await (await get('/api/points/balances', a.token)).json<{ a: number; b: number; c: number; redemptionUnlocked: boolean }>()
    expect(aBal).toEqual({ a: 0, b: 100, c: 0, redemptionUnlocked: false })

    const bBal = await (await get('/api/points/balances', b.token)).json<{ b: number }>()
    expect(bBal.b).toBe(100)
  })

  it('a duplicate-phone registration is a 409 and leaves no orphan ledger rows', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678')
    const before = await ledgerCount()

    const dup = await post('/api/auth/register', {
      fullName: 'Dup', phone: '0912345678', password: 'userpass123', referralCode: admin.referralCode,
    })
    expect(dup.status).toBe(409)
    expect(await ledgerCount()).toBe(before)
  })
})

describe('ledger listing', () => {
  it('is self-scoped — a user never sees another user\'s rows', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await registerUser(a.referralCode, '0987654321') // no longer gives A any row

    const res = await get('/api/points/ledger', a.token)
    const { entries, total } = await res.json<{ entries: { userId: string; type: string }[]; total: number }>()
    expect(total).toBe(1) // just A's own REGISTRATION_BONUS
    expect(entries.every((e) => e.userId === a.id)).toBe(true)
  })

  it('filters by wallet and rejects an invalid wallet', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    const cOnly = await get('/api/points/ledger?wallet=C', a.token)
    expect((await cOnly.json<{ total: number }>()).total).toBe(0) // registration rows are wallet B

    const bad = await get('/api/points/ledger?wallet=X', a.token)
    expect(bad.status).toBe(400)
  })

  it('filters by direction (credit/debit) and rejects an invalid one', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // REGISTRATION_BONUS, a credit

    const credits = await get('/api/points/ledger?direction=credit', a.token)
    expect((await credits.json<{ total: number }>()).total).toBe(1)
    const debits = await get('/api/points/ledger?direction=debit', a.token)
    expect((await debits.json<{ total: number }>()).total).toBe(0)

    const bad = await get('/api/points/ledger?direction=sideways', a.token)
    expect(bad.status).toBe(400)
  })

  it('a CUSTOMER_REWARD row traces back to the order (orderCode/orderFullName)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, a.id, { fullName: 'Nguyen Van Trace', phone: '0988877766' })

    const res = await get('/api/points/ledger?type=CUSTOMER_REWARD', a.token)
    const { entries } = await res.json<{ entries: { orderCode: string | null; orderFullName: string | null; orderPhone: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderCode).toBe(order.orderCode)
    expect(entries[0].orderFullName).toBe('Nguyen Van Trace')
    expect(entries[0].orderPhone).toBe('0988877766')
  })

  it('q searches by the linked order\'s name/phone/code, excluding rows with no order', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, a.id, { fullName: 'Findable Person' })

    const byName = await get('/api/points/ledger?q=Findable', a.token)
    expect((await byName.json<{ total: number }>()).total).toBe(1)

    const byCode = await get(`/api/points/ledger?q=${order.orderCode}`, a.token)
    expect((await byCode.json<{ total: number }>()).total).toBe(1)

    const noMatch = await get('/api/points/ledger?q=nope-nothing-here', a.token)
    expect((await noMatch.json<{ total: number }>()).total).toBe(0)
  })

  it('a CUSTOMER_REFERRAL_BONUS row exposes the name of the referred CTV who closed the customer, and lands in wallet A', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    const b = await registerUser(a.referralCode, '0987654321', 'CTV B Duoc Gioi Thieu')
    await activateCustomerFor(admin.token, b.id, { fullName: 'Khach Cua B' })

    const res = await get('/api/points/ledger?type=CUSTOMER_REFERRAL_BONUS', a.token)
    const { entries } = await res.json<{ entries: { orderOwnerFullName: string | null; wallet: string }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderOwnerFullName).toBe('CTV B Duoc Gioi Thieu')
    expect(entries[0].wallet).toBe('A')

    const aBal = await (await get('/api/points/balances', a.token)).json<{ a: number }>()
    expect(aBal.a).toBe(100)
  })
})

describe('GET /api/points/referred-ctvs', () => {
  it('lists only the caller\'s direct referrals, newest first', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    await registerUser(a.referralCode, '0911111111', 'Referred One')
    await registerUser(a.referralCode, '0911111112', 'Referred Two')
    const other = await registerUser(admin.referralCode, '0911111113', 'Unrelated')
    await registerUser(other.referralCode, '0911111114', 'Someone Else\'s Referral')

    const res = await get('/api/points/referred-ctvs', a.token)
    expect(res.status).toBe(200)
    const { users, total } = await res.json<{ users: { fullName: string }[]; total: number }>()
    expect(total).toBe(2)
    expect(users.map((u) => u.fullName)).toEqual(['Referred Two', 'Referred One'])
  })

  it('is empty for a CTV with no referrals, and requires auth', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    const res = await get('/api/points/referred-ctvs', a.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)

    expect((await get('/api/points/referred-ctvs')).status).toBe(401)
  })
})

describe('POST /api/points/referred-ctvs', () => {
  it('lets a CTV create a new CTV referred by themselves, on the default password', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')

    const res = await post(
      '/api/points/referred-ctvs',
      { fullName: 'New Downstream CTV', phone: '0922222222' },
      a.token,
    )
    expect(res.status).toBe(201)
    const { user } = await res.json<{ user: { id: string; fullName: string; phone: string; referrerId: string } }>()
    expect(user.fullName).toBe('New Downstream CTV')
    expect(user.referrerId).toBe(a.id)

    // Logs in on the shared default temporary password, same as an admin-created root user.
    const login = await post('/api/auth/login', { phone: '0922222222', password: '12345678' })
    expect(login.status).toBe(200)

    // Shows up in the referrer's own referred-ctvs list.
    const list = await get('/api/points/referred-ctvs', a.token)
    const { total } = await list.json<{ total: number }>()
    expect(total).toBe(1)
  })

  it('rejects a duplicate phone with 409, and requires auth', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    const dup = await post('/api/points/referred-ctvs', { fullName: 'Dup', phone: '0912345678' }, a.token)
    expect(dup.status).toBe(409)

    expect(
      (await post('/api/points/referred-ctvs', { fullName: 'X', phone: '0933333333' })).status,
    ).toBe(401)
  })
})
