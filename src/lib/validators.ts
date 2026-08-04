import { type } from 'arktype'

// Phone: trim, normalize +84 → 0, then require a VN mobile (0 followed by 9 digits).
// Shared by register and admin-created (root) users so normalization is identical everywhere a
// real phone number is actually required.
export const phone = type('string').pipe((s, ctx) => {
  const normalized = s.trim().replace(/^\+84/, '0')
  return /^0\d{9}$/.test(normalized) ? normalized : ctx.error('a valid VN phone number (0XXXXXXXXX)')
})

// Login identifier: trimmed, +84 normalized to 0 (so a real phone number still matches what's
// stored), but NOT format-checked like `phone` above. The SUPER_ADMIN is a special case
// (seed-admin.ts) that may be seeded with a non-phone username (e.g. "xkldadmin") instead of a
// real phone — login only needs to exact-match whatever's in users.phone, so it can't require the
// strict VN-mobile shape. The strict format is enforced at REGISTER time only, where a real phone
// number is genuinely required (regular CTVs still can only register with one).
const MAX_LOGIN_IDENTIFIER_LENGTH = 32
export const loginIdentifier = type('string').pipe((s, ctx) => {
  const trimmed = s.trim().replace(/^\+84/, '0')
  if (trimmed.length === 0) return ctx.error('a non-empty phone or username')
  if (trimmed.length > MAX_LOGIN_IDENTIFIER_LENGTH) {
    return ctx.error(`a phone or username at most ${MAX_LOGIN_IDENTIFIER_LENGTH} characters`)
  }
  return trimmed
})

// Non-empty, length-bounded name, trimmed. The cap stops a multi-megabyte name at /register,
// /admin/users, and PATCH /me (Mike, PR review). 100 is generous for a person's name.
const MAX_NAME_LENGTH = 100
export const fullName = type('string').pipe((s, ctx) => {
  const trimmed = s.trim()
  if (trimmed.length === 0) return ctx.error('a non-empty full name')
  if (trimmed.length > MAX_NAME_LENGTH) return ctx.error(`a full name at most ${MAX_NAME_LENGTH} characters`)
  return trimmed
})

// Customer phone (order activation only): free text, not the strict VN-mobile check `phone`
// enforces above — this is whatever the customer told the CTV, stored for display/search only
// (no uniqueness or lookup depends on it), so format shouldn't block activation.
const MAX_CUSTOMER_PHONE_LENGTH = 20
export const customerPhone = type('string').pipe((s, ctx) => {
  const trimmed = s.trim()
  if (trimmed.length === 0) return ctx.error('a non-empty phone number')
  if (trimmed.length > MAX_CUSTOMER_PHONE_LENGTH) {
    return ctx.error(`a phone number at most ${MAX_CUSTOMER_PHONE_LENGTH} characters`)
  }
  return trimmed
})
