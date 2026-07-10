import { type } from 'arktype'

// Phone: trim, normalize +84 → 0, then require a VN mobile (0 followed by 9 digits).
// Shared by register, login, and admin so normalization is identical everywhere.
export const phone = type('string').pipe((s, ctx) => {
  const normalized = s.trim().replace(/^\+84/, '0')
  return /^0\d{9}$/.test(normalized) ? normalized : ctx.error('a valid VN phone number (0XXXXXXXXX)')
})

// Non-empty name, trimmed.
export const fullName = type('string').pipe((s, ctx) => {
  const trimmed = s.trim()
  return trimmed.length > 0 ? trimmed : ctx.error('a non-empty full name')
})
