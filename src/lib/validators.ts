import { type } from 'arktype'

// Phone: trim, normalize +84 → 0, then require a VN mobile (0 followed by 9 digits).
// Shared by register, login, and admin so normalization is identical everywhere.
export const phone = type('string').pipe((s, ctx) => {
  const normalized = s.trim().replace(/^\+84/, '0')
  return /^0\d{9}$/.test(normalized) ? normalized : ctx.error('a valid VN phone number (0XXXXXXXXX)')
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
