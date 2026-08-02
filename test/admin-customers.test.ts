import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, registerUser, seedAdmin } from './helpers'

// GET /api/admin/orders is the admin's customer list. Every row in it is an activated (APPROVED)
// customer — there is no approval queue, no CTV-facing create/submit, and no /api/orders router
// any more; the activation write path itself is covered by admin-activate-customer.test.ts.
describe('admin customer list', () => {
  it('is empty to start, and requires super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    expect((await get('/api/admin/orders')).status).toBe(401)
    expect((await get('/api/admin/orders', user.token)).status).toBe(403)

    const res = await get('/api/admin/orders', admin.token)
    expect(res.status).toBe(200)
    const body = await res.json<{ orders: unknown[]; total: number }>()
    expect(body.orders).toEqual([])
    expect(body.total).toBe(0)
  })

  it('lists activated customers, newest first, all already APPROVED', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Mot' })
    await activateCustomerFor(admin.token, a.id, { fullName: 'Khach Hai' })

    const res = await get('/api/admin/orders', admin.token)
    const { orders, total } = await res.json<{ orders: { fullName: string; status: string }[]; total: number }>()
    expect(total).toBe(2)
    expect(orders.map((o) => o.status)).toEqual(['APPROVED', 'APPROVED'])
    expect(orders.map((o) => o.fullName)).toEqual(['Khach Hai', 'Khach Mot'])
  })

  it('searches by customer name, phone or order code', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    await activateCustomerFor(admin.token, a.id, {
      fullName: 'Findable Person',
      phone: '0977000111',
      orderCode: 'FIND-001',
    })
    await activateCustomerFor(admin.token, a.id, { fullName: 'Someone Else', orderCode: 'OTHER-002' })

    const byName = await get('/api/admin/orders?q=Findable', admin.token)
    expect((await byName.json<{ total: number }>()).total).toBe(1)

    const byPhone = await get('/api/admin/orders?q=0977000111', admin.token)
    expect((await byPhone.json<{ total: number }>()).total).toBe(1)

    const byCode = await get('/api/admin/orders?q=FIND-001', admin.token)
    expect((await byCode.json<{ total: number }>()).total).toBe(1)

    const noMatch = await get('/api/admin/orders?q=nothing-matches-this', admin.token)
    expect((await noMatch.json<{ total: number }>()).total).toBe(0)
  })

  it('filters by userId, so the CTV detail page sees only that CTV\'s customers', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const b = await registerUser(admin.referralCode, '0912345679')
    await activateCustomerFor(admin.token, a.id, { fullName: 'Cua A' })
    await activateCustomerFor(admin.token, b.id, { fullName: 'Cua B' })

    const res = await get(`/api/admin/orders?userId=${a.id}`, admin.token)
    const { orders, total } = await res.json<{ orders: { fullName: string }[]; total: number }>()
    expect(total).toBe(1)
    expect(orders[0].fullName).toBe('Cua A')
  })

  it('paginates', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    for (let i = 0; i < 3; i++) await activateCustomerFor(admin.token, a.id, { fullName: `Khach ${i}` })

    const res = await get('/api/admin/orders?page=2&limit=2', admin.token)
    const { orders, total, page, limit } = await res.json<{
      orders: unknown[]
      total: number
      page: number
      limit: number
    }>()
    expect({ total, page, limit }).toEqual({ total: 3, page: 2, limit: 2 })
    expect(orders).toHaveLength(1)
  })

  it('rejects an invalid status filter', async () => {
    const admin = await seedAdmin()
    expect((await get('/api/admin/orders?status=NOPE', admin.token)).status).toBe(400)
  })
})

describe('the CTV order routes are gone', () => {
  it('404s the whole /api/orders router', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    // A CTV can no longer list, read, create, edit or submit orders — the router is unmounted.
    expect((await get('/api/orders', a.token)).status).toBe(404)
    expect((await get('/api/orders/any-id', a.token)).status).toBe(404)
  })
})
