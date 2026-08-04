// The one shared path for reading and creating users. register, seed:admin, and the admin
// route all go through createUser so the INSERT never drifts. password_hash never leaves here
// — everything public goes through toAuthUser.
import { hashPassword, verifyPassword } from './password'
import { planRegistrationBonuses } from '../domain/points/registration'
import { draftToStatement } from './ledger'
import { notifyRegistrationBonus } from './notifications'

export type Role = 'SUPER_ADMIN' | 'USER'

// Raw DB row shape (snake_case, includes the hash — internal only).
export interface UserRow {
  id: string
  full_name: string
  phone: string
  password_hash: string
  role: Role
  referrer_id: string | null
  referral_code: string
  is_active: number
  password_version: number
  must_change_password: number
  temporary_password_expires_at: string | null
  password_reset_by: string | null
  password_reset_at: string | null
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
  requiresPasswordChange: boolean
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
    requiresPasswordChange: row.must_change_password === 1,
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

  // User row + registration bonus go in ONE batch so the bonus is atomic with creation — a dup
  // phone rolls back the whole batch, so an orphan bonus is impossible (tech-spec §6.3).
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO users
           (id, full_name, phone, password_hash, role, referrer_id, referral_code, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, input.fullName, input.phone, passwordHash, input.role, input.referrerId, referralCode, createdAt),
  ]

  // The new SUPER_ADMIN earns no points (tech-spec A2); USERs (including admin-created root users)
  // do — always just the self bonus now, referral relationship no longer affects it.
  if (input.role === 'USER') {
    for (const draft of planRegistrationBonuses({ userId: id })) {
      statements.push(draftToStatement(db, draft, createdAt))
    }
    // Notify the new user of their own +100 bonus — always paid for a USER, so always fires.
    statements.push(notifyRegistrationBonus(db, id, createdAt))
  }

  try {
    await db.batch(statements)
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
    password_version: 0,
    must_change_password: 0,
    temporary_password_expires_at: null,
    password_reset_by: null,
    password_reset_at: null,
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

export const TEMPORARY_PASSWORD = '12345678'
export const TEMPORARY_PASSWORD_TTL_MINUTES = 15

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; error: 'CURRENT_PASSWORD_INCORRECT' | 'TEMPORARY_PASSWORD_EXPIRED' }

/** Change the current user's password and revoke every existing session token. */
export async function changePassword(
  db: D1Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
  now: Date,
): Promise<ChangePasswordResult> {
  const row = await findById(db, userId)
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return { ok: false, error: 'CURRENT_PASSWORD_INCORRECT' }
  }
  if (
    row.must_change_password === 1 &&
    (!row.temporary_password_expires_at || new Date(row.temporary_password_expires_at).getTime() <= now.getTime())
  ) {
    return { ok: false, error: 'TEMPORARY_PASSWORD_EXPIRED' }
  }

  const passwordHash = await hashPassword(newPassword)
  await db
    .prepare(
      `UPDATE users
       SET password_hash = ?, password_version = password_version + 1,
           must_change_password = 0, temporary_password_expires_at = NULL,
           password_reset_by = NULL, password_reset_at = NULL
       WHERE id = ?`,
    )
    .bind(passwordHash, userId)
    .run()
  return { ok: true }
}

export type ResetPasswordResult =
  | { ok: true; expiresAt: string }
  | { ok: false; error: 'NOT_FOUND' | 'SUPER_ADMIN_FORBIDDEN' }

