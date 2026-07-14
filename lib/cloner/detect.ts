import * as cheerio from 'cheerio'
import { fetchUrl } from './fetcher'
import { renderPage } from './renderer'

export type DetectedStack =
  | 'wordpress'
  | 'shopify'
  | 'wix'
  | 'squarespace'
  | 'webflow'
  | 'ghost'
  | 'drupal'
  | 'joomla'
  | 'nextjs'
  | 'nuxt'
  | 'gatsby'
  | 'react-spa'
  | 'vue-spa'
  | 'angular'
  | 'svelte-kit'
  | 'hugo'
  | 'jekyll'
  | 'eleventy'
  | 'docusaurus'
  | 'mkdocs'
  | 'static'
  | 'unknown'

export interface DetectResult {
  url: string
  finalUrl: string
  status: number
  reachable: boolean
  blocked: boolean // 403/429/503 — likely TLS fingerprint or anti-bot
  blockedButContentReadable: boolean // body looks like real HTML despite the status
  stack: DetectedStack
  stackLabel: string
  version: string | null
  theme: string | null // WordPress theme slug, when applicable
  generator: string | null
  server: string | null
  cdn: string | null
  recommendedMode: 'static' | 'dynamic'
  recommendationReason: string
  signals: string[]
}

/**
 * Probe a URL with a single browser-like GET, then classify the response by
 * meta tags, headers, asset paths, and global JS markers visible in the HTML.
 * Returns enough info to display in the UI and to pick the right clone mode.
 */
export async function detectStack(url: string): Promise<DetectResult> {
  const result: DetectResult = {
    url,
    finalUrl: url,
    status: 0,
    reachable: false,
    blocked: false,
    blockedButContentReadable: false,
    stack: 'unknown',
    stackLabel: 'Unknown',
    version: null,
    theme: null,
    generator: null,
    server: null,
    cdn: null,
    recommendedMode: 'static',
    recommendationReason: '',
    signals: [],
  }

  let res: Awaited<ReturnType<typeof fetchUrl>>
  try {
    res = await fetchUrl(url, { timeoutMs: 15_000 })
  } catch (err: unknown) {
    result.recommendationReason = `Network error: ${err instanceof Error ? err.message : String(err)}`
    return result
  }

  result.status = res.status
  result.finalUrl = res.finalUrl
  result.reachable = true

  if (res.status >= 400) {
    result.blocked = res.status === 403 || res.status === 429 || res.status === 503
  }

  const isHtml = (res.contentType ?? '').toLowerCase().includes('html')
  const html = isHtml ? res.body.toString('utf-8') : ''
  if (html.length > 1024) result.blockedButContentReadable = result.blocked

  if (html) {
    classifyFromHtml(html, result)
  }

  // Headers may give us server / CDN hints — but raw fetch doesn't expose these
  // directly; we keep the slot for future enhancement (HEAD request).
  // For now, infer CDN from the response body's link refs.
  if (/cloudflare|cf-ray/i.test(html)) result.cdn = 'Cloudflare'
  else if (/akamai/i.test(html)) result.cdn = 'Akamai'

  // ─── Mode recommendation ─────────────────────────────────────
  if (result.blocked) {
    result.recommendedMode = 'dynamic'
    result.recommendationReason =
      `Server returned ${result.status} to Node fetch — likely TLS-fingerprint blocking. ` +
      `Dynamic mode uses real Chromium and usually gets through.`
  } else if (
    result.stack === 'react-spa' ||
    result.stack === 'vue-spa' ||
    result.stack === 'angular' ||
    result.stack === 'svelte-kit' ||
    result.stack === 'gatsby'
  ) {
    result.recommendedMode = 'dynamic'
    result.recommendationReason = `${result.stackLabel} renders content via JS — dynamic mode captures the post-JS DOM.`
  } else if (result.stack === 'nextjs' || result.stack === 'nuxt') {
    // SSR by default — static usually works, but dynamic catches client-only widgets.
    result.recommendedMode = 'static'
    result.recommendationReason = `${result.stackLabel} server-renders pages — static mode usually works. Switch to dynamic if you need client-only widgets.`
  } else if (result.stack === 'wordpress') {
    result.recommendedMode = 'static'
    result.recommendationReason = `WordPress is server-rendered — static mode is fast and faithful.`
  } else if (result.stack === 'static' || result.stack === 'jekyll' || result.stack === 'hugo' || result.stack === 'eleventy') {
    result.recommendedMode = 'static'
    result.recommendationReason = `${result.stackLabel} — pure static, fastest with static mode.`
  } else if (result.stack === 'unknown') {
    result.recommendedMode = 'static'
    result.recommendationReason = `Couldn't identify stack — try static first; switch to dynamic if assets fail.`
  } else {
    result.recommendedMode = 'static'
    result.recommendationReason = `${result.stackLabel} — static mode usually works.`
  }

  return result
}

