import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, post, registerUser, seedAdmin } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

describe('registration bonuses', () => {
  it('credits the registration bonus to the new user and the referral bonus to the referrer, atomically', async () => {
    const admin = await seedAdmin() // SUPER_ADMIN earns no points
    const a = await registerUser(admin.referralCode, '0912345678') // A +100
    const b = await registerUser(a.referralCode, '0987654321') // B +100, A +20

    const aBal = await (await get('/api/points/balances', a.token)).json<{ f: number; g: number; redemptionUnlocked: boolean }>()
    expect(aBal).toEqual({ f: 120, g: 0, redemptionUnlocked: false })

    const bBal = await (await get('/api/points/balances', b.token)).json<{ f: number }>()
    expect(bBal.f).toBe(100)
  })

  it('pays no REFERRAL_SIGNUP_BONUS when the referrer is the SUPER_ADMIN (A2)', async () => {
    const admin = await seedAdmin()
    await registerUser(admin.referralCode, '0912345678') // registers directly under the admin
    const res = await get(`/api/admin/ledger?userId=${admin.id}&type=REFERRAL_SIGNUP_BONUS`, admin.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)
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
    await registerUser(a.referralCode, '0987654321') // gives A a REFERRAL_SIGNUP_BONUS row

    const res = await get('/api/points/ledger', a.token)
    const { entries, total } = await res.json<{ entries: { userId: string; type: string }[]; total: number }>()
    expect(total).toBe(2) // REGISTRATION_BONUS + REFERRAL_SIGNUP_BONUS
    expect(entries.every((e) => e.userId === a.id)).toBe(true)
  })

  it('filters by wallet and rejects an invalid wallet', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    const gOnly = await get('/api/points/ledger?wallet=G', a.token)
    expect((await gOnly.json<{ total: number }>()).total).toBe(0) // all registration rows are F

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
    const order = await activateCustomerFor(admin.token, a.id, { fullName: 'Nguyen Van Trace' })

    const res = await get('/api/points/ledger?type=CUSTOMER_REWARD', a.token)
    const { entries } = await res.json<{ entries: { orderCode: string | null; orderFullName: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderCode).toBe(order.orderCode)
    expect(entries[0].orderFullName).toBe('Nguyen Van Trace')
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

  it('a CUSTOMER_REFERRAL_BONUS row exposes the name of the referred CTV who closed the customer', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    const b = await registerUser(a.referralCode, '0987654321', 'CTV B Duoc Gioi Thieu')
    await activateCustomerFor(admin.token, b.id, { fullName: 'Khach Cua B' })

    const res = await get('/api/points/ledger?type=CUSTOMER_REFERRAL_BONUS', a.token)
    const { entries } = await res.json<{ entries: { orderOwnerFullName: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderOwnerFullName).toBe('CTV B Duoc Gioi Thieu')
  })

  it('a REFERRAL_SIGNUP_BONUS row exposes the referred person\'s name to the referrer, not just admin', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    await registerUser(a.referralCode, '0987654321', 'Referred B')

    const res = await get('/api/points/ledger?type=REFERRAL_SIGNUP_BONUS', a.token)
    const { entries } = await res.json<{ entries: { subjectUserId: string | null; subjectUserFullName: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].subjectUserId).not.toBeNull()
    expect(entries[0].subjectUserFullName).toBe('Referred B')
  })
})

describe('admin ledger: subjectUserFullName traceability', () => {
  it('a REGISTRATION_BONUS row on the referrer\'s REFERRAL_SIGNUP_BONUS traces to who signed up', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678', 'Referrer A')
    await registerUser(a.referralCode, '0987654321', 'Referred B')

    const res = await get(`/api/admin/ledger?userId=${a.id}&type=REFERRAL_SIGNUP_BONUS`, admin.token)
    const { entries } = await res.json<{ entries: { subjectUserFullName: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].subjectUserFullName).toBe('Referred B')
  })
})
