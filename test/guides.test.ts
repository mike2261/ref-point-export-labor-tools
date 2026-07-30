import { SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, get, registerUser, seedAdmin } from './helpers'

const WP_MEDIA_URL = 'https://wp.test/wp-content/uploads/2026/07/guide.jpg'

// The Worker runs in the same isolate as the test, so stubbing global fetch intercepts the
// Worker's outbound WordPress upload. SELF.fetch (test → Worker) dispatches directly and is
// unaffected, so app requests keep working. Any *other* outbound call throws — a guard against
// accidentally hitting the real site.
let wpUploads = 0
beforeEach(() => {
  wpUploads = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    if (url.includes('/wp/v2/media')) {
      wpUploads++
      return new Response(JSON.stringify({ id: 4242, source_url: WP_MEDIA_URL }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`)
  })
})
afterEach(() => vi.restoreAllMocks())

interface UploadFields {
  title?: string
  description?: string
  filename?: string
  type?: string
  bytes?: Uint8Array
  omitImage?: boolean
}

function createGuide(token: string | undefined, f: UploadFields = {}): Promise<Response> {
  const fd = new FormData()
  if (!f.omitImage) {
    const bytes = f.bytes ?? new Uint8Array([137, 80, 78, 71])
    fd.append('image', new File([bytes], f.filename ?? 'guide.jpg', { type: f.type ?? 'image/jpeg' }))
  }
  if (f.title !== undefined) fd.append('title', f.title)
  if (f.description !== undefined) fd.append('description', f.description)
  return SELF.fetch(`${BASE}/api/admin/guides`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('CTV guides feed', () => {
  it('public feed is empty to start', async () => {
    await seedAdmin()
    const res = await get('/api/guides')
    expect(res.status).toBe(200)
    const body = await res.json<{ guides: unknown[]; total: number }>()
    expect(body.guides).toEqual([])
    expect(body.total).toBe(0)
  })

  it('rejects create without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111111')

    expect((await createGuide(undefined, { title: 'x' })).status).toBe(401)
    expect((await createGuide(user.token, { title: 'x' })).status).toBe(403)
  })

  it('admin creates a guide: image is proxied to WordPress and the URL is stored', async () => {
    const admin = await seedAdmin()

    const res = await createGuide(admin.token, {
      title: 'Cách chốt đơn nhanh',
      description: 'Hướng dẫn quy trình tư vấn khách hàng',
    })
    expect(res.status).toBe(201)
    const { guide } = await res.json<{ guide: { imageUrl: string; title: string; description: string; published: boolean } }>()
    expect(guide.imageUrl).toBe(WP_MEDIA_URL)
    expect(guide.title).toBe('Cách chốt đơn nhanh')
    expect(guide.description).toBe('Hướng dẫn quy trình tư vấn khách hàng')
    expect(guide.published).toBe(true)

    // Now visible on the public feed.
    const feed = await get('/api/guides')
    const body = await feed.json<{ guides: { title: string }[]; total: number }>()
    expect(body.total).toBe(1)
    expect(body.guides[0].title).toBe('Cách chốt đơn nhanh')
  })

  it('validates the upload payload before touching WordPress', async () => {
    const admin = await seedAdmin()
    expect((await createGuide(admin.token, { title: 'ok', omitImage: true })).status).toBe(400)
    expect((await createGuide(admin.token, { title: '' })).status).toBe(400)
    expect((await createGuide(admin.token, { title: 'ok', type: 'text/plain' })).status).toBe(400)
    // A rejected request must never reach the WordPress upload.
    expect(wpUploads).toBe(0)
  })

  it('unpublishing hides a guide from the public feed but not from admin', async () => {
    const admin = await seedAdmin()
    const created = await createGuide(admin.token, { title: 'Hướng dẫn đăng ký khách' })
    const { guide } = await created.json<{ guide: { id: string } }>()

    const patch = await SELF.fetch(`${BASE}/api/admin/guides/${guide.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ published: false }),
    })
    expect(patch.status).toBe(200)

    const publicFeed = await (await get('/api/guides')).json<{ total: number }>()
    expect(publicFeed.total).toBe(0)

    const adminFeed = await (await get('/api/admin/guides', admin.token)).json<{ total: number; guides: { published: boolean }[] }>()
    expect(adminFeed.total).toBe(1)
    expect(adminFeed.guides[0].published).toBe(false)
  })

  it('deletes a guide', async () => {
    const admin = await seedAdmin()
    const created = await createGuide(admin.token, { title: 'Xoá thử' })
    const { guide } = await created.json<{ guide: { id: string } }>()

    const del = await SELF.fetch(`${BASE}/api/admin/guides/${guide.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(del.status).toBe(200)
    expect((await (await get('/api/guides')).json<{ total: number }>()).total).toBe(0)

    // Deleting again → 404.
    const again = await SELF.fetch(`${BASE}/api/admin/guides/${guide.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(again.status).toBe(404)
  })
})
