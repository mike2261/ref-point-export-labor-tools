// Extra Worker bindings for the WordPress media upload (social-proof posts feature).
// Declaration-merged into the generated CloudflareBindings so it survives `wrangler types`
// regeneration. WP_API_BASE is a public var (wrangler.jsonc); the two credentials are secrets
// (.dev.vars locally, `wrangler secret put ...` in production).
interface __BaseEnv_CloudflareBindings {
  WP_API_BASE: string
  WP_MEDIA_USER: string
  WP_MEDIA_APP_PASSWORD: string
}
