// Session = a signed JWT (HS256) carried in an httpOnly cookie. No refresh token; TTL 1 day.
// The token holds only { sub, exp } — the middleware re-loads the user from D1 each request,
// so role/active status are always fresh and nothing in the token can go stale.
import { sign, verify } from 'hono/jwt'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import type { Context } from 'hono'

export const SESSION_COOKIE = 'session'
const TTL_SECONDS = 60 * 60 * 24 // 1 day

export interface SessionPayload {
  sub: string // user id
  exp: number // seconds since epoch
}

export async function signSession(secret: string, sub: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS
  return sign({ sub, exp }, secret, 'HS256')
}

// Throws on a bad or expired token — callers must try/catch.
export async function verifySession(token: string, secret: string): Promise<SessionPayload> {
  const payload = await verify(token, secret, 'HS256')
  return payload as unknown as SessionPayload
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, // JS can't read it → XSS can't steal the session
    secure: true, // HTTPS only
    sameSite: 'Lax', // basic CSRF defense
    path: '/',
    maxAge: TTL_SECONDS,
  })
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE)
}
