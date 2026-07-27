// Data access for social-proof posts. Pure D1 — no network. The WordPress upload happens in the
// route (via lib/wpMedia); this module only ever stores the resulting image URL.
import type { Page } from './pagination'

export interface PostRow {
  id: string
  title: string
  description: string
  image_url: string
  wp_media_id: number | null
  published: number
  created_by: string
  created_at: string
}

export interface Post {
  id: string
  title: string
  description: string
  imageUrl: string
  published: boolean
  createdAt: string
}

export function toPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    published: row.published === 1,
    createdAt: row.created_at,
  }
}

export interface ListPostsOptions extends Page {
  publishedOnly: boolean
}

export async function listPosts(
  db: D1Database,
  { publishedOnly, page, limit }: ListPostsOptions,
): Promise<{ rows: PostRow[]; total: number }> {
  const where = publishedOnly ? 'WHERE published = 1' : ''
  const offset = (page - 1) * limit

  const [list, count] = await db.batch<PostRow | { n: number }>([
    db
      .prepare(`SELECT * FROM posts ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(limit, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM posts ${where}`),
  ])

  return {
    rows: (list.results as PostRow[]) ?? [],
    total: (count.results as { n: number }[])[0]?.n ?? 0,
  }
}

export interface CreatePostInput {
  title: string
  description: string
  imageUrl: string
  wpMediaId: number | null
  published: boolean
  createdBy: string
  now: string
}

export async function createPost(db: D1Database, input: CreatePostInput): Promise<Post> {
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO posts (id, title, description, image_url, wp_media_id, published, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.description,
      input.imageUrl,
      input.wpMediaId,
      input.published ? 1 : 0,
      input.createdBy,
      input.now,
    )
    .run()

  return {
    id,
    title: input.title,
    description: input.description,
    imageUrl: input.imageUrl,
    published: input.published,
    createdAt: input.now,
  }
}

export interface UpdatePostInput {
  title?: string
  description?: string
  published?: boolean
}

/** Patch the editable fields. Returns the updated post, or null when the id doesn't exist. */
export async function updatePost(
  db: D1Database,
  id: string,
  patch: UpdatePostInput,
): Promise<Post | null> {
  const sets: string[] = []
  const values: (string | number)[] = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    values.push(patch.title)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    values.push(patch.description)
  }
  if (patch.published !== undefined) {
    sets.push('published = ?')
    values.push(patch.published ? 1 : 0)
  }

  if (sets.length > 0) {
    const res = await db
      .prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run()
    if (res.meta.changes === 0) return null
  }

  const row = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRow>()
  return row ? toPost(row) : null
}

/** Delete a post. Returns false when the id didn't exist. */
export async function deletePost(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}
