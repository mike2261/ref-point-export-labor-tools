// The one shared path for reading and creating users. register, seed:admin, and the admin
// route all go through createUser so the INSERT never drifts. password_hash never leaves here
// — everything public goes through toAuthUser.
import { hashPassword } from './password'

export type Role = 'SUPER_ADMIN' | 'USER'

// Raw DB row shape (snake_case, includes the hash — internal only).
interface UserRow {
  id: string
  full_name: string
  phone: string
  password_hash: string
  role: Role
  referrer_id: string | null
  referral_code: string
  is_active: number
  created_at: string
}

// Public, hash-free, camelCased shape returned to callers/responses.
export interface AuthUser {
  id: string
  fullName: string
  phone: string
  role: Role
  referrerId: string | null
  referralCode: string
  isActive: boolean
  createdAt: string
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    referrerId: row.referrer_id,
    referralCode: row.referral_code,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  }
}

// Typed uniqueness violation, translated from the DB error so routes can map it to HTTP.
export class ConflictError extends Error {
  field: 'phone' | 'role'
  constructor(field: 'phone' | 'role') {
    super(`conflict on ${field}`)
    this.name = 'ConflictError'
    this.field = field
  }
}

// Let the DB be the source of truth for uniqueness; translate its error rather than pre-checking
// (a pre-check has a race window; the constraint does not).
function translateConflict(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err)
  // referral_code defaults to phone, so a duplicate phone trips either constraint — both mean "phone".
  if (msg.includes('users.phone') || msg.includes('users.referral_code')) return new ConflictError('phone')
  if (msg.includes('users.role') || msg.includes('one_super_admin')) return new ConflictError('role')
  return err
}

export interface CreateUserInput {
  fullName: string
  phone: string
  password: string
  role: Role
  referrerId: string | null
}

export async function createUser(db: D1Database, input: CreateUserInput): Promise<AuthUser> {
  const id = crypto.randomUUID()
  const passwordHash = await hashPassword(input.password)
  const referralCode = input.phone // default: the code is the phone (unique because phone is unique)
  const createdAt = new Date().toISOString()

  try {
    await db
      .prepare(
        `INSERT INTO users
           (id, full_name, phone, password_hash, role, referrer_id, referral_code, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, input.fullName, input.phone, passwordHash, input.role, input.referrerId, referralCode, createdAt)
      .run()
  } catch (err) {
    throw translateConflict(err)
  }

  return toAuthUser({
    id,
    full_name: input.fullName,
    phone: input.phone,
    password_hash: passwordHash,
    role: input.role,
    referrer_id: input.referrerId,
    referral_code: referralCode,
    is_active: 1,
    created_at: createdAt,
  })
}

export function findById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()
}

export function findByPhone(db: D1Database, phone: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first<UserRow>()
}

export function findByReferralCode(db: D1Database, code: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE referral_code = ?').bind(code).first<UserRow>()
}

export async function superAdminExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").first()
  return row !== null
}

// Rename own profile (name only this phase). Returns the updated user, or null if id is gone.
export async function updateFullName(db: D1Database, id: string, fullName: string): Promise<AuthUser | null> {
  await db.prepare('UPDATE users SET full_name = ? WHERE id = ?').bind(fullName, id).run()
  const row = await findById(db, id)
  return row ? toAuthUser(row) : null
}
