import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { createDraftOrder, createPendingOrder, get, patch, post, registerUser, seedAdmin } from './helpers'

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM point_ledger').first<{ n: number }>()
  return row?.n ?? 0
}

async function balanceF(token: string): Promise<number> {
  const res = await get('/api/points/balances', token)
  const { f } = await res.json<{ f: number }>()
  return f
}

describe('order creation & draft editing', () => {
  it('creates a DRAFT with a customer, order code, and activation code', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createDraftOrder(a.token, '0900000001', { customerFullName: 'Nguyen Van A' })

    expect(order.status).toBe('DRAFT')
    expect(order.customer.fullName).toBe('Nguyen Van A')
    expect(order.customer.phone).toBe('0900000001')
    expect(order.orderCode).toMatch(/^XKLD-\d{6}-\d{6}$/)
    expect(order.activationCode).toMatch(/^ACT-/)
  })

  it('reuses the same customer for a repeat submission by the same CTV+phone', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const first = await createDraftOrder(a.token, '0900000001', { customerFullName: 'Nguyen Van A' })
    const second = await createDraftOrder(a.token, '0900000001', { customerFullName: 'Nguyen Van A (updated)' })

    expect(second.customer.id).toBe(first.customer.id)
    expect(second.customer.fullName).toBe('Nguyen Van A (updated)') // upsert refreshes the name
    expect(second.orderCode).not.toBe(first.orderCode) // still two distinct orders
  })

  it('PATCH edits a DRAFT order', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createDraftOrder(a.token, '0900000001')

    const res = await patch(`/api/orders/${order.id}`, { note: 'updated note', customerFullName: 'Renamed' }, a.token)
    expect(res.status).toBe(200)
    const { order: updated } = await res.json<{ order: { note: string; customer: { fullName: string } } }>()
    expect(updated.note).toBe('updated note')
    expect(updated.customer.fullName).toBe('Renamed')
  })

  it('PATCH on a PENDING order is 422 LOCKED', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createPendingOrder(a.token, '0900000001')

    const res = await patch(`/api/orders/${order.id}`, { note: 'nope' }, a.token)
    expect(res.status).toBe(422)
    expect((await res.json<{ code: string }>()).code).toBe('LOCKED')
  })

  it('SUPER_ADMIN cannot create orders (403)', async () => {
    const admin = await seedAdmin()
    const res = await post(
      '/api/orders',
      { customerFullName: 'X', customerPhone: '0900000001', note: 'x' },
      admin.token,
    )
    expect(res.status).toBe(403)
  })
})

describe('submit & the pending cap', () => {
  it('submits a DRAFT to PENDING, enforcing the 5-pending cap', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')

    for (let i = 0; i < 5; i++) {
      const order = await createDraftOrder(a.token, `090000000${i}`)
      const res = await post(`/api/orders/${order.id}/submit`, undefined, a.token)
      expect(res.status).toBe(200)
    }
    const sixthDraft = await createDraftOrder(a.token, '0900000009')
    const sixth = await post(`/api/orders/${sixthDraft.id}/submit`, undefined, a.token)
    expect(sixth.status).toBe(409)
    expect((await sixth.json<{ code: string }>()).code).toBe('PENDING_LIMIT')
  })

  it('drafts do not count against the pending cap', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    for (let i = 0; i < 8; i++) {
      const order = await createDraftOrder(a.token, `090000000${i}`)
      expect(order.status).toBe('DRAFT')
    }
  })

  it('submitting an already-PENDING order is 409 NOT_EDITABLE', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createPendingOrder(a.token, '0900000001')
    const res = await post(`/api/orders/${order.id}/submit`, undefined, a.token)
    expect(res.status).toBe(409)
    expect((await res.json<{ code: string }>()).code).toBe('NOT_EDITABLE')
  })
})

