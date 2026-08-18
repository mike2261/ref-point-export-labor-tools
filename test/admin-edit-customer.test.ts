import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { activateCustomerFor, get, patch, registerUser, seedAdmin, type OrderShape } from './helpers'

// PATCH /api/admin/orders/:id — admin sửa lại thông tin khách hàng đã kích hoạt (gõ nhầm tên,
// sai số, sai mã đơn). Chỉ sửa 3 ô trên form kích hoạt; CTV và mọi dòng điểm giữ nguyên.
describe('PATCH /api/admin/orders/:id', () => {
  it('updates the customer name, phone and order code, keeping activationCode in step', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, ctv.id, {
      fullName: 'Nguyen Van Sai',
      phone: '0977000111',
      orderCode: 'DH-SAI-01',
    })

    const res = await patch(
      `/api/admin/orders/${order.id}`,
      { fullName: 'Nguyễn Văn Đúng', phone: '0977000222', orderCode: 'DH-DUNG-01' },
      admin.token,
    )
    expect(res.status).toBe(200)
    const updated = (await res.json<{ order: OrderShape }>()).order
    expect(updated).toMatchObject({
      id: order.id,
      fullName: 'Nguyễn Văn Đúng',
      phone: '0977000222',
      orderCode: 'DH-DUNG-01',
      activationCode: 'DH-DUNG-01',
      status: 'APPROVED',
    })

    // Danh sách khách hàng đọc ra bản đã sửa, và tìm được theo mã đơn mới.
    const list = await get('/api/admin/orders?q=DH-DUNG-01', admin.token)
    const { orders, total } = await list.json<{ orders: OrderShape[]; total: number }>()
    expect(total).toBe(1)
    expect(orders[0]!.fullName).toBe('Nguyễn Văn Đúng')
  })

  it('leaves the CTV, the ledger and the notifications untouched', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, ctv.id)

    const ledgerBefore = await env.DB.prepare(`SELECT id, user_id, wallet, type, points FROM point_ledger ORDER BY id`).all()
    const notifsBefore = await env.DB.prepare(`SELECT id, user_id, body FROM notifications ORDER BY id`).all()

    const res = await patch(
      `/api/admin/orders/${order.id}`,
      { fullName: 'Ten Moi', phone: '0966000333', orderCode: 'MA-MOI-01' },
      admin.token,
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ order: OrderShape }>()).order.userId).toBe(ctv.id)

    expect((await env.DB.prepare(`SELECT id, user_id, wallet, type, points FROM point_ledger ORDER BY id`).all()).results)
      .toEqual(ledgerBefore.results)
    expect((await env.DB.prepare(`SELECT id, user_id, body FROM notifications ORDER BY id`).all()).results)
      .toEqual(notifsBefore.results)
  })

  it('404s an unknown order and rejects a bad body or unknown key', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, ctv.id)

    const missing = await patch(
      '/api/admin/orders/does-not-exist',
      { fullName: 'Ten Moi', phone: '0966000333', orderCode: 'MA-MOI-01' },
      admin.token,
    )
    expect(missing.status).toBe(404)

    // customerPhone cố tình là free text (xem lib/validators.ts) — chỉ rỗng mới bị chặn.
    const emptyPhone = await patch(
      `/api/admin/orders/${order.id}`,
      { fullName: 'Ten Moi', phone: '   ', orderCode: 'MA-MOI-01' },
      admin.token,
    )
    expect(emptyPhone.status).toBe(400)

    const emptyName = await patch(
      `/api/admin/orders/${order.id}`,
      { fullName: '  ', phone: '0966000333', orderCode: 'MA-MOI-01' },
      admin.token,
    )
    expect(emptyName.status).toBe(400)

    const extraKey = await patch(
      `/api/admin/orders/${order.id}`,
      { fullName: 'Ten Moi', phone: '0966000333', orderCode: 'MA-MOI-01', userId: 'someone-else' },
      admin.token,
    )
    expect(extraKey.status).toBe(400)
  })

  it('requires super admin', async () => {
    const admin = await seedAdmin()
    const ctv = await registerUser(admin.referralCode, '0912345678')
    const order = await activateCustomerFor(admin.token, ctv.id)
    const body = { fullName: 'Ten Moi', phone: '0966000333', orderCode: 'MA-MOI-01' }

    expect((await patch(`/api/admin/orders/${order.id}`, body)).status).toBe(401)
    expect((await patch(`/api/admin/orders/${order.id}`, body, ctv.token)).status).toBe(403)
  })
})
