import * as cheerio from 'cheerio'
import {
  normalizeUrl,
  isSameSite,
  canonicalizeToSite,
  isHttpProtocol,
  stripFragment,
} from './url-utils'

export interface ExtractedLink {
  rawUrl: string
  absoluteUrl: URL
  kind: 'page' | 'asset' | 'css'
}

const ASSET_ATTRS: Array<[string, string]> = [
  ['link[rel="stylesheet"][href]', 'href'],
  ['link[rel="icon"][href]', 'href'],
  ['link[rel~="apple-touch-icon"][href]', 'href'],
  ['link[rel="manifest"][href]', 'href'],
  ['link[rel="preload"][href]', 'href'],
  ['script[src]', 'src'],
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['audio[src]', 'src'],
  ['video[poster]', 'poster'],
  ['iframe[src]', 'src'],
  ['embed[src]', 'src'],
  ['object[data]', 'data'],
  ['use[href]', 'href'],
]

const SRCSET_SELECTORS = ['img[srcset]', 'source[srcset]']

// <a href> targets with these extensions are downloadable files, not pages.
// Treating them as pages would append .html to the local name (foo.pdf.html)
// and break the link.
const FILE_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt',
  '.zip', '.rar', '.7z', '.tar', '.gz',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp',
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.js', '.css', '.json', '.xml', '.rss', '.atom', '.ics',
])

function isFileLink(u: URL): boolean {
  const m = /\.[a-z0-9]{1,5}$/i.exec(u.pathname)
  return !!m && FILE_EXTENSIONS.has(m[0].toLowerCase())
}

export interface RewriteResult {
  html: string
  pageLinks: URL[] // same-origin <a> links — candidates to crawl
  assetLinks: { url: URL; kind: 'asset' | 'css' }[]
}

/**
 * Parse HTML, extract page links + asset links, replace each URL with the
 * value returned by `mapUrl` (typically a relative local path).
 * `mapUrl` returns null to leave the URL as-is.
 */
export function rewriteHtml(
  html: string,
  baseUrl: URL,
  mapUrl: (u: URL, kind: 'page' | 'asset' | 'css') => string | null,
): RewriteResult {
  const $ = cheerio.load(html)

  // Upgrade lazy-loaded images BEFORE extraction so the asset-discovery loop
  // below sees the high-res URL, not the placeholder. Common WP lazy patterns:
  //   - Uncode adaptive-images: data-guid points to the full-res original
  //   - Standard WP lazy: data-src / data-srcset
  //   - A3/Smush/WP-Rocket: data-lazy-src / data-lazy-srcset
  // We only swap when src isn't already the lazy target — idempotent.
  upgradeLazyImages($)

  const pageLinks: URL[] = []
  const assetLinks: { url: URL; kind: 'asset' | 'css' }[] = []

  // <a href> — page candidates (only same-origin); rewrite if mapped.
  // Links to downloadable files (pdf, images, video…) are assets, not pages.
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href')
    if (!raw) return
    const u = normalizeUrl(raw, baseUrl.toString())
    if (!u || !isHttpProtocol(u)) return
    const stripped = canonicalizeToSite(stripFragment(u), baseUrl)
    if (isSameSite(stripped, baseUrl)) {
      if (isFileLink(stripped)) {
        assetLinks.push({ url: stripped, kind: 'asset' })
        const mapped = mapUrl(stripped, 'asset')
        if (mapped !== null) $(el).attr('href', mapped)
        return
      }
      pageLinks.push(stripped)
      const mapped = mapUrl(stripped, 'page')
      if (mapped !== null) {
        $(el).attr('href', mapped + (u.hash || ''))
      }
    }
  })

  // <link href>, <script src>, etc — assets.
  for (const [sel, attr] of ASSET_ATTRS) {
    $(sel).each((_, el) => {
      const raw = $(el).attr(attr)
      if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) return
      const u = normalizeUrl(raw, baseUrl.toString())
      if (!u || !isHttpProtocol(u)) return
      const kind: 'asset' | 'css' =
        sel.startsWith('link[rel="stylesheet"') ? 'css' : 'asset'
      const stripped = canonicalizeToSite(stripFragment(u), baseUrl)
      assetLinks.push({ url: stripped, kind })
      const mapped = mapUrl(stripped, kind)
      if (mapped !== null) $(el).attr(attr, mapped)
    })
  }

  // srcset attributes — comma-separated list of "url descriptor" entries.
  for (const sel of SRCSET_SELECTORS) {
    $(sel).each((_, el) => {
      const raw = $(el).attr('srcset')
      if (!raw) return
      const rewritten = raw
        .split(',')
        .map((part) => {
          const trimmed = part.trim()
          if (!trimmed) return ''
          const [u, ...rest] = trimmed.split(/\s+/)
          const abs = normalizeUrl(u, baseUrl.toString())
          if (!abs || !isHttpProtocol(abs)) return trimmed
          const stripped = canonicalizeToSite(stripFragment(abs), baseUrl)
          assetLinks.push({ url: stripped, kind: 'asset' })
          const mapped = mapUrl(stripped, 'asset')
          const newU = mapped ?? u
          return [newU, ...rest].join(' ')
        })
        .filter(Boolean)
        .join(', ')
      $(el).attr('srcset', rewritten)
    })
  }

  // Inline <style> — rewrite url() refs.
  $('style').each((_, el) => {
    const css = $(el).html() ?? ''
    const out = rewriteCssUrls(css, baseUrl, (abs) => {
      const stripped = canonicalizeToSite(stripFragment(abs), baseUrl)
      assetLinks.push({ url: stripped, kind: 'asset' })
      return mapUrl(stripped, 'asset')
    })
    $(el).text(out)
  })

  // Inline style="..." attributes.
  $('[style]').each((_, el) => {
    const style = $(el).attr('style')
    if (!style || !/url\(/i.test(style)) return
    const out = rewriteCssUrls(style, baseUrl, (abs) => {
      const stripped = canonicalizeToSite(stripFragment(abs), baseUrl)
      assetLinks.push({ url: stripped, kind: 'asset' })
      return mapUrl(stripped, 'asset')
    })
    $(el).attr('style', out)
  })

  // Strip <base href> — it would break our relative links.
  $('base').remove()

  return {
    html: $.html(),
    pageLinks,
    assetLinks,
  }
}

