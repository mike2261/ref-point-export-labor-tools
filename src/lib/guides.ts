// Data access for CTV guide posts ("Hướng dẫn CTV"). Pure D1 — no network. The WordPress upload
// happens in the route (via lib/wpMedia); this module only ever stores the resulting image URL.
import type { Page } from './pagination'

export interface GuideRow {
  id: string
  title: string
  description: string
  image_url: string
  wp_media_id: number | null
  published: number
  created_by: string
  created_at: string
}

export interface Guide {
  id: string
  title: string
  description: string
  imageUrl: string
  published: boolean
  createdAt: string
}

export function toGuide(row: GuideRow): Guide {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    published: row.published === 1,
    createdAt: row.created_at,
  }
}

export interface ListGuidesOptions extends Page {
  publishedOnly: boolean
}

export async function listGuides(
  db: D1Database,
  { publishedOnly, page, limit }: ListGuidesOptions,
): Promise<{ rows: GuideRow[]; total: number }> {
  const where = publishedOnly ? 'WHERE published = 1' : ''
  const offset = (page - 1) * limit

  const [list, count] = await db.batch<GuideRow | { n: number }>([
    db
      .prepare(`SELECT * FROM guides ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(limit, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM guides ${where}`),
  ])

  return {
    rows: (list.results as GuideRow[]) ?? [],
    total: (count.results as { n: number }[])[0]?.n ?? 0,
  }
}

export interface CreateGuideInput {
  title: string
  description: string
  imageUrl: string
  wpMediaId: number | null
  published: boolean
  createdBy: string
  now: string
}

export async function createGuide(db: D1Database, input: CreateGuideInput): Promise<Guide> {
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO guides (id, title, description, image_url, wp_media_id, published, created_by, created_at)
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

export interface UpdateGuideInput {
  title?: string
  description?: string
  imageUrl?: string
  wpMediaId?: number | null
}

/** Single guide lookup, for the admin edit page (prefilling the form). */
export async function findGuideById(db: D1Database, id: string): Promise<Guide | null> {
  const row = await db.prepare('SELECT * FROM guides WHERE id = ?').bind(id).first<GuideRow>()
  return row ? toGuide(row) : null
}

/** Patch the editable fields. Returns the updated guide, or null when the id doesn't exist. */
export async function updateGuide(
  db: D1Database,
  id: string,
  patch: UpdateGuideInput,
): Promise<Guide | null> {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    values.push(patch.title)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    values.push(patch.description)
  }
  if (patch.imageUrl !== undefined) {
    sets.push('image_url = ?')
    values.push(patch.imageUrl)
    sets.push('wp_media_id = ?')
    values.push(patch.wpMediaId ?? null)
  }

  if (sets.length > 0) {
    const res = await db
      .prepare(`UPDATE guides SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values, id)
      .run()
    if (res.meta.changes === 0) return null
  }

  const row = await db.prepare('SELECT * FROM guides WHERE id = ?').bind(id).first<GuideRow>()
  return row ? toGuide(row) : null
}

/** Delete a guide. Returns false when the id didn't exist. */
export async function deleteGuide(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM guides WHERE id = ?').bind(id).run()
  return res.meta.changes > 0
}
