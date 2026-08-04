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
    const b = await registerUser(a.referralCode, '0987654321', 'Nguyen CTV B')

    await activateCustomerFor(admin.token, b.id, { fullName: 'Khach Cua B' })

    // b: their own REGISTRATION_BONUS from signing up, plus one consolidated activation
    // notification linked to the redemption ledger row.
    const bInbox = await inbox(b.token)
    expect(typesOf(bInbox)).toEqual(['REDEMPTION', 'REGISTRATION_BONUS'])
    const bActivation = bInbox.find((n) => n.type === 'REDEMPTION')
    expect(bActivation?.body).toContain('Khach Cua B')
    expect(bActivation?.ledgerId).not.toBeNull()

    // a (b's referrer): their own REGISTRATION_BONUS, and the customer referral bonus (wallet A),
    // which must name b (the CTV a referred who actually closed the customer) so a can trace it.
    // No REFERRAL_SIGNUP_BONUS — registering under someone no longer notifies/pays the referrer.
    const aInbox = await inbox(a.token)
    expect(typesOf(aInbox)).toEqual(['CUSTOMER_REFERRAL_BONUS', 'REGISTRATION_BONUS'])
    const referralBonus = aInbox.find((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')
    expect(referralBonus?.body).toContain('Nguyen CTV B')
  })

  it('no CUSTOMER_REFERRAL_BONUS notification when the referrer is the admin (A2)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    await activateCustomerFor(admin.token, a.id)

    expect((await inbox(admin.token)).some((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toBe(false)
  })

  // Manual "Đổi điểm" (POST /api/admin/redemptions) no longer exists — activation is now the
  // only writer of REDEMPTION rows, and its one-notification behavior is covered by
  // admin-activate-customer.test.ts.
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

    // registration's own REGISTRATION_BONUS + two activations' REDEMPTION notices.
    const all = await inbox(a.token)
    expect(all.length).toBe(3)
    expect(all.every((n) => !n.read)).toBe(true)
    expect(await unreadCount(a.token)).toBe(3)

    const unread = await inbox(a.token, '?unread=true')
    expect(unread.length).toBe(3)
  })

  it('marks one read (idempotently) and returns 404 for another user\'s notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id)
    // Newest-first: the activation's REDEMPTION notice, then registration's REGISTRATION_BONUS.
    const [notif] = await inbox(a.token)

    // The admin (not the recipient) cannot mark a's notification.
    expect((await post(`/api/notifications/${notif.id}/read`, undefined, admin.token)).status).toBe(404)

    expect((await post(`/api/notifications/${notif.id}/read`, undefined, a.token)).status).toBe(200)
    // Idempotent: marking again still succeeds.
    expect((await post(`/api/notifications/${notif.id}/read`, undefined, a.token)).status).toBe(200)
    // The registration notification is still unread — only `notif` was marked.
    expect(await unreadCount(a.token)).toBe(1)
  })

  it('read-all flips every unread notification of the caller', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Mot' })
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Hai' })

    // registration's own REGISTRATION_BONUS + two activations' REDEMPTION notices.
    const res = await post('/api/notifications/read-all', undefined, a.token)
    expect(res.status).toBe(200)
    expect((await res.json<{ updated: number }>()).updated).toBe(3)
    expect(await unreadCount(a.token)).toBe(0)
  })
})