/** Install the business-approved temporary password for a USER and audit the admin action. */
export async function resetPasswordByAdmin(
  db: D1Database,
  userId: string,
  adminId: string,
  now: Date,
): Promise<ResetPasswordResult> {
  const row = await findById(db, userId)
  if (!row) return { ok: false, error: 'NOT_FOUND' }
  if (row.role === 'SUPER_ADMIN') return { ok: false, error: 'SUPER_ADMIN_FORBIDDEN' }

  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + TEMPORARY_PASSWORD_TTL_MINUTES * 60_000).toISOString()
  const passwordHash = await hashPassword(TEMPORARY_PASSWORD)
  await db.batch([
    db
      .prepare(
        `UPDATE users
         SET password_hash = ?, password_version = password_version + 1,
             must_change_password = 1, temporary_password_expires_at = ?,
             password_reset_by = ?, password_reset_at = ?
         WHERE id = ? AND role = 'USER'`,
      )
      .bind(passwordHash, expiresAt, adminId, createdAt, userId),
    db
      .prepare(
        `INSERT INTO password_reset_log
           (id, user_id, phone_snapshot, admin_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), userId, row.phone, adminId, createdAt, expiresAt),
  ])
  return { ok: true, expiresAt }
}

export type UserSort = 'a_asc' | 'a_desc' | 'b_asc' | 'b_desc' | 'c_asc' | 'c_desc'

export interface ListUsersFilter {
  q?: string
  page: number
  limit: number
  sort?: UserSort
}

// Row shape for listUsers() only — balance_a/balance_b/balance_c are computed columns (SUM over
// point_ledger), not real table columns, so every other UserRow consumer (findById, etc.) is
// unaffected.
export interface UserRowWithBalances extends UserRow {
  balance_a: number
  balance_b: number
  balance_c: number
}

export interface AuthUserWithBalances extends AuthUser {
  balanceA: number
  balanceB: number
  balanceC: number
}

export function toAuthUserWithBalances(row: UserRowWithBalances): AuthUserWithBalances {
  return { ...toAuthUser(row), balanceA: row.balance_a, balanceB: row.balance_b, balanceC: row.balance_c }
}

// Whitelisted, never interpolated from the raw query param — SORT_CLAUSES' keys are the only
// valid `sort` values (also enforced by the route before this is ever called).
const SORT_CLAUSES: Record<UserSort, string> = {
  a_asc: 'balance_a ASC',
  a_desc: 'balance_a DESC',
  b_asc: 'balance_b ASC',
  b_desc: 'balance_b DESC',
  c_asc: 'balance_c ASC',
  c_desc: 'balance_c DESC',
}

// Admin browse/search across all users (SUPER_ADMIN + USER rows alike). `q` matches a
// substring of full_name OR phone — SQLite's default LIKE is ASCII-only case-insensitive,
// so accented-name search is case-sensitive (accepted limitation; phone search is unaffected).
// Every row carries its live A/B/C balance (correlated subquery — cheap at this business's scale,
// same pragmatic tradeoff as the other admin list endpoints), so the admin table can show and
// sort by points without a second round trip per row.
export async function listUsers(db: D1Database, filter: ListUsersFilter): Promise<{ rows: UserRowWithBalances[]; total: number }> {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.q) {
    where.push('(u.full_name LIKE ? OR u.phone LIKE ?)')
    args.push(`%${filter.q}%`, `%${filter.q}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const orderSql = filter.sort ? SORT_CLAUSES[filter.sort] : 'u.created_at DESC'

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>()

  const offset = (filter.page - 1) * filter.limit
  const { results } = await db
    .prepare(
      `SELECT u.*,
         COALESCE((SELECT SUM(points) FROM point_ledger WHERE user_id = u.id AND wallet = 'A'), 0) AS balance_a,
         COALESCE((SELECT SUM(points) FROM point_ledger WHERE user_id = u.id AND wallet = 'B'), 0) AS balance_b,
         COALESCE((SELECT SUM(points) FROM point_ledger WHERE user_id = u.id AND wallet = 'C'), 0) AS balance_c
       FROM users u ${whereSql}
       ORDER BY ${orderSql}, u.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...args, filter.limit, offset)
    .all<UserRowWithBalances>()

  return { rows: results, total: totalRow?.n ?? 0 }
}
