import { SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE, get, registerUser, seedAdmin } from './helpers'

const WP_MEDIA_URL = 'https://wp.test/wp-content/uploads/2026/07/proof.jpg'

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
      // Each upload gets a distinct URL, so an edit-time image replacement is distinguishable
      // from the original create-time upload.
      const sourceUrl = wpUploads === 1 ? WP_MEDIA_URL : `${WP_MEDIA_URL}-${wpUploads}`
      return new Response(JSON.stringify({ id: 4242 + wpUploads, source_url: sourceUrl }), {
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

function createPost(token: string | undefined, f: UploadFields = {}): Promise<Response> {
  const fd = new FormData()
  if (!f.omitImage) {
    const bytes = f.bytes ?? new Uint8Array([137, 80, 78, 71])
    fd.append('image', new File([bytes], f.filename ?? 'proof.jpg', { type: f.type ?? 'image/jpeg' }))
  }
  if (f.title !== undefined) fd.append('title', f.title)
  if (f.description !== undefined) fd.append('description', f.description)
  return SELF.fetch(`${BASE}/api/admin/posts`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

interface PatchFields {
  title?: string
  description?: string
  image?: { bytes?: Uint8Array; filename?: string; type?: string }
}

function patchPost(token: string | undefined, id: string, f: PatchFields = {}): Promise<Response> {
  const fd = new FormData()
  if (f.title !== undefined) fd.append('title', f.title)
  if (f.description !== undefined) fd.append('description', f.description)
  if (f.image) {
    const bytes = f.image.bytes ?? new Uint8Array([1, 2, 3, 4])
    fd.append('image', new File([bytes], f.image.filename ?? 'new.jpg', { type: f.image.type ?? 'image/jpeg' }))
  }
  return SELF.fetch(`${BASE}/api/admin/posts/${id}`, {
    method: 'PATCH',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  })
}

describe('posts feed', () => {
  it('public feed is empty to start', async () => {
    await seedAdmin()
    const res = await get('/api/posts')
    expect(res.status).toBe(200)
    const body = await res.json<{ posts: unknown[]; total: number }>()
    expect(body.posts).toEqual([])
    expect(body.total).toBe(0)
  })

  it('rejects create without super admin', async () => {
    const admin = await seedAdmin()
    const user = await registerUser(admin.referralCode, '0911111111')

    expect((await createPost(undefined, { title: 'x' })).status).toBe(401)
    expect((await createPost(user.token, { title: 'x' })).status).toBe(403)
  })

  it('admin creates a post: image is proxied to WordPress and the URL is stored', async () => {
    const admin = await seedAdmin()

    const res = await createPost(admin.token, {
      title: 'Chị Lan đã đổi 2.000.000đ',
      description: 'CTV Hà Nội nhận thưởng tháng 7',
    })
    expect(res.status).toBe(201)
    const { post } = await res.json<{ post: { imageUrl: string; title: string; description: string; published: boolean } }>()
    expect(post.imageUrl).toBe(WP_MEDIA_URL)
    expect(post.title).toBe('Chị Lan đã đổi 2.000.000đ')
    expect(post.description).toBe('CTV Hà Nội nhận thưởng tháng 7')
    expect(post.published).toBe(true)

    // Now visible on the public feed.
    const feed = await get('/api/posts')
    const body = await feed.json<{ posts: { title: string }[]; total: number }>()
    expect(body.total).toBe(1)
    expect(body.posts[0].title).toBe('Chị Lan đã đổi 2.000.000đ')
  })

  it('validates the upload payload before touching WordPress', async () => {
    const admin = await seedAdmin()
    expect((await createPost(admin.token, { title: 'ok', omitImage: true })).status).toBe(400)
    expect((await createPost(admin.token, { title: '' })).status).toBe(400)
    expect((await createPost(admin.token, { title: 'ok', type: 'text/plain' })).status).toBe(400)
    // A rejected request must never reach the WordPress upload.
    expect(wpUploads).toBe(0)
  })

  it('gets a single post by id, for the edit page', async () => {
    const admin = await seedAdmin()
    const created = await createPost(admin.token, { title: 'Chi tiết bài viết' })
    const { post } = await created.json<{ post: { id: string } }>()

    const res = await get(`/api/admin/posts/${post.id}`, admin.token)
    expect(res.status).toBe(200)
    expect((await res.json<{ post: { title: string } }>()).post.title).toBe('Chi tiết bài viết')

    expect((await get('/api/admin/posts/does-not-exist', admin.token)).status).toBe(404)
  })

  it('edits title and description without touching the image', async () => {
    const admin = await seedAdmin()
    const created = await createPost(admin.token, { title: 'Bản gốc', description: 'Mô tả gốc' })
    const { post } = await created.json<{ post: { id: string; imageUrl: string } }>()

    const patch = await patchPost(admin.token, post.id, { title: 'Bản sửa', description: 'Mô tả mới' })
    expect(patch.status).toBe(200)
    const { post: updated } = await patch.json<{ post: { title: string; description: string; imageUrl: string } }>()
    expect(updated.title).toBe('Bản sửa')
    expect(updated.description).toBe('Mô tả mới')
    expect(updated.imageUrl).toBe(post.imageUrl)
    expect(wpUploads).toBe(1) // only the original create upload — no re-upload without a file
  })

  it('editing can replace the image, proxying the new file to WordPress', async () => {
    const admin = await seedAdmin()
    const created = await createPost(admin.token, { title: 'Bản gốc' })
    const { post } = await created.json<{ post: { id: string; imageUrl: string } }>()

    const patch = await patchPost(admin.token, post.id, { image: {} })
    expect(patch.status).toBe(200)
    const { post: updated } = await patch.json<{ post: { imageUrl: string } }>()
    expect(updated.imageUrl).not.toBe(post.imageUrl)
    expect(wpUploads).toBe(2) // create + this replace
  })

  it('deletes a post', async () => {
    const admin = await seedAdmin()
    const created = await createPost(admin.token, { title: 'Xoá thử' })
    const { post } = await created.json<{ post: { id: string } }>()

    const del = await SELF.fetch(`${BASE}/api/admin/posts/${post.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(del.status).toBe(200)
    expect((await (await get('/api/posts')).json<{ total: number }>()).total).toBe(0)

    // Deleting again → 404.
    const again = await SELF.fetch(`${BASE}/api/admin/posts/${post.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(again.status).toBe(404)
  })
})
