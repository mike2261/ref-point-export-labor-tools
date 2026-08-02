// Upload an image to the WordPress media library. Runs SERVER-SIDE ONLY (in the Worker) so the
// Application Password never reaches the browser — the admin client sends the file to our own
// endpoint, and we proxy it up to WP with Basic Auth from the Worker's secrets.

export interface WpUploadResult {
  id: number
  sourceUrl: string
}

export class WpUploadError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`WordPress media upload failed: ${status} ${detail}`)
    this.name = 'WpUploadError'
  }
}

// Only what this module needs from the Worker env — keeps it testable without a full binding.
export interface WpEnv {
  WP_API_BASE: string
  WP_MEDIA_USER: string
  WP_MEDIA_APP_PASSWORD: string
}

// Strip anything that could break the Content-Disposition header; WP only needs a sane filename.
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'upload.jpg'
}

export async function uploadImageToWp(
  env: WpEnv,
  bytes: ArrayBuffer,
  filename: string,
  contentType: string,
): Promise<WpUploadResult> {
  // WP strips the spaces in the Application Password; the raw string (spaces included) is fine.
  const auth = 'Basic ' + btoa(`${env.WP_MEDIA_USER}:${env.WP_MEDIA_APP_PASSWORD}`)

  // multipart/form-data, not a raw binary body: the origin's WAF returns 406 on POSTs with a raw
  // binary body (confirmed by hand — headers alone don't trip it, the body shape does), but lets
  // a normal multipart upload through. Don't set Content-Type manually — fetch derives it from
  // the FormData, boundary included; the part's filename covers what Content-Disposition used to.
  const form = new FormData()
  form.append('file', new File([bytes], safeFilename(filename), { type: contentType }))

  const res = await fetch(`${env.WP_API_BASE}/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      // The origin's WAF also returns 406 for requests without a browser-like UA + Accept.
      'User-Agent': 'xkld-tools-worker/1.0',
      Accept: 'application/json',
    },
    body: form,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new WpUploadError(res.status, detail.slice(0, 300))
  }

  const data = (await res.json()) as { id: number; source_url: string }
  return { id: data.id, sourceUrl: data.source_url }
}
