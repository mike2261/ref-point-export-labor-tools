import type { AuthUser } from './lib/users'

// Shared Hono env: `Env` bindings (DB, JWT_SECRET) + a per-request `user` that is present only
// for authenticated requests (absent = anonymous, which is valid).
export type AppEnv = {
  Bindings: CloudflareBindings & {
    // Optional until the business supplies the personal Zalo contact details.
    ZALO_ADMIN_URL?: string
    ZALO_ADMIN_PHONE?: string
  }
  Variables: {
    user?: AuthUser
  }
}
