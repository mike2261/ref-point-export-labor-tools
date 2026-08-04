import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'

// These tests pin the D1 error-message substrings that lib/ matches on to classify constraint
// violations: isDuplicateRedemption (redemptions.ts), isDuplicateBonusGrant (bonuses.ts), and
// translateConflict (users.ts). Those detectors are correct against today's D1 behavior, but a
// Wrangler/D1 update that reworded constraint errors would silently turn a handled conflict into
// a 500. Asserting the raw message shape here makes that regression loud instead (Mike, PR review).

async function seedUser(id: string, phone: string, role = 'USER', referralCode = phone): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, full_name, phone, password_hash, role, referrer_id, referral_code, is_active, created_at)
     VALUES (?, 'U', ?, 'x', ?, NULL, ?, 1, '2026-01-01T00:00:00.000Z')`,
  )
    .bind(id, phone, role, referralCode)
    .run()
}

async function captureError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected the statement to throw a constraint violation')
}

describe('D1 constraint error message shapes (pinning the string-match detectors)', () => {
  it('R4 uq_ledger_idem: a duplicate (idempotency_key, wallet) is named in the error', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111111')
    const key = crypto.randomUUID()
    const row = (id: string) =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, idempotency_key, created_at)
         VALUES (?, ?, 'F', 'REDEMPTION', -10, ?, '2026-01-01T00:00:00.000Z')`,
      ).bind(id, uid, key)

    await row(crypto.randomUUID()).run()
    const msg = await captureError(() => row(crypto.randomUUID()).run())
    expect(msg).toContain('UNIQUE constraint failed')
    expect(msg).toMatch(/uq_ledger_idem|idempotency_key/) // isDuplicateRedemption
  })

  it('R5 uq_bonus_grants_idem: a duplicate idempotency_key is named in the error', async () => {
    const adminId = crypto.randomUUID()
    await seedUser(adminId, '0911111117', 'SUPER_ADMIN', '0911111117')
    const key = crypto.randomUUID()
    const row = (id: string) =>
      env.DB.prepare(
        `INSERT INTO bonus_grants (id, idempotency_key, scope, amount, content, recipient_count, created_by, created_at)
         VALUES (?, ?, 'ALL', 10, 'x', 0, ?, '2026-01-01T00:00:00.000Z')`,
      ).bind(id, key, adminId)

    await row(crypto.randomUUID()).run()
    const msg = await captureError(() => row(crypto.randomUUID()).run())
    expect(msg).toContain('UNIQUE constraint failed')
    expect(msg).toMatch(/uq_bonus_grants_idem|idempotency_key/) // isDuplicateBonusGrant
  })

  it('users.phone: a duplicate phone is named in the error', async () => {
    await seedUser(crypto.randomUUID(), '0911111113', 'USER', '0911111113')
    // Distinct referral_code so only the phone unique index collides.
    const msg = await captureError(() => seedUser(crypto.randomUUID(), '0911111113', 'USER', 'distinct-code'))
    expect(msg).toContain('UNIQUE constraint failed')
    expect(msg).toMatch(/users\.phone/) // translateConflict → ConflictError('phone')
  })

  it('one_super_admin: a second super admin is named in the error', async () => {
    await seedUser(crypto.randomUUID(), '0911111114', 'SUPER_ADMIN', '0911111114')
    const msg = await captureError(() => seedUser(crypto.randomUUID(), '0911111115', 'SUPER_ADMIN', '0911111115'))
    expect(msg).toContain('UNIQUE constraint failed')
    expect(msg).toMatch(/one_super_admin|users\.role/) // translateConflict → ConflictError('role')
  })
})

describe('point_ledger ADMIN_BONUS CHECK constraints', () => {
  it('rejects an ADMIN_BONUS row with no bonus_grant_id', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111118')
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, created_at)
         VALUES (?, ?, 'G', 'ADMIN_BONUS', 10, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })

  it('rejects an ADMIN_BONUS row in wallet F', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111119')
    const adminId = crypto.randomUUID()
    await seedUser(adminId, '0911111120', 'SUPER_ADMIN', '0911111120')
    const grantId = crypto.randomUUID()
    await env.DB
      .prepare(
        `INSERT INTO bonus_grants (id, idempotency_key, scope, amount, content, recipient_count, created_by, created_at)
         VALUES (?, ?, 'ALL', 10, 'x', 0, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(grantId, crypto.randomUUID(), adminId)
      .run()
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, bonus_grant_id, created_at)
         VALUES (?, ?, 'F', 'ADMIN_BONUS', 10, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, grantId)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })
})

describe('point_ledger wallet A/B/C CHECK constraints', () => {
  it('accepts a CUSTOMER_REFERRAL_BONUS row only in wallet A', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111121')
    const orderId = crypto.randomUUID()
    await env.DB
      .prepare(`INSERT INTO orders (id, user_id, full_name, phone, order_code, activation_code, status, decided_by, decided_at, created_at, updated_at)
                VALUES (?, ?, 'C', '0900000001', 'OC-1', 'OC-1', 'APPROVED', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .bind(orderId, uid, uid)
      .run()

    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         VALUES (?, ?, 'B', 'CUSTOMER_REFERRAL_BONUS', 100, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, orderId)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')

    // The same row in wallet A succeeds.
    await env.DB
      .prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, order_id, created_at)
         VALUES (?, ?, 'A', 'CUSTOMER_REFERRAL_BONUS', 100, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(crypto.randomUUID(), uid, orderId)
      .run()
  })

  it('rejects wallet F/G entirely — only A/B/C are valid', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111122')
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
         VALUES (?, ?, 'F', 'REGISTRATION_BONUS', 100, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, uid)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })

  it('rejects REFERRAL_SIGNUP_BONUS as an unknown type — it no longer exists', async () => {
    const uid = crypto.randomUUID()
    await seedUser(uid, '0911111123')
    const msg = await captureError(() =>
      env.DB.prepare(
        `INSERT INTO point_ledger (id, user_id, wallet, type, points, subject_user_id, created_at)
         VALUES (?, ?, 'B', 'REFERRAL_SIGNUP_BONUS', 20, ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(crypto.randomUUID(), uid, uid)
        .run(),
    )
    expect(msg).toContain('CHECK constraint failed')
  })
})
