import path from 'node:path'
import mime from 'mime-types'

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

export function normalizeUrl(input: string, base?: string): URL | null {
  try {
    return new URL(input, base)
  } catch {
    return null
  }
}

export function stripFragment(u: URL): URL {
  const out = new URL(u.toString())
  out.hash = ''
  return out
}

export function isSameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin
}

function bareHost(u: URL): string {
  return u.hostname.replace(/^www\./i, '').toLowerCase()
}

/**
 * Same *site*, ignoring scheme and a leading `www.`.
 *
 * Deliberately looser than isSameOrigin, which compares URL.origin — and
 * URL.origin includes the protocol. A page served over https that references
 * `http://its-own-host/img.png` is a different *origin* but plainly the same
 * site: treating it as external leaves the URL absolute, so the mirror keeps
 * depending on the live host and the browser blocks the load as mixed content.
 * That asset then silently never renders.
 */
export function isSameSite(a: URL, b: URL): boolean {
  return bareHost(a) === bareHost(b)
}

/**
 * Rewrite a same-site URL onto the origin's own scheme/host, so that
 * `http://host/x`, `https://host/x` and `https://www.host/x` all collapse to
 * one canonical URL — one fetch, one local file, one rewritten link.
 */
export function canonicalizeToSite(u: URL, origin: URL): URL {
  if (!isSameSite(u, origin)) return u
  const out = new URL(u.toString())
  out.protocol = origin.protocol
  out.host = origin.host
  return out
}

export function isHttpProtocol(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:'
}

/**
 * Map a URL to a relative path under outputDir.
 * Examples:
 *   https://x.com/             -> index.html
 *   https://x.com/about        -> about/index.html (HTML responses)
 *   https://x.com/about.html   -> about.html
 *   https://x.com/img/a.png    -> img/a.png
 *   https://x.com/?q=1         -> index__q=1.html (queries are folded into the filename)
 */
export function urlToLocalPath(
  u: URL,
  contentType: string | null,
  forceHtml = false,
): string {
  const pathname = decodeURIComponent(u.pathname)
  const isRoot = pathname === '' || pathname === '/'
  const trailingSlash = pathname.endsWith('/')
  const cleanPath = pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  const ext = path.extname(cleanPath).toLowerCase()
  const isHtml =
    forceHtml ||
    (contentType ?? '').toLowerCase().includes('html') ||
    HTML_EXTENSIONS.has(ext)

  let rel: string

  if (isRoot) {
    rel = 'index.html'
  } else if (!ext || trailingSlash) {
    rel = path.join(cleanPath, 'index.html')
  } else if (isHtml && !HTML_EXTENSIONS.has(ext)) {
    rel = `${cleanPath}.html`
  } else {
    rel = cleanPath
  }

  if (u.search) {
    const safeQuery = u.search
      .slice(1)
      .replace(/[/\\?%*:|"<>]/g, '_')
      .slice(0, 80)
    const parsed = path.parse(rel)
    rel = path.join(parsed.dir, `${parsed.name}__${safeQuery}${parsed.ext}`)
  }

  return rel.split(path.sep).map(sanitizeSegment).join('/')
}

function sanitizeSegment(seg: string): string {
  return seg.replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 200) || '_'
}

/**
 * Build a relative URL from one local file path to another.
 * Both paths are POSIX-style relative paths under outputDir.
 */
export function relativeLink(fromPath: string, toPath: string): string {
  const fromDir = path.posix.dirname(fromPath)
  let rel = path.posix.relative(fromDir, toPath)
  if (!rel) rel = path.posix.basename(toPath)
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = `./${rel}`
  return rel
}

export function guessExtension(contentType: string | null): string | null {
  if (!contentType) return null
  const ct = contentType.split(';')[0].trim()
  const ext = mime.extension(ct)
  return ext ? `.${ext}` : null
}

export function ensureExtension(filePath: string, contentType: string | null): string {
  if (path.extname(filePath)) return filePath
  const ext = guessExtension(contentType)
  return ext ? filePath + ext : filePath
}
