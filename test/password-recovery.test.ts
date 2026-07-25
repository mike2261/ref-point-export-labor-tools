import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { ADMIN_PASSWORD, ADMIN_PHONE, authToken, get, post, registerUser, seedAdmin } from './helpers'
import { TEMPORARY_PASSWORD } from '../src/lib/users'

describe('password change', () => {
  it('changes the password and revokes the token that performed the change', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    const changed = await post('/api/auth/change-password', {
      currentPassword: 'userpass123',
      newPassword: 'newpass123',
      confirmPassword: 'newpass123',
    }, user.token)
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ ok: true, reauthenticationRequired: true })

    expect((await get('/api/auth/me', user.token)).status).toBe(401)
    expect((await post('/api/auth/login', { phone: '0912345678', password: 'userpass123' })).status).toBe(401)
    expect((await post('/api/auth/login', { phone: '0912345678', password: 'newpass123' })).status).toBe(200)
  })

  it('rejects a wrong current password and a mismatched confirmation', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    const wrong = await post('/api/auth/change-password', {
      currentPassword: 'incorrect', newPassword: 'newpass123', confirmPassword: 'newpass123',
    }, user.token)
    expect(wrong.status).toBe(422)

    const mismatch = await post('/api/auth/change-password', {
      currentPassword: 'userpass123', newPassword: 'newpass123', confirmPassword: 'different123',
    }, user.token)
    expect(mismatch.status).toBe(400)
  })
})

describe('manual Zalo recovery', () => {
  it('lets the admin reset a USER, forces a password change, and records an audit row', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')

    const reset = await post(`/api/admin/users/${user.id}/reset-password`, undefined, admin.token)
    expect(reset.status).toBe(200)
    const resetBody = await reset.json<{
      temporaryPassword: string; expiresInMinutes: number; requiresPasswordChange: boolean
    }>()
    expect(resetBody.temporaryPassword).toBe(TEMPORARY_PASSWORD)
    expect(resetBody.expiresInMinutes).toBe(15)
    expect(resetBody.requiresPasswordChange).toBe(true)

    // Reset revokes the user's old token immediately.
    expect((await get('/api/points/balances', user.token)).status).toBe(401)

    const login = await post('/api/auth/login', { phone: '0912345678', password: TEMPORARY_PASSWORD })
    expect(login.status).toBe(200)
    const loginBody = await login.json<{ token: string; requiresPasswordChange: boolean }>()
    expect(loginBody.requiresPasswordChange).toBe(true)

    // A temporary session may only change the password or log out.
    const blocked = await get('/api/points/balances', loginBody.token)
    expect(blocked.status).toBe(403)
    expect((await blocked.json<{ code: string }>()).code).toBe('PASSWORD_CHANGE_REQUIRED')

    const changed = await post('/api/auth/change-password', {
      currentPassword: TEMPORARY_PASSWORD,
      newPassword: 'replacement123',
      confirmPassword: 'replacement123',
    }, loginBody.token)
    expect(changed.status).toBe(200)

    expect((await post('/api/auth/login', { phone: '0912345678', password: TEMPORARY_PASSWORD })).status).toBe(401)
    expect((await post('/api/auth/login', { phone: '0912345678', password: 'replacement123' })).status).toBe(200)

    const audit = await env.DB.prepare(
      'SELECT user_id, phone_snapshot, admin_id FROM password_reset_log WHERE user_id = ?',
    ).bind(user.id).first<{ user_id: string; phone_snapshot: string; admin_id: string }>()
    expect(audit).toEqual({ user_id: user.id, phone_snapshot: '0912345678', admin_id: admin.id })
  })

  it('rejects an expired temporary password', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0912345678')
    await post(`/api/admin/users/${user.id}/reset-password`, undefined, admin.token)
    await env.DB.prepare(
      'UPDATE users SET temporary_password_expires_at = ? WHERE id = ?',
    ).bind('2000-01-01T00:00:00.000Z', user.id).run()

    const login = await post('/api/auth/login', { phone: '0912345678', password: TEMPORARY_PASSWORD })
    expect(login.status).toBe(401)
    expect((await login.json<{ code: string }>()).code).toBe('TEMPORARY_PASSWORD_EXPIRED')
  })

  it('does not allow this workflow to reset the Super Admin', async () => {
    const admin = await seedAdmin()
    const res = await post(`/api/admin/users/${admin.id}/reset-password`, undefined, admin.token)
    expect(res.status).toBe(403)
    expect((await post('/api/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD })).status).toBe(200)
  })

  it('exposes configured Zalo contact information without authentication', async () => {
    const res = await get('/api/auth/password-help')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      configured: true,
      zaloUrl: 'https://zalo.me/0900000000',
      zaloQrValue: 'https://zalo.me/0900000000',
      phone: '0900000000',
    })
  })
})
