// Create a WooCommerce product from already-uploaded WP media IDs. Runs SERVER-SIDE ONLY, same
// as lib/wpMedia.ts's uploadImageToWp — the Application Password never reaches the browser.
//
// Category term IDs are hardcoded: these are two fixed site categories (docs/superpowers/specs/
// 2026-08-04-job-post-tool-design.md), not something an admin picks a new one of, so there's no
// lookup call here — just the two real IDs confirmed live against the site.
const CATEGORY_TERM_IDS = {
  'don-nam': 75,
  'don-nu': 76,
} as const

export type JobPostCategory = keyof typeof CATEGORY_TERM_IDS

export function isJobPostCategory(value: string): value is JobPostCategory {
  return value === 'don-nam' || value === 'don-nu'
}

export interface WpProductEnv {
  WP_API_BASE: string
  WP_MEDIA_USER: string
  WP_MEDIA_APP_PASSWORD: string
}

export class WpProductError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`WordPress product creation failed: ${status} ${detail}`)
    this.name = 'WpProductError'
  }
}

export interface CreateWpProductInput {
  category: JobPostCategory
  /** First ID is the featured image; the rest become the product gallery. */
  imageIds: [number, number, number, number]
}

export interface WpProductResult {
  id: number
  permalink: string
}

export interface WpProductListItem {
  id: number
  name: string
  permalink: string
  dateCreated: string
  /** First image is the featured/composite image — same order createWpProduct wrote them in. */
  images: { id: number; src: string }[]
}

export interface ListWpProductsInput {
  category: JobPostCategory
  page: number
  limit: number
}

export interface ListWpProductsResult {
  products: WpProductListItem[]
  total: number
}

export async function createWpProduct(
  env: WpProductEnv,
  input: CreateWpProductInput,
): Promise<WpProductResult> {
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)

  const res = await fetch(`${env.WP_API_BASE}/wc/v3/products`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      // Never shown to or entered by the admin — WooCommerce requires a non-empty title, this
      // just satisfies that (design doc: "Non-goals").
      name: `job-post-${Date.now()}`,
      status: 'publish',
      categories: [{ id: CATEGORY_TERM_IDS[input.category] }],
      images: input.imageIds.map((id) => ({ id })),
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }

  const data = (await res.json()) as { id: number; permalink: string }
  return { id: data.id, permalink: data.permalink }
}

// Admin's "list posts to delete" view — proxies straight to WooCommerce, no D1 involved (the
// product IS the record; see createWpProduct's header comment).
export async function listWpProducts(
  env: WpProductEnv,
  input: ListWpProductsInput,
): Promise<ListWpProductsResult> {
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)
  const categoryId = CATEGORY_TERM_IDS[input.category]

  // WP_API_BASE already ends in `?rest_route=`, which consumes the URL's own `?` — any further
  // query params must be joined with `&`, same convention as the rest of this file's callers.
  const res = await fetch(
    `${env.WP_API_BASE}/wc/v3/products&category=${categoryId}&page=${input.page}&per_page=${input.limit}&orderby=date&order=desc`,
    {
      headers: {
        Authorization: auth,
        'User-Agent': 'xkld-tools-worker/1.0',
        Accept: 'application/json',
      },
    },
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }

  const total = Number(res.headers.get('X-WP-Total') ?? '0')
  const data = (await res.json()) as {
    id: number
    name: string
    permalink: string
    date_created: string
    images: { id: number; src: string }[]
  }[]

  return {
    products: data.map((p) => ({
      id: p.id,
      name: p.name,
      permalink: p.permalink,
      dateCreated: p.date_created,
      images: p.images,
    })),
    total,
  }
}

export async function deleteWpProduct(env: WpProductEnv, id: number): Promise<{ deleted: boolean }> {
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)

  // force=true: permanently delete rather than trash — a trashed product would still occupy the
  // category listing/API results the admin is trying to clear it from.
  const res = await fetch(`${env.WP_API_BASE}/wc/v3/products/${id}&force=true`, {
    method: 'DELETE',
    headers: {
      Authorization: auth,
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
  })

  if (res.status === 404) return { deleted: false }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpProductError(res.status, detail.slice(0, 300))
  }
  return { deleted: true }
}
