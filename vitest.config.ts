import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Migrations are read here and applied per-test in the setup file.
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          // Deterministic secrets for tests (override .dev.vars).
          JWT_SECRET: 'test-secret',
        },
      },
    })),
  ],
})
