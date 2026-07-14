export interface FetchResult {
  status: number
  contentType: string | null
  body: Buffer
  finalUrl: string
  /**
   * If the server's Content-Length exceeded the requested limit, we abort
   * before downloading the body. status is 200, body is empty, this is true.
   * Caller decides how to react (skip vs. warn vs. retry without limit).
   */
  tooLarge?: boolean
  contentLength?: number
}

// Honest, non-browser UA. Anti-bot layers (SiteGround, Cloudflare…) fingerprint
// the TLS handshake: a request whose UA claims Chrome but whose TLS ClientHello
// is Node's gets 403'd, while a self-identifying crawler UA passes. Do NOT
// impersonate a browser here — dynamic mode exists for sites that need one.
const DEFAULT_UA = 'SiteClone/0.1 (+https://github.com/harrywang/siteclone)'

export async function fetchUrl(
  url: string,
  opts: { userAgent?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchResult> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    const contentLength = parseInt(res.headers.get('content-length') || '', 10)
    const max = opts.maxBytes ?? 0
    // If the server told us a length and it's over the limit, abort without
    // downloading the body — saves bandwidth on huge files we'd skip anyway.
    if (max > 0 && Number.isFinite(contentLength) && contentLength > max) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: Buffer.alloc(0),
        finalUrl: res.url || url,
        tooLarge: true,
        contentLength,
      }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    // Servers without a Content-Length header — check after the fact.
    if (max > 0 && buf.length > max) {
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: Buffer.alloc(0),
        finalUrl: res.url || url,
        tooLarge: true,
        contentLength: buf.length,
      }
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      body: buf,
      finalUrl: res.url || url,
      contentLength: Number.isFinite(contentLength) ? contentLength : buf.length,
    }
  } finally {
    clearTimeout(t)
  }
}

export function isHtml(contentType: string | null): boolean {
  return !!contentType && /text\/html|application\/xhtml/i.test(contentType)
}

export function isCss(contentType: string | null, urlPath: string): boolean {
  if (contentType && /text\/css/i.test(contentType)) return true
  return /\.css(\?|$)/i.test(urlPath)
}