const LAZY_SRC_ATTRS = [
  'data-guid', // Uncode (full-res original)
  'data-lazy-src', // A3 Lazy Load, WP Rocket
  'data-src', // generic
  'data-original', // generic
  'data-lazysrc',
  'data-img-url',
]

const LAZY_SRCSET_ATTRS = [
  'data-srcset',
  'data-lazy-srcset',
  'data-lazysrcset',
]

function upgradeLazyImages($: cheerio.CheerioAPI): void {
  $('img').each((_, el) => {
    const $el = $(el)
    const currentSrc = ($el.attr('src') || '').trim()
    // Treat empty / data: / common 1x1 placeholders as upgrade-eligible.
    const looksPlaceholder =
      !currentSrc ||
      currentSrc.startsWith('data:') ||
      /1x1|blank|placeholder|spacer|transparent/i.test(currentSrc) ||
      currentSrc.includes('-uai-') // Uncode placeholder marker

    let lazySrc: string | undefined
    for (const attr of LAZY_SRC_ATTRS) {
      const v = $el.attr(attr)
      if (v && v.trim()) {
        lazySrc = v.trim()
        break
      }
    }

    if (lazySrc && (looksPlaceholder || lazySrc !== currentSrc)) {
      $el.attr('src', lazySrc)
      // Drop loading=lazy so browsers fetch eagerly from local files.
      if ($el.attr('loading') === 'lazy') $el.removeAttr('loading')
    }

    let lazySrcset: string | undefined
    for (const attr of LAZY_SRCSET_ATTRS) {
      const v = $el.attr(attr)
      if (v && v.trim()) {
        lazySrcset = v.trim()
        break
      }
    }
    if (lazySrcset) $el.attr('srcset', lazySrcset)
  })

  // <source> inside <picture> often has matching data-srcset.
  $('source').each((_, el) => {
    const $el = $(el)
    for (const attr of LAZY_SRCSET_ATTRS) {
      const v = $el.attr(attr)
      if (v && v.trim()) {
        $el.attr('srcset', v.trim())
        break
      }
    }
  })

  // Inline background-image URLs on non-<img> elements (Uncode hero pattern):
  // div[style*="background-image"] with data-guid → swap the bg URL to the
  // full-res original. The existing rewriteCssUrls pass below will then turn
  // that absolute URL into a local relative path, and the asset extractor
  // will queue it for download.
  $('[data-guid][style*="background-image"], [data-bg-image]').each((_, el) => {
    const $el = $(el)
    const target = ($el.attr('data-guid') || $el.attr('data-bg-image') || '').trim()
    if (!target || !target.startsWith('http')) return
    const style = $el.attr('style') || ''
    if (!/url\(/i.test(style)) {
      $el.attr('style', `${style}; background-image: url("${target}");`)
      return
    }
    const newStyle = style.replace(
      /url\(\s*(['"]?)([^)'"]*)\1\s*\)/i,
      () => `url("${target}")`,
    )
    $el.attr('style', newStyle)
  })

  neutralizeUncodeAdaptive($)
}

/**
 * Uncode's adaptive-images runtime hides every hero/background behind
 * `opacity: 0` and only reveals it (`[data-imgready="true"]`) once its JS has
 * fetched a server-generated `<name>-uai-<w>x<h>.<ext>` variant. WordPress
 * creates those variants on demand, so on a static mirror they 404, the JS
 * stalls in `.adaptive-fetching`, and the background never becomes visible.
 *
 * The full-res original is already inlined by upgradeLazyImages above, so here
 * we simply retire the runtime: drop the hooks it keys on and hand-set the
 * "image is ready" flags the CSS waits for.
 */
function neutralizeUncodeAdaptive($: cheerio.CheerioAPI): void {
  $('.adaptive-async, .adaptive-fetching').each((_, el) => {
    const $el = $(el)
    const kept = ($el.attr('class') || '')
      .split(/\s+/)
      .filter((c) => c && c !== 'adaptive-async' && c !== 'adaptive-fetching')
    // `async-done` is the theme's own "finished" class — it also carries the
    // img sizing rules (img.adaptive-async, img.async-done { width: 100% }).
    if (!kept.includes('async-done')) kept.push('async-done')
    $el.attr('class', kept.join(' '))
    $el.attr('data-imgready', 'true')
    $el.removeAttr('data-guid')
    $el.removeAttr('data-uniqueid')
  })

  // Header hero is gated on the wrapper, not the background element itself.
  $('#page-header').attr('data-imgready', 'true')
  $('.background-inner').attr('data-imgready', 'true')

  // Scroll-reveal gating: `.animate_when_almost_visible` starts at opacity 0 and
  // is only revealed once the theme's Waypoints runner fires. In an archived
  // snapshot that runner is unreliable (it depends on the full WP/plugin JS
  // chain), and text that never fades in is text that is simply missing. Drop
  // the gate — the content renders immediately, minus the fade.
  $('.animate_when_almost_visible').each((_, el) => {
    const $el = $(el)
    const kept = ($el.attr('class') || '')
      .split(/\s+/)
      .filter((c) => c && c !== 'animate_when_almost_visible')
    $el.attr('class', kept.join(' '))
  })
}

/**
 * Uncode's init JS pulls the background URL out of a row's *inline* style with
 * a regex that only accepts absolute URLs:
 *
 *   var url = obj.style.backgroundImage.match(uri_pattern)
 *   image.src = url[0]           // ← TypeError when url is null
 *
 * A mirror rewrites those to relative paths (`url(./wp-content/…)`), which the
 * regex cannot match, so `url` is null and the throw kills the theme's entire
 * init — leaving hero backgrounds black. Widen it to accept relative paths too.
 */
export function patchUncodeJs(js: string): string {
  if (!/uri_pattern\s*=\s*\//.test(js)) return js
  const widened = String.raw`/(?:[a-z][\w-]+:(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|\.{0,2}\/)[^\s()<>"']+/i`
  // Minified builds write `uri_pattern=/…/`, unminified ones `uri_pattern = /…/`.
  const decl = /uri_pattern\s*=\s*\//g

  let out = ''
  let cursor = 0
  for (;;) {
    decl.lastIndex = cursor
    const m = decl.exec(js)
    if (!m) break
    const at = m.index
    const slash = m.index + m[0].length - 1
    // Walk the regex literal so we replace exactly it, not a fixed byte count.
    let i = slash + 1
    let inClass = false
    let end = -1
    while (i < js.length) {
      const c = js[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        i++
        while (i < js.length && /[a-z]/i.test(js[i])) i++
        end = i
        break
      }
      i++
    }
    if (end === -1) break
    out += js.slice(cursor, at) + 'uri_pattern=' + widened
    cursor = end
  }
  return out + js.slice(cursor)
}

const URL_RE = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi

export function rewriteCssUrls(
  css: string,
  baseUrl: URL,
  mapUrl: (abs: URL) => string | null,
): string {
  return css.replace(URL_RE, (match, quote: string, raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) return match
    const abs = normalizeUrl(trimmed, baseUrl.toString())
    if (!abs || !isHttpProtocol(abs)) return match
    const mapped = mapUrl(abs)
    if (mapped === null) return match
    return `url(${quote}${mapped}${quote})`
  })
}

// Quoted media paths inside JavaScript, e.g. Dreamweaver rollovers:
//   MM_swapImage('keynote','','images/bt_keynote_over.gif',1)
// The URL never appears in an href/src, so an HTML-attribute crawler never sees
// it and never mirrors the file — the button renders fine until you hover it,
// then shows a broken-image icon.
const JS_MEDIA_RE =
  /['"]([A-Za-z0-9_\-./%:]+\.(?:gif|jpe?g|png|webp|svg|ico|bmp|mp4|webm|mp3|ogg|wav|woff2?|ttf|eot))['"]/gi

/**
 * Media referenced from JS source (inline <script> or a .js file).
 *
 * Relative paths in JS resolve against the *document*, not the script, so the
 * caller passes the page URL as `baseUrl`. Paths are only discovered here, not
 * rewritten: the mirror keeps the original directory layout, so the original
 * relative path still resolves — and rewriting string literals inside minified
 * JS risks corrupting code for no gain.
 */
export function extractJsMediaUrls(js: string, baseUrl: URL): URL[] {
  const out: URL[] = []
  for (const m of js.matchAll(JS_MEDIA_RE)) {
    const raw = m[1]
    if (raw.startsWith('data:')) continue
    const abs = normalizeUrl(raw, baseUrl.toString())
    if (abs && isHttpProtocol(abs)) out.push(stripFragment(abs))
  }
  return out
}

/**
 * Media referenced from JS embedded in a page — both <script> blocks and inline
 * event-handler attributes.
 *
 * The handler attributes matter as much as the script blocks: the classic
 * Dreamweaver rollover puts the hover image in `onmouseover`, and the preload
 * list in `<body onload>`, so a crawler that only reads <script> still misses
 * every `_over.gif` on the site.
 */
export function extractInlineScriptMedia(html: string, baseUrl: URL): URL[] {
  const $ = cheerio.load(html)
  const out: URL[] = []

  $('script:not([src])').each((_, el) => {
    const js = $(el).html()
    if (js) out.push(...extractJsMediaUrls(js, baseUrl))
  })

  $('*').each((_, el) => {
    const attribs = (el as unknown as { attribs?: Record<string, string> }).attribs
    if (!attribs) return
    for (const [name, value] of Object.entries(attribs)) {
      if (!name.toLowerCase().startsWith('on') || !value) continue
      out.push(...extractJsMediaUrls(value, baseUrl))
    }
  })

  return out
}

export function extractCssUrls(css: string, baseUrl: URL): URL[] {
  const out: URL[] = []
  for (const m of css.matchAll(URL_RE)) {
    const raw = m[2].trim()
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue
    const abs = normalizeUrl(raw, baseUrl.toString())
    if (abs && isHttpProtocol(abs)) out.push(stripFragment(abs))
  }
  // @import "url"; — also needed
  for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) {
    const abs = normalizeUrl(m[1], baseUrl.toString())
    if (abs && isHttpProtocol(abs)) out.push(stripFragment(abs))
  }
  return out
}
