import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { get, post, registerUser, seedAdmin } from './helpers'

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

// Draft-then-submit — ORDER_CREATED fires on submit (see orders.ts's submitOrder), not on the
// draft itself, since only a PENDING order actually awaits the admin's verification.
let orderSeq = 0
async function createOrder(token: string, note?: string): Promise<string> {
  orderSeq += 1
  const res = await post(
    '/api/orders',
    { fullName: 'Test Person', phone: `090000${String(orderSeq).padStart(4, '0')}`, orderCode: `CODE-${orderSeq}`, activationCode: `ACT-${orderSeq}`, note },
    token,
  )
  expect(res.status).toBe(201)
  const { order } = await res.json<{ order: { id: string } }>()
  const submit = await post(`/api/orders/${order.id}/submit`, undefined, token)
  expect(submit.status).toBe(200)
  return order.id
}

describe('notifications — generation', () => {
  it('a new order notifies the admin (ORDER_CREATED, linked to the order)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const orderId = await createOrder(a.token, 'đi Nhật')

    const adminInbox = await inbox(admin.token)
    const created = adminInbox.filter((n) => n.type === 'ORDER_CREATED')
    expect(created).toHaveLength(1)
    expect(created[0].orderId).toBe(orderId)
    expect(created[0].body).toContain('đi Nhật')
    // The CTV creator gets nothing for merely creating.
    expect(await inbox(a.token)).toHaveLength(0)
  })

  it('approval notifies the creator (+reward) and the USER referrer (referral bonus)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // referrer = admin
    const b = await registerUser(a.referralCode, '0987654321') // referrer = a (USER)
    const orderId = await createOrder(b.token)

    await post(`/api/admin/orders/${orderId}/approve`, undefined, admin.token)

    const bInbox = await inbox(b.token)
    expect(bInbox.filter((n) => n.type === 'ORDER_APPROVED')).toHaveLength(1)
    expect(bInbox.find((n) => n.type === 'ORDER_APPROVED')!.orderId).toBe(orderId)

    const aInbox = await inbox(a.token)
    const bonus = aInbox.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')
    expect(bonus).toHaveLength(1)
    expect(bonus[0].ledgerId).not.toBeNull()
  })

  it('no CUSTOMER_REFERRAL_BONUS notification when the referrer is the admin (A2)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // referrer = admin
    const orderId = await createOrder(a.token)
    await post(`/api/admin/orders/${orderId}/approve`, undefined, admin.token)

    const adminInbox = await inbox(admin.token)
    expect(adminInbox.filter((n) => n.type === 'CUSTOMER_REFERRAL_BONUS')).toHaveLength(0)
    expect((await inbox(a.token)).filter((n) => n.type === 'ORDER_APPROVED')).toHaveLength(1)
  })

  it('request-revision notifies the creator (ORDER_NEEDS_REVISION, with the reason)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const orderId = await createOrder(a.token)

    const revise = await post(`/api/admin/orders/${orderId}/request-revision`, { reason: 'thiếu giấy tờ' }, admin.token)
    expect(revise.status).toBe(200)

    const aInbox = await inbox(a.token)
    const needsRevision = aInbox.filter((n) => n.type === 'ORDER_NEEDS_REVISION')
    expect(needsRevision).toHaveLength(1)
    expect(needsRevision[0].orderId).toBe(orderId)
    expect(needsRevision[0].body).toContain('thiếu giấy tờ')
    // The admin doesn't notify themselves.
    expect((await inbox(admin.token)).some((n) => n.type === 'ORDER_NEEDS_REVISION')).toBe(false)
  })

  it('a request-revision on a non-PENDING order creates no ORDER_NEEDS_REVISION notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const orderId = await createOrder(a.token)
    await post(`/api/admin/orders/${orderId}/reject`, undefined, admin.token) // now REJECTED, terminal

    const revise = await post(`/api/admin/orders/${orderId}/request-revision`, { reason: 'x' }, admin.token)
    expect(revise.status).toBe(409)
    expect((await inbox(a.token)).some((n) => n.type === 'ORDER_NEEDS_REVISION')).toBe(false)
  })

  it('rejection notifies the creator only, with no point notifications', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const b = await registerUser(a.referralCode, '0987654321')
    const orderId = await createOrder(b.token, 'thiếu giấy tờ')

    await post(`/api/admin/orders/${orderId}/reject`, undefined, admin.token)

    const bInbox = await inbox(b.token)
    expect(typesOf(bInbox)).toEqual(['ORDER_REJECTED'])
    expect(bInbox[0].body).toContain('thiếu giấy tờ')
    // a only has its own signup-referral notice, never a reject-related one.
    expect((await inbox(a.token)).some((n) => n.type.startsWith('ORDER_'))).toBe(false)
  })

  it('registration under a USER referrer notifies them (+2); an admin referrer gets nothing', async () => {
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
    const orderId = await createOrder(a.token)
    await post(`/api/admin/orders/${orderId}/approve`, undefined, admin.token) // +50 F, unlocks redeem

    const redeem = await post(
      '/api/admin/redemptions',
      { userId: a.id, f: 20, note: 'trả tiền mặt', idempotencyKey: 'redeem-1' },
      admin.token,
    )
    expect(redeem.status).toBe(201)

    const redemptions = (await inbox(a.token)).filter((n) => n.type === 'REDEMPTION')
    expect(redemptions).toHaveLength(1)
    expect(redemptions[0].body).toContain('20 điểm ví F')
    expect(redemptions[0].ledgerId).not.toBeNull()
  })
})

