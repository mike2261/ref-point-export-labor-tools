import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { createPendingOrder, get, post, registerUser, seedAdmin } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

// Same day-of-month as right now, `months` months earlier (UTC) — so anniversaryDate(registeredAt, months)
// lands exactly on today, letting tests place "now" at a precise point in a maintenance window
// without needing to fake the system clock.
function registeredMonthsAgo(months: number): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())).toISOString()
}

async function seedAccrual(userId: string, periodIndex: number, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO point_ledger (id, user_id, wallet, type, points, period_index, created_at)
     VALUES (?, ?, 'G', 'MAINTENANCE_ACCRUAL', 10, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, periodIndex, createdAt)
    .run()
}

describe('registration bonuses', () => {
  it('credits +10 to the new user and +2 to the referrer, atomically', async () => {
    const admin = await seedAdmin() // SUPER_ADMIN earns no points
    const a = await registerUser(admin.referralCode, '0912345678') // A +10
    const b = await registerUser(a.referralCode, '0987654321') // B +10, A +2

    const aBal = await (await get('/api/points/balances', a.token)).json<{ f: number; g: number; redemptionUnlocked: boolean }>()
    expect(aBal).toEqual({ f: 12, g: 0, redemptionUnlocked: false })

    const bBal = await (await get('/api/points/balances', b.token)).json<{ f: number }>()
    expect(bBal.f).toBe(10)
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
    const order = await createPendingOrder(a.token, '0900000001', { fullName: 'Nguyen Van Trace' })
    await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)

    const res = await get('/api/points/ledger?type=CUSTOMER_REWARD', a.token)
    const { entries } = await res.json<{ entries: { orderCode: string | null; orderFullName: string | null }[] }>()
    expect(entries).toHaveLength(1)
    expect(entries[0].orderCode).toBe(order.orderCode)
    expect(entries[0].orderFullName).toBe('Nguyen Van Trace')
  })

  it('q searches by the linked order\'s name/phone/code, excluding rows with no order', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createPendingOrder(a.token, '0900000001', { fullName: 'Findable Person' })
    await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)

    const byName = await get('/api/points/ledger?q=Findable', a.token)
    expect((await byName.json<{ total: number }>()).total).toBe(1)

    const byCode = await get(`/api/points/ledger?q=${order.orderCode}`, a.token)
    expect((await byCode.json<{ total: number }>()).total).toBe(1)

    const noMatch = await get('/api/points/ledger?q=nope-nothing-here', a.token)
    expect((await noMatch.json<{ total: number }>()).total).toBe(0)
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

describe('admin at-risk listing', () => {
  it('lists a user 2/3 into an empty window, and omits one with an in-window approved order', async () => {
    const admin = await seedAdmin()
    const atRisk = await registerUser(admin.referralCode, '0912345678')
    const safe = await registerUser(admin.referralCode, '0987654321')

    // Both "registered" 3 months ago with periods 1–3 already accrued: today sits exactly at the
    // 2/3 mark of period 4's window [anniv(1), anniv(4)).
    const registeredAt = registeredMonthsAgo(3)
    await env.DB
      .prepare('UPDATE users SET created_at = ? WHERE id IN (?, ?)')
      .bind(registeredAt, atRisk.id, safe.id)
      .run()
    for (const id of [atRisk.id, safe.id]) {
      for (let p = 1; p <= 3; p++) await seedAccrual(id, p, registeredAt)
    }

    // `safe` has an approved order landing inside the current window → not at risk.
    const order = await createPendingOrder(safe.token, '0900000001')
    await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)

    const res = await get('/api/admin/points/at-risk', admin.token)
    expect(res.status).toBe(200)
    const { users } = await res.json<{ users: { userId: string; periodIndex: number }[] }>()
    const ids = users.map((u) => u.userId)
    expect(ids).toContain(atRisk.id)
    expect(ids).not.toContain(safe.id)
    expect(users.find((u) => u.userId === atRisk.id)!.periodIndex).toBe(4)
  })

  it('requires SUPER_ADMIN', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    expect((await get('/api/admin/points/at-risk')).status).toBe(401)
    expect((await get('/api/admin/points/at-risk', a.token)).status).toBe(403)
  })
})