/**
 * Same as `detectStack`, but if the Node fetch was blocked AND Chromium is
 * available, runs a second probe via Playwright so we can classify TLS-protected
 * sites (e.g. WordPress behind a CDN doing JA3 fingerprinting). Falls back to
 * the shallow result if the deep probe fails.
 */
export async function detectStackDeep(url: string): Promise<DetectResult> {
  const shallow = await detectStack(url)
  const needsDeep =
    shallow.blocked || shallow.stack === 'unknown' || shallow.stack === 'static'
  if (!needsDeep) return shallow

  try {
    const cap = await renderPage(url, { timeoutMs: 30_000, waitUntil: 'load' })
    const enriched: DetectResult = {
      ...shallow,
      finalUrl: cap.finalUrl,
      // Reset stack-specific fields so we can re-classify cleanly.
      stack: 'unknown',
      stackLabel: 'Unknown',
      version: null,
      theme: null,
      generator: null,
      signals: [...shallow.signals, '(deep-probed via Playwright)'],
    }
    classifyFromHtml(cap.html, enriched)
    // Recommendation: still dynamic if we needed Playwright to see the real page.
    enriched.recommendedMode = shallow.blocked ? 'dynamic' : enriched.recommendedMode
    if (shallow.blocked) {
      enriched.recommendationReason =
        `${enriched.stackLabel} site, but the CDN blocks Node fetch (HTTP ${shallow.status}). ` +
        `Use Dynamic mode — Playwright's real Chromium gets through.`
    }
    return enriched
  } catch {
    // Browser launch failed or timed out — return the shallow result; user can still proceed.
    return shallow
  }
  // Note: we don't shut down the renderer here. If the user clicks Start
  // clone right after detect, they'd hit a freshly closed browser singleton
  // (race) and the whole clone would fail. The engine's run() owns lifecycle.
}