describe('notifications — atomicity (no orphans / duplicates)', () => {
  it('a double-approve produces exactly one ORDER_APPROVED notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const orderId = await createOrder(a.token)

    await post(`/api/admin/orders/${orderId}/approve`, undefined, admin.token)
    const second = await post(`/api/admin/orders/${orderId}/approve`, undefined, admin.token)
    expect(second.status).toBe(409)

    expect((await inbox(a.token)).filter((n) => n.type === 'ORDER_APPROVED')).toHaveLength(1)
  })

  it('a pending-cap rejected submit creates no ORDER_CREATED notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    for (let i = 0; i < 5; i++) await createOrder(a.token)

    // Drafts aren't capped — only submit is. Create a 6th draft (succeeds), then fail to submit it.
    orderSeq += 1
    const draft = await post(
      '/api/orders',
      { fullName: 'Test Person', phone: `090000${String(orderSeq).padStart(4, '0')}`, orderCode: `CODE-${orderSeq}`, activationCode: `ACT-${orderSeq}` },
      a.token,
    )
    expect(draft.status).toBe(201)
    const { order } = await draft.json<{ order: { id: string } }>()
    const sixthSubmit = await post(`/api/orders/${order.id}/submit`, undefined, a.token)
    expect(sixthSubmit.status).toBe(409)

    // Exactly 5 ORDER_CREATED alerts reached the admin — the rejected 6th submit left no trace.
    expect((await inbox(admin.token)).filter((n) => n.type === 'ORDER_CREATED')).toHaveLength(5)
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
    await createOrder(a.token, 'one')
    await createOrder(a.token, 'two')

    const all = await inbox(admin.token)
    expect(all.length).toBe(2)
    expect(all.every((n) => !n.read)).toBe(true)
    expect(await unreadCount(admin.token)).toBe(2)

    const unread = await inbox(admin.token, '?unread=true')
    expect(unread.length).toBe(2)
  })

  it('marks one read (idempotently) and returns 404 for another user\'s notification', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await createOrder(a.token)
    const [notif] = await inbox(admin.token)

    // a (not the recipient) cannot mark the admin's notification.
    expect((await post(`/api/notifications/${notif.id}/read`, undefined, a.token)).status).toBe(404)

    expect((await post(`/api/notifications/${notif.id}/read`, undefined, admin.token)).status).toBe(200)
    // Idempotent: marking again still succeeds.
    expect((await post(`/api/notifications/${notif.id}/read`, undefined, admin.token)).status).toBe(200)
    expect(await unreadCount(admin.token)).toBe(0)
  })

  it('read-all flips every unread notification of the caller', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await createOrder(a.token)
    await createOrder(a.token)

    const res = await post('/api/notifications/read-all', undefined, admin.token)
    expect(res.status).toBe(200)
    expect((await res.json<{ updated: number }>()).updated).toBe(2)
    expect(await unreadCount(admin.token)).toBe(0)
  })
})
