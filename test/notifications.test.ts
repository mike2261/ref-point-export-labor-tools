import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, post, registerUser, seedAdmin } from './helpers'

interface ApiNotification {
  id: string
  type: string
  title: string
  body: string
  orderId: string | null
  ledgerId: string | null
  read: boolean
}

// Read a token's inbox via the public API (self-scoped to that user).
async function inbox(token: string, query = ''): Promise<ApiNotification[]> {
  const res = await get(`/api/notifications${query}`, token)
  expect(res.status).toBe(200)
  return (await res.json<{ notifications: ApiNotification[] }>()).notifications
}

async function unreadCount(token: string): Promise<number> {
  const res = await get('/api/notifications/unread-count', token)
  return (await res.json<{ count: number }>()).count
}

function typesOf(list: ApiNotification[]): string[] {
  return list.map((n) => n.type).sort()
}

// There is no order lifecycle left, so ORDER_CREATED / ORDER_APPROVED / ORDER_REJECTED /
// ORDER_NEEDS_REVISION are never generated any more (their builders are gone from
// lib/notifications.ts). Every order-shaped notification now comes from one admin action:
// customer activation, which deliberately sends the CTV ONE notification (typed REDEMPTION,
// since their reward is credited and netted out in the same batch) instead of two.
describe('notifications — generation', () => {
  it('customer activation sends the CTV exactly one notification, and the referrer their bonus notice', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const b = await registerUser(a.referralCode, '0987654321')

    await activateCustomerFor(admin.token, b.id, { fullName: 'Khach Cua B' })

    // b: one consolidated notification, linked to the redemption ledger row.
    const bInbox = await inbox(b.token)
    expect(typesOf(bInbox)).toEqual(['REDEMPTION'])
    expect(bInbox[0].body).toContain('Khach Cua B')
    expect(bInbox[0].ledgerId).not.toBeNull()

    // a (b's referrer): the signup bonus from b registering + the customer referral bonus.
    expect(typesOf(await inbox(a.token))).toEqual(['CUSTOMER_REFERRAL_BONUS', 'REFERRAL_SIGNUP_BONUS'])
  })

  it('no CUSTOMER_REFERRAL_BONUS notification when the referrer is the admin (A2)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    await activateCustomerFor(admin.token, a.id)

    expect((await inbox(admin.token)).some((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toBe(false)
  })

  it('registration under a USER referrer notifies them; an admin referrer gets nothing', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // referrer = admin → admin no notif
    expect((await inbox(admin.token)).some((n) => n.type === 'REFERRAL_SIGNUP_BONUS')).toBe(false)

    await registerUser(a.referralCode, '0987654321') // referrer = a (USER) → a notified
    const aBonus = (await inbox(a.token)).filter((n) => n.type === 'REFERRAL_SIGNUP_BONUS')
    expect(aBonus).toHaveLength(1)
    expect(aBonus[0].ledgerId).not.toBeNull()
  })

  it('redemption notifies the user of the deduction', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    // Unlocks redemption and settles F to 0 in the same call (already sends one REDEMPTION
    // notification) — top up by hand so there's something left for the manual redemption below.
    await activateCustomerFor(admin.token, a.id)
    await env.DB.prepare(
      `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
       VALUES (?, ?, 'F', 'REFERRAL_SIGNUP_BONUS', 20, ?, ?)`,
    )
      .bind(crypto.randomUUID(), a.id, a.id, new Date().toISOString())
      .run()

    const redeem = await post(
      '/api/admin/redemptions',
      { userId: a.id, f: 20, note: 'trả tiền mặt', idempotencyKey: 'redeem-1' },
      admin.token,
    )
    expect(redeem.status).toBe(201)

    // Two REDEMPTION notices now: the activation's own, plus this manual payout.
    const redemptions = (await inbox(a.token)).filter((n) => n.type === 'REDEMPTION')
    expect(redemptions).toHaveLength(2)
    const manual = redemptions.filter((n) => n.body.includes('20 điểm ví F'))
    expect(manual).toHaveLength(1)
    expect(manual[0].ledgerId).not.toBeNull()
  })
})

describe('notifications — atomicity (no orphans / duplicates)', () => {
  it('a replayed activation writes no second notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const key = crypto.randomUUID()
    const body = { userId: a.id, fullName: 'Khach', phone: '0977000111', orderCode: 'DUP-1', idempotencyKey: key }

    expect((await post('/api/admin/orders/activate', body, admin.token)).status).toBe(201)
    expect((await post('/api/admin/orders/activate', body, admin.token)).status).toBe(409)

    expect((await inbox(a.token)).filter((n) => n.type === 'REDEMPTION')).toHaveLength(1)
  })
})

describe('notifications — inbox endpoints', () => {
  it('requires auth', async () => {
    expect((await get('/api/notifications')).status).toBe(401)
    expect((await get('/api/notifications/unread-count')).status).toBe(401)
  })

  it('lists newest-first, filters unread, and counts unread', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Mot' })
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Hai' })

    const all = await inbox(a.token)
    expect(all.length).toBe(2)
    expect(all.every((n) => !n.read)).toBe(true)
    expect(await unreadCount(a.token)).toBe(2)

    const unread = await inbox(a.token, '?unread=true')
    expect(unread.length).toBe(2)
  })

  it('marks one read (idempotently) and returns 404 for another user\'s notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id)
    const [notif] = await inbox(a.token)

    // The admin (not the recipient) cannot mark a's notification.
    expect((await post(`/api/notifications/${notif.id}/read`, undefined, admin.token)).status).toBe(404)

    expect((await post(`/api/notifications/${notif.id}/read`, undefined, a.token)).status).toBe(200)
    // Idempotent: marking again still succeeds.
    expect((await post(`/api/notifications/${notif.id}/read`, undefined, a.token)).status).toBe(200)
    expect(await unreadCount(a.token)).toBe(0)
  })

  it('read-all flips every unread notification of the caller', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Mot' })
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Hai' })

    const res = await post('/api/notifications/read-all', undefined, a.token)
    expect(res.status).toBe(200)
    expect((await res.json<{ updated: number }>()).updated).toBe(2)
    expect(await unreadCount(a.token)).toBe(0)
  })
})
