// Create the single SUPER_ADMIN by running one INSERT — the admin then logs in with phone (or a
// plain username — see below) + password like everyone else. The password hash can't be produced
// in SQL, so this script computes it with the SAME hashPassword() the app uses, then runs the
// INSERT via wrangler.
//
//   pnpm seed:admin --phone 0900000000 --name 'Super Admin' [--local]
//   pnpm seed:admin --phone xkldadmin --name 'Super Admin' [--local]
//
// --phone accepts either a real VN mobile number (0XXXXXXXXX, +84 normalized to 0) or a plain
// username (3-32 letters/digits/underscore) — the SUPER_ADMIN is the one account allowed to skip
// the phone-number requirement every other user (register, admin-created root CTV) still has.
// login's identifier field matches this loosely (src/lib/validators.ts loginIdentifier) for
// exactly this reason.
//
// The password is prompted interactively (never in shell history). The DB's one_super_admin
// index is the backstop if a super admin already exists.
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { hashPassword } from '../src/lib/password'

const ENTER = ['\n', '\r']
const CTRL_D = '\u0004'
const CTRL_C = '\u0003'
const BACKSPACE = ['\u007f', '\b']

function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process
    stdout.write(query)
    stdin.resume()
    stdin.setRawMode?.(true)
    stdin.setEncoding('utf8')
    let input = ''
    let done = false
    const finish = () => {
      done = true
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      resolve(input)
    }
    // Iterate the chunk char-by-char so this works for both an interactive TTY (one char per
    // event) and piped stdin (a whole line, possibly with a trailing newline, in one event).
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (done) return
        if (ENTER.includes(char) || char === CTRL_D) finish()
        else if (char === CTRL_C) {
          stdout.write('\n')
          process.exit(1)
        } else if (BACKSPACE.includes(char)) input = input.slice(0, -1)
        else input += char
      }
    }
    stdin.on('data', onData)
  })
}

const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`

async function main() {
  const { values } = parseArgs({
    options: {
      phone: { type: 'string' },
      name: { type: 'string' },
      local: { type: 'boolean', default: false },
    },
  })

  const name = values.name ?? 'Super Admin'
  const raw = (values.phone ?? '').trim()
  const normalized = raw.replace(/^\+84/, '0')
  const isPhone = /^0\d{9}$/.test(normalized)
  const isUsername = /^[a-zA-Z0-9_]{3,32}$/.test(raw)
  if (!isPhone && !isUsername) {
    console.error(
      'Error: --phone must be a VN mobile number (0XXXXXXXXX) or a plain username ' +
        '(3-32 letters/digits/underscore). Got:', values.phone ?? '(missing)',
    )
    process.exit(1)
  }
  const phone = isPhone ? normalized : raw

  const password = await promptHidden('Super admin password (min 8 chars): ')
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters.')
    process.exit(1)
  }

  const id = crypto.randomUUID()
  const passwordHash = await hashPassword(password)
  const createdAt = new Date().toISOString()

  const sql = `INSERT INTO users
      (id, full_name, phone, password_hash, role, referrer_id, referral_code, is_active, created_at)
    VALUES (${sqlString(id)}, ${sqlString(name)}, ${sqlString(phone)}, ${sqlString(passwordHash)},
            'SUPER_ADMIN', NULL, ${sqlString(phone)}, 1, ${sqlString(createdAt)});`

  const target = values.local ? '--local' : '--remote'
  // Call the project-local binary directly. This avoids Windows resolving `pnpm` to the
  // PowerShell shim, which may be blocked by the machine's execution policy.
  const wrangler = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
  const result = spawnSync(
    wrangler,
    ['d1', 'execute', 'xkld-db', target, '--command', sql],
    { encoding: 'utf8' },
  )

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`
  if (result.status !== 0) {
    if (/one_super_admin|users\.role/.test(output)) {
      console.error('A super admin already exists — only one is allowed.')
    } else if (/users\.phone|users\.referral_code/.test(output)) {
      console.error(`That phone (${phone}) is already registered.`)
    } else {
      console.error(output.trim() || 'Failed to run the INSERT.')
    }
    process.exit(1)
  }

  console.log(`✔ Super admin created (${target.replace('--', '')})`)
  console.log(`  name:          ${name}`)
  console.log(`  phone:         ${phone}`)
  console.log(`  referral_code: ${phone}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