function classifyFromHtml(html: string, result: DetectResult): void {
  const $ = cheerio.load(html)
  result.generator = $('meta[name="generator"]').attr('content') || result.generator

  const linkRefs: string[] = []
  $('link[href], script[src]').each((_, el) => {
    const v = $(el).attr('href') || $(el).attr('src')
    if (v) linkRefs.push(v)
  })
  const refsBlob = linkRefs.join(' ')
  const bodyClass = $('body').attr('class') || ''
  const htmlClass = $('html').attr('class') || ''

  // ─── WordPress ──────────────────────────────────────────────
  if (
    /wordpress/i.test(result.generator || '') ||
    /\/wp-content\//.test(refsBlob) ||
    /\/wp-includes\//.test(refsBlob) ||
    $('link[rel="https://api.w.org/"]').length > 0
  ) {
    result.stack = 'wordpress'
    const m = (result.generator || '').match(/WordPress\s+([\d.]+)/i)
    if (m) result.version = m[1]
    const themeMatch = refsBlob.match(/\/wp-content\/themes\/([^/]+)\//)
    if (themeMatch) result.theme = themeMatch[1]
    result.signals.push('WordPress paths in <link>/<script>')
    if (result.theme) result.signals.push(`Theme: ${result.theme}`)
    result.stackLabel = result.theme
      ? `WordPress${result.version ? ' ' + result.version : ''} (${result.theme})`
      : `WordPress${result.version ? ' ' + result.version : ''}`
  }

  // ─── Other CMS / commerce ───────────────────────────────────
  else if (/shopify/i.test(refsBlob) || /cdn\.shopify\.com/.test(refsBlob)) {
    result.stack = 'shopify'
    result.stackLabel = 'Shopify'
    result.signals.push('Shopify CDN refs')
  } else if (/wixstatic\.com|wix\.com/.test(refsBlob) || /wix-/.test(bodyClass)) {
    result.stack = 'wix'
    result.stackLabel = 'Wix'
    result.signals.push('Wix asset hosts')
  } else if (
    /squarespace/i.test(result.generator || '') ||
    /static\.squarespace\.com/.test(refsBlob)
  ) {
    result.stack = 'squarespace'
    result.stackLabel = 'Squarespace'
  } else if (/webflow/i.test(result.generator || '') || /assets\.website-files\.com/.test(refsBlob)) {
    result.stack = 'webflow'
    result.stackLabel = 'Webflow'
  } else if (/ghost/i.test(result.generator || '')) {
    result.stack = 'ghost'
    const m = (result.generator || '').match(/Ghost\s+([\d.]+)/i)
    if (m) result.version = m[1]
    result.stackLabel = `Ghost${result.version ? ' ' + result.version : ''}`
  } else if (
    /drupal/i.test(result.generator || '') ||
    /\/sites\/(default|all)\/(modules|themes)\//.test(refsBlob)
  ) {
    result.stack = 'drupal'
    const m = (result.generator || '').match(/Drupal\s+([\d.]+)/i)
    if (m) result.version = m[1]
    result.stackLabel = `Drupal${result.version ? ' ' + result.version : ''}`
  } else if (/joomla/i.test(result.generator || '')) {
    result.stack = 'joomla'
    result.stackLabel = 'Joomla'
  }

  // ─── JS frameworks (SPAs) ───────────────────────────────────
  else if ($('#__next, script#__NEXT_DATA__').length > 0 || /\/_next\//.test(refsBlob)) {
    result.stack = 'nextjs'
    result.stackLabel = 'Next.js'
  } else if ($('#__nuxt, #__layout').length > 0 || /\/_nuxt\//.test(refsBlob)) {
    result.stack = 'nuxt'
    result.stackLabel = 'Nuxt'
  } else if ($('[data-gatsby-page], #___gatsby').length > 0) {
    result.stack = 'gatsby'
    result.stackLabel = 'Gatsby'
  } else if ($('[ng-version], app-root').length > 0) {
    result.stack = 'angular'
    const v = $('[ng-version]').attr('ng-version')
    if (v) result.version = v
    result.stackLabel = `Angular${v ? ' ' + v : ''}`
  } else if ($('[data-reactroot], div#root, div#app').length > 0 && /react/i.test(refsBlob)) {
    result.stack = 'react-spa'
    result.stackLabel = 'React (SPA)'
  } else if (/svelte-kit|kit\.svelte\.dev/.test(refsBlob)) {
    result.stack = 'svelte-kit'
    result.stackLabel = 'SvelteKit'
  }

  // ─── Static-site generators ─────────────────────────────────
  else if (/hugo/i.test(result.generator || '')) {
    result.stack = 'hugo'
    result.stackLabel = 'Hugo'
  } else if (/jekyll/i.test(result.generator || '')) {
    result.stack = 'jekyll'
    result.stackLabel = 'Jekyll'
  } else if (/eleventy|11ty/i.test(result.generator || '')) {
    result.stack = 'eleventy'
    result.stackLabel = 'Eleventy'
  } else if ($('[class*="docusaurus"]').length > 0 || /docusaurus/i.test(refsBlob)) {
    result.stack = 'docusaurus'
    result.stackLabel = 'Docusaurus'
  } else if (/mkdocs/i.test(result.generator || '')) {
    result.stack = 'mkdocs'
    result.stackLabel = 'MkDocs'
  } else {
    const hasMuchJs = $('script[src]').length >= 5
    if (!hasMuchJs) {
      result.stack = 'static'
      result.stackLabel = 'Static HTML'
    }
  }

  if (htmlClass) result.signals.push(`html class: ${htmlClass.slice(0, 60)}`)
  if (bodyClass) result.signals.push(`body class: ${bodyClass.slice(0, 60)}`)
  if (result.generator) result.signals.push(`generator: ${result.generator}`)
}
