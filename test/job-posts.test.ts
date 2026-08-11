import { SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, registerUser, seedAdmin } from './helpers'

const WP_MEDIA_URL = 'https://wp.test/wp-content/uploads/2026/08/job.jpg'
const WP_PRODUCT_PERMALINK = 'https://xklddieuduong.vn/?product=123'

// Same approach as test/posts.test.ts: stub global fetch to intercept the Worker's two outbound
// WordPress calls (media upload, product creation). SELF.fetch (test -> Worker) is unaffected.
let wpUploads = 0
let wpProductCreates = 0
let lastProductBody: Record<string, unknown> | null = null

beforeEach(() => {
  wpUploads = 0
  wpProductCreates = 0
  lastProductBody = null
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    if (url.includes('/wp/v2/media')) {
      wpUploads++
      return new Response(
        JSON.stringify({ id: 900 + wpUploads, source_url: `${WP_MEDIA_URL}-${wpUploads}` }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/wc/v3/products')) {
      wpProductCreates++
      lastProductBody = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({ id: 123, permalink: WP_PRODUCT_PERMALINK }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`)
  })
})
afterEach(() => vi.restoreAllMocks())

interface JobPostFields {
  category?: string
  omitCategory?: boolean
  images?: Partial<Record<'composite' | 'image1' | 'image2' | 'image3', { bytes?: Uint8Array; filename?: string; type?: string }>>
  omitFields?: ('composite' | 'image1' | 'image2' | 'image3')[]
}

function createJobPost(token: string | undefined, f: JobPostFields = {}): Promise<Response> {
  const fd = new FormData()
  if (!f.omitCategory) fd.append('category', f.category ?? 'don-nam')

  const fields: ('composite' | 'image1' | 'image2' | 'image3')[] = ['composite', 'image1', 'image2', 'image3']
  for (const field of fields) {
    if (f.omitFields?.includes(field)) continue
    const spec = f.images?.[field] ?? {}
    const bytes = spec.bytes ?? new Uint8Array([137, 80, 78, 71])
    fd.append(field, new File([bytes], spec.filename ?? `${field}.jpg`, { type: spec.type ?? 'image/jpeg' }))
  }

  return SELF.fetch(`${BASE}/api/admin/job-posts`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('POST /api/admin/job-posts', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111111')

    expect((await createJobPost(undefined)).status).toBe(401)
    expect((await createJobPost(user.token)).status).toBe(403)
  })

  it('validates category and required images before touching WordPress', async () => {
    const admin = await seedAdmin()

    expect((await createJobPost(admin.token, { omitCategory: true })).status).toBe(400)
    expect((await createJobPost(admin.token, { category: 'not-a-real-category' })).status).toBe(400)
    expect((await createJobPost(admin.token, { omitFields: ['image2'] })).status).toBe(400)
    expect(
      (await createJobPost(admin.token, { images: { image1: { type: 'text/plain' } } })).status,
    ).toBe(400)

    expect(wpUploads).toBe(0)
    expect(wpProductCreates).toBe(0)
  })

  it('uploads all 4 images and creates a product with the right category and image order', async () => {
    const admin = await seedAdmin()

    const res = await createJobPost(admin.token, { category: 'don-nu' })
    expect(res.status).toBe(201)
    const { jobPost } = await res.json<{ jobPost: { id: number; permalink: string } }>()
    expect(jobPost).toEqual({ id: 123, permalink: WP_PRODUCT_PERMALINK })

    expect(wpUploads).toBe(4)
    expect(wpProductCreates).toBe(1)
    expect(lastProductBody?.categories).toEqual([{ id: 76 }]) // don-nu
    // 4 uploads happened in composite/image1/image2/image3 order, so their assigned WP media
    // IDs (900+n) land in the same order in the product's images array — composite first
    // (featured), then the 3 originals (gallery).
    expect(lastProductBody?.images).toEqual([{ id: 901 }, { id: 902 }, { id: 903 }, { id: 904 }])
    expect(lastProductBody?.status).toBe('publish')
  })

  it('maps don-nam to its real term id', async () => {
    const admin = await seedAdmin()
    await createJobPost(admin.token, { category: 'don-nam' })
    expect(lastProductBody?.categories).toEqual([{ id: 75 }])
  })

  it('returns 502 and creates no product when a media upload fails', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wp/v2/media')) return new Response('nope', { status: 500 })
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await createJobPost(admin.token)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_UPLOAD_FAILED')
  })

  it('returns 502 when product creation fails after images already uploaded', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wp/v2/media')) {
        wpUploads++
        return new Response(JSON.stringify({ id: 900 + wpUploads, source_url: 'https://wp.test/x.jpg' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/wc/v3/products')) return new Response('nope', { status: 500 })
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await createJobPost(admin.token)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
    expect(wpUploads).toBe(4) // the 4 uploads already happened before the product call failed
  })
})

function createSingleImageJobPost(
  token: string | undefined,
  f: {
    category?: string
    title?: string
    omitTitle?: boolean
    description?: string
    omitImage?: boolean
    imageType?: string
  } = {},
): Promise<Response> {
  const fd = new FormData()
  fd.append('category', f.category ?? 'don-hang')
  if (!f.omitTitle) fd.append('title', f.title ?? 'Job post title')
  if (f.description !== undefined) fd.append('description', f.description)
  if (!f.omitImage) {
    fd.append(
      'image',
      new File([new Uint8Array([137, 80, 78, 71])], 'image.jpg', { type: f.imageType ?? 'image/jpeg' }),
    )
  }
  return SELF.fetch(`${BASE}/api/admin/job-posts`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('POST /api/admin/job-posts — single-image categories', () => {
  it('validates title and image before touching WordPress', async () => {
    const admin = await seedAdmin()

    expect((await createSingleImageJobPost(admin.token, { omitTitle: true })).status).toBe(400)
    expect((await createSingleImageJobPost(admin.token, { title: '   ' })).status).toBe(400)
    expect((await createSingleImageJobPost(admin.token, { omitImage: true })).status).toBe(400)
    expect((await createSingleImageJobPost(admin.token, { imageType: 'text/plain' })).status).toBe(400)

    expect(wpUploads).toBe(0)
    expect(wpProductCreates).toBe(0)
  })

  it('uploads 1 image and creates a product with title/description, no composite', async () => {
    const admin = await seedAdmin()

    const res = await createSingleImageJobPost(admin.token, {
      category: 'hoc-vien-xuat-canh',
      title: 'Bạn Nguyễn Văn A đăng ký đi Nhật',
      description: 'Chi tiết đơn hàng',
    })
    expect(res.status).toBe(201)

    expect(wpUploads).toBe(1)
    expect(wpProductCreates).toBe(1)
    expect(lastProductBody?.name).toBe('Bạn Nguyễn Văn A đăng ký đi Nhật')
    expect(lastProductBody?.description).toBe('Chi tiết đơn hàng')
    expect(lastProductBody?.categories).toEqual([{ id: 72 }]) // hoc-vien-xuat-canh
    expect(lastProductBody?.images).toEqual([{ id: 901 }])
  })

  it('defaults description to empty string when omitted', async () => {
    const admin = await seedAdmin()
    await createSingleImageJobPost(admin.token, { category: 'don-hang' })
    expect(lastProductBody?.description).toBe('')
  })
})

function listJobPosts(token: string | undefined, query = ''): Promise<Response> {
  return SELF.fetch(`${BASE}/api/admin/job-posts${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

function deleteJobPost(token: string | undefined, id: number | string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/admin/job-posts/${id}`, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET /api/admin/job-posts', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111112')

    expect((await listJobPosts(undefined)).status).toBe(401)
    expect((await listJobPosts(user.token)).status).toBe(403)
  })

  it('rejects an invalid category', async () => {
    const admin = await seedAdmin()
    expect((await listJobPosts(admin.token, '?category=not-a-real-category')).status).toBe(400)
  })

  it('defaults to don-nam and lists products with paging info', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wc/v3/products')) {
        expect(url).toContain('category=75') // don-nam
        expect(url).toContain('page=1')
        expect(url).toContain('per_page=20')
        return new Response(
          JSON.stringify([
            {
              id: 123,
              name: 'job-post-1',
              permalink: 'https://xklddieuduong.vn/?product=123',
              date_created: '2026-08-05T00:00:00',
              images: [{ id: 901, src: 'https://wp.test/composite.jpg' }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json', 'X-WP-Total': '1' } },
        )
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await listJobPosts(admin.token)
    expect(res.status).toBe(200)
    const body = await res.json<{ jobPosts: unknown[]; page: number; limit: number; total: number }>()
    expect(body.page).toBe(1)
    expect(body.limit).toBe(20)
    expect(body.total).toBe(1)
    expect(body.jobPosts).toEqual([
      {
        id: 123,
        name: 'job-post-1',
        permalink: 'https://xklddieuduong.vn/?product=123',
        dateCreated: '2026-08-05T00:00:00',
        images: [{ id: 901, src: 'https://wp.test/composite.jpg' }],
      },
    ])
  })

  it('filters by don-nu term id and honors page/limit', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/wc/v3/products')) {
        expect(url).toContain('category=76') // don-nu
        expect(url).toContain('page=2')
        expect(url).toContain('per_page=5')
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'X-WP-Total': '0' } })
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    const res = await listJobPosts(admin.token, '?category=don-nu&page=2&limit=5')
    expect(res.status).toBe(200)
  })

  it('returns 502 when WordPress fails', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 500 }))

    const res = await listJobPosts(admin.token)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
  })
})

function getJobPost(token: string | undefined, id: number | string, category = 'don-hang'): Promise<Response> {
  return SELF.fetch(`${BASE}/api/admin/job-posts/${id}?category=${category}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET /api/admin/job-posts/:id', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111114')

    expect((await getJobPost(undefined, 123)).status).toBe(401)
    expect((await getJobPost(user.token, 123)).status).toBe(403)
  })

  it('rejects a non-numeric id', async () => {
    const admin = await seedAdmin()
    expect((await getJobPost(admin.token, 'abc')).status).toBe(400)
  })

  it('rejects an invalid category', async () => {
    const admin = await seedAdmin()
    expect((await getJobPost(admin.token, 123, 'not-a-real-category')).status).toBe(400)
  })

  it('strips wpautop <p> wrapping from description and returns title/images', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      expect(url).toContain('/wc/v3/products/123')
      return new Response(
        JSON.stringify({
          id: 123,
          name: 'Bạn A đăng ký đi Nhật',
          description: '<p>Dòng 1</p>\n<p>Dòng 2</p>',
          images: [{ id: 901, src: 'https://wp.test/photo.jpg' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const res = await getJobPost(admin.token, 123)
    expect(res.status).toBe(200)
    const body = await res.json<{ jobPost: { id: number; name: string; description: string; images: unknown[] } }>()
    expect(body.jobPost).toEqual({
      id: 123,
      name: 'Bạn A đăng ký đi Nhật',
      description: 'Dòng 1\n\nDòng 2',
      images: [{ id: 901, src: 'https://wp.test/photo.jpg' }],
    })
  })

  it('returns 404 when the product does not exist', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 404 }))

    const res = await getJobPost(admin.token, 999)
    expect(res.status).toBe(404)
  })

  it('returns 502 when WordPress fails for a reason other than not-found', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 500 }))

    const res = await getJobPost(admin.token, 123)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
  })
})

describe('DELETE /api/admin/job-posts/:id', () => {
  it('rejects without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111113')

    expect((await deleteJobPost(undefined, 123)).status).toBe(401)
    expect((await deleteJobPost(user.token, 123)).status).toBe(403)
  })

  it('rejects a non-numeric id before touching WordPress', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    })

    expect((await deleteJobPost(admin.token, 'abc')).status).toBe(400)
  })

  it('deletes permanently (force=true) and returns ok', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      expect(url).toContain('/wc/v3/products/123')
      expect(url).toContain('force=true')
      expect(init?.method).toBe('DELETE')
      return new Response(JSON.stringify({ id: 123 }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const res = await deleteJobPost(admin.token, 123)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 404 when the product does not exist', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 404 }))

    const res = await deleteJobPost(admin.token, 999)
    expect(res.status).toBe(404)
  })

  it('returns 502 when WordPress fails for a reason other than not-found', async () => {
    const admin = await seedAdmin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('nope', { status: 500 }))

    const res = await deleteJobPost(admin.token, 123)
    expect(res.status).toBe(502)
    expect((await res.json<{ code: string }>()).code).toBe('WP_PRODUCT_FAILED')
  })
})
