# xkld-tools

Reward-points & referral system for XKLĐ (labor export) collaborators, running on Cloudflare Workers (Hono + ArkType + D1).

- Business rules: [`docs/PRD.md`](./docs/PRD.md)
- Technical design: [`docs/tech-spec.md`](./docs/tech-spec.md)
- Auth design: [`docs/auth-design.md`](./docs/auth-design.md)

## Prerequisites

- Node.js + [pnpm](https://pnpm.io)
- A Cloudflare account (only needed for deploys; local dev works without one)

## Setup

### 1. Install dependencies

```sh
pnpm install
```

### 2. Environment variables

Local secrets live in `.dev.vars` (gitignored, read automatically by `wrangler dev`). Create it in the project root:

```sh
# .dev.vars
JWT_SECRET=<any long random string>
ZALO_ADMIN_URL=https://zalo.me/<admin-phone>
ZALO_ADMIN_PHONE=<admin-phone>
```

Generate a strong value with:

```sh
openssl rand -base64 32
```

| Variable | Purpose | Local | Production |
|---|---|---|---|
| `JWT_SECRET` | Signs session JWTs (HS256) | `.dev.vars` | `wrangler secret put JWT_SECRET` |
| `ZALO_ADMIN_URL` | Personal Zalo chat link for password recovery | `.dev.vars` | Cloudflare Worker variable |
| `ZALO_ADMIN_PHONE` | Fallback support phone | `.dev.vars` | Cloudflare Worker variable |

For production, set the secret once per environment:

```sh
pnpm exec wrangler secret put JWT_SECRET
```

### 3. Run database migrations

Migrations live in `migrations/` and are applied with Wrangler D1.

Local (creates/updates the local SQLite DB used by `wrangler dev`):

```sh
pnpm db:migrate:local
```

Remote (production D1 database):

```sh
pnpm exec wrangler d1 migrations apply xkld-db --remote
```

Check which migrations are pending:

```sh
pnpm exec wrangler d1 migrations list xkld-db --local   # or --remote
```

### 4. Seed the super admin (first run only)

The system has exactly one `SUPER_ADMIN` account, created by a one-shot script (you'll be prompted for the password):

```sh
pnpm seed:admin --phone 0900000000 --name 'Super Admin' --local
```

Drop `--local` to seed the remote database instead.

## Development

```sh
pnpm dev
```

Starts `wrangler dev` on http://localhost:8787 with the local D1 database and `.dev.vars` loaded.

## Testing

```sh
pnpm test
```

Runs Vitest in the Workers pool; each test gets a fresh, fully migrated D1 database.

## Deploy

```sh
pnpm exec wrangler d1 migrations apply xkld-db --remote   # apply pending migrations first
pnpm deploy
```

## Type generation

After changing bindings in `wrangler.jsonc`, regenerate `worker-configuration.d.ts` ([docs](https://developers.cloudflare.com/workers/wrangler/commands/#types)):

```sh
pnpm cf-typegen
```
