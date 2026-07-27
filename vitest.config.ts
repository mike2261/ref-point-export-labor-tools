import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

// Two projects (tech-spec §11.1):
//   - `domain`  : pure business core, plain Node, no Workers pool → millisecond TDD loop.
//   - `workers` : integration tests via @cloudflare/vitest-pool-workers (SELF.fetch + real D1).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'domain',
          include: ['src/domain/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
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
                ZALO_ADMIN_URL: 'https://zalo.me/0900000000',
                ZALO_ADMIN_PHONE: '0900000000',
                // WordPress media upload — dummy creds + a test origin so posts tests hit fetchMock,
                // never the real site.
                WP_API_BASE: 'https://wp.test/wp-json',
                WP_MEDIA_USER: 'media-api',
                WP_MEDIA_APP_PASSWORD: 'test-app-pass',
              },
            },
          })),
        ],
        test: {
          name: 'workers',
          include: ['test/**/*.test.ts'],
          setupFiles: ['./test/apply-migrations.ts'],
        },
      },
    ],
  },
})