describe('approve / reject', () => {
  it('approve pays +50 creator / +10 referrer to the F wallet', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // A: +10 reg, +2 (B signs up)
    const b = await registerUser(a.referralCode, '0987654321') // B: +10 reg

    const order = await createPendingOrder(b.token, '0900000001')
    const approve = await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)
    expect(approve.status).toBe(200)
    expect((await approve.json<{ order: { status: string } }>()).order.status).toBe('APPROVED')

    expect(await balanceF(b.token)).toBe(60) // 10 + 50
    expect(await balanceF(a.token)).toBe(22) // 10 + 2 + 10
  })

  it('approval pays no referrer bonus when the creator\'s referrer is the admin (A2)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678') // referrer = admin
    const order = await createPendingOrder(a.token, '0900000001')
    await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)

    expect(await balanceF(a.token)).toBe(60) // 10 registration + 50 reward; no admin referral leg
    const res = await get(`/api/admin/ledger?userId=${admin.id}&type=CUSTOMER_REFERRAL_BONUS`, admin.token)
    expect((await res.json<{ total: number }>()).total).toBe(0)
  })

  it('double-approve is a 409 with no extra ledger rows', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const b = await registerUser(a.referralCode, '0987654321')
    const order = await createPendingOrder(b.token, '0900000001')

    await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)
    const countAfterFirst = await ledgerCount()

    const second = await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)
    expect(second.status).toBe(409)
    expect((await second.json<{ code: string }>()).code).toBe('ALREADY_DECIDED')
    expect(await ledgerCount()).toBe(countAfterFirst)
  })

  it('reject pays nothing, and approve-after-reject is a 409', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const b = await registerUser(a.referralCode, '0987654321')
    const order = await createPendingOrder(b.token, '0900000001')

    const reject = await post(`/api/admin/orders/${order.id}/reject`, undefined, admin.token)
    expect(reject.status).toBe(200)
    expect(await balanceF(b.token)).toBe(10) // registration only, no reward

    const approve = await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)
    expect(approve.status).toBe(409)
  })

  it('a rejected order is terminal; the CTV retries via a NEW order for the same customer', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const first = await createPendingOrder(a.token, '0900000001', { customerFullName: 'A' })
    await post(`/api/admin/orders/${first.id}/reject`, undefined, admin.token)

    const retry = await createPendingOrder(a.token, '0900000001', { customerFullName: 'A' })
    expect(retry.customer.id).toBe(first.customer.id) // same customer, reused
    expect(retry.id).not.toBe(first.id) // different order

    const approve = await post(`/api/admin/orders/${retry.id}/approve`, undefined, admin.token)
    expect(approve.status).toBe(200)
    expect(await balanceF(a.token)).toBe(60)
  })

  it('a second order for an already-rewarded customer cannot also be approved (409)', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const first = await createPendingOrder(a.token, '0900000001', { customerFullName: 'A' })
    await post(`/api/admin/orders/${first.id}/approve`, undefined, admin.token)

    // A second, independent order for the SAME customer (e.g. created before the first was decided)
    const second = await createPendingOrder(a.token, '0900000001', { customerFullName: 'A' })
    const approve = await post(`/api/admin/orders/${second.id}/approve`, undefined, admin.token)
    expect(approve.status).toBe(409)
    expect((await approve.json<{ code: string }>()).code).toBe('CUSTOMER_ALREADY_REWARDED')
    expect(await balanceF(a.token)).toBe(60) // unchanged — no double payout
  })

  it('IDOR: a user fetching another user\'s order gets 404, not 403', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const b = await registerUser(admin.referralCode, '0987654321')
    const order = await createDraftOrder(a.token, '0900000001')

    const res = await get(`/api/orders/${order.id}`, b.token)
    expect(res.status).toBe(404)
  })
})

describe('revision loop', () => {
  it('admin requests a revision; CTV edits and resubmits; admin approves', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createPendingOrder(a.token, '0900000001', { customerFullName: 'Typo Nam' })

    const revise = await post(
      `/api/admin/orders/${order.id}/request-revision`,
      { reason: 'wrong phone number' },
      admin.token,
    )
    expect(revise.status).toBe(200)
    const { order: needsRevision } = await revise.json<{ order: { status: string; revisionReason: string } }>()
    expect(needsRevision.status).toBe('NEEDS_REVISION')
    expect(needsRevision.revisionReason).toBe('wrong phone number')

    const edited = await patch(`/api/orders/${order.id}`, { customerFullName: 'Van Nam' }, a.token)
    expect(edited.status).toBe(200)

    const resubmit = await post(`/api/orders/${order.id}/submit`, undefined, a.token)
    expect(resubmit.status).toBe(200)
    const { order: resubmitted } = await resubmit.json<{ order: { status: string; revisionReason: string | null } }>()
    expect(resubmitted.status).toBe('PENDING')
    expect(resubmitted.revisionReason).toBeNull() // cleared on resubmit

    const approve = await post(`/api/admin/orders/${order.id}/approve`, undefined, admin.token)
    expect(approve.status).toBe(200)
  })

  it('request-revision on a non-PENDING order is 409 NOT_PENDING', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createDraftOrder(a.token, '0900000001')

    const res = await post(`/api/admin/orders/${order.id}/request-revision`, { reason: 'x' }, admin.token)
    expect(res.status).toBe(409)
    expect((await res.json<{ code: string }>()).code).toBe('NOT_PENDING')
  })

  it('request-revision requires a non-empty reason', async () => {
    const admin = await seedAdmin()
    const a = await registerUser(admin.referralCode, '0912345678')
    const order = await createPendingOrder(a.token, '0900000001')

    const res = await post(`/api/admin/orders/${order.id}/request-revision`, { reason: '' }, admin.token)
    expect(res.status).toBe(400)
  })
})
