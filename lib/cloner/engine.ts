import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchUrl, isHtml, isCss } from './fetcher'
import { renderPage, shutdownRenderer } from './renderer'
import {
  normalizeUrl,
  stripFragment,
  isSameSite,
  canonicalizeToSite,
  isHttpProtocol,
  urlToLocalPath,
  relativeLink,
  ensureExtension,
} from './url-utils'
import {
  rewriteHtml,
  rewriteCssUrls,
  extractCssUrls,
  extractJsMediaUrls,
  extractInlineScriptMedia,
  patchUncodeJs,
} from './html-rewrite'
import type { CloneOptions, JobLogEntry, JobStats, JobStatus } from './types'

interface EngineCallbacks {
  onLog: (entry: JobLogEntry) => void
  onStats: (stats: JobStats) => void
  onStatus: (s: JobStatus) => void
  isCancelled: () => boolean
}

interface QueueItem {
  url: URL
  depth: number
  kind: 'page' | 'asset' | 'css'
}

/**
 * Static-mode crawler. BFS over same-origin pages up to options.depth,
 * downloading every referenced asset. HTML responses get URL rewriting
 * so the saved folder works as a self-contained static site.
 */
export class CloneEngine {
  private options: CloneOptions
  private cb: EngineCallbacks
  private origin!: URL
  private visited = new Map<string, string>() // absolute url -> local path
  private pending = new Map<string, Promise<string | null>>()
  private failed = new Set<string>() // urls that already failed — don't refetch per referencing page
  private stats: JobStats = {
    pagesCrawled: 0,
    assetsCrawled: 0,
    bytesWritten: 0,
    errors: 0,
    failedUrls: [],
  }
  private inFlight = 0
  private queue: QueueItem[] = []
  private waiters: Array<() => void> = []

  constructor(options: CloneOptions, cb: EngineCallbacks) {
    this.options = options
    this.cb = cb
  }

  async run(): Promise<void> {
    const start = normalizeUrl(this.options.url)
    if (!start || !isHttpProtocol(start)) {
      throw new Error(`Invalid URL: ${this.options.url}`)
    }
    this.origin = start

    await mkdir(this.options.outputDir, { recursive: true })
    this.cb.onStatus('running')
    this.log('info', `Cloning ${start.toString()} to ${this.options.outputDir}`)
    this.log('info', `Depth=${this.options.depth}, mode=${this.options.mode}, concurrency=${this.options.concurrency}`)

    // Seed
    this.enqueue({ url: stripFragment(start), depth: 0, kind: 'page' })

    // Worker pool
    const workers: Promise<void>[] = []
    for (let i = 0; i < Math.max(1, this.options.concurrency); i++) {
      workers.push(this.worker())
    }
    await Promise.all(workers)

    if (this.options.mode === 'dynamic') {
      await shutdownRenderer()
    }

    this.cb.onStats(this.stats)
    if (this.cb.isCancelled()) {
      this.cb.onStatus('cancelled')
      this.log('warn', 'Cancelled by user')
    } else {
      await this.auditSelfContained()
      this.cb.onStatus('done')
      this.log('info', `Done. ${this.stats.pagesCrawled} pages, ${this.stats.assetsCrawled} assets, ${(this.stats.bytesWritten / 1024).toFixed(1)} KiB`)
    }
  }

  /**
   * A clone that still loads assets off the network isn't a backup — it dies
   * with the origin, and any http:// asset on an https:// page is silently
   * blocked as mixed content. Neither failure is visible in the crawl stats, so
   * check the written output and say so plainly.
   */
  private async auditSelfContained(): Promise<void> {
    const ASSET_REF =
      /(?:src\s*=\s*["']|url\(\s*["']?|<link[^>]*href\s*=\s*["'])(https?:\/\/[^"')\s>]+)/gi
    const offenders = new Map<string, number>()
    let mixed = 0

    const walk = async (dir: string): Promise<string[]> => {
      const { readdir } = await import('node:fs/promises')
      const out: string[] = []
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) out.push(...(await walk(p)))
        else if (/\.(html?|css)$/i.test(ent.name)) out.push(p)
      }
      return out
    }

    try {
      const { readFile } = await import('node:fs/promises')
      for (const file of await walk(this.options.outputDir)) {
        const text = await readFile(file, 'utf-8')
        for (const m of text.matchAll(ASSET_REF)) {
          let u: URL
          try {
            u = new URL(m[1])
          } catch {
            continue
          }
          offenders.set(u.hostname, (offenders.get(u.hostname) ?? 0) + 1)
          if (u.protocol === 'http:') mixed++
        }
      }
    } catch {
      return // audit is advisory; never fail a completed clone over it
    }

    if (offenders.size === 0) {
      this.log('info', 'Self-contained: every asset resolves to a local file.')
      return
    }

    const top = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    const total = [...offenders.values()].reduce((a, b) => a + b, 0)
    this.log(
      'warn',
      `${total} asset reference(s) still load from the network — this folder is not fully self-contained: ` +
        top.map(([h, n]) => `${h} (${n})`).join(', '),
    )
    if (mixed > 0) {
      this.log(
        'warn',
        `${mixed} of them use http://, which a browser blocks as mixed content on an https page — ` +
          `those assets will silently fail to render.`,
      )
    }
  }

  getStats(): JobStats {
    return { ...this.stats, failedUrls: [...this.stats.failedUrls] }
  }

  // ─── queue plumbing ───────────────────────────────────────────────

  private enqueue(item: QueueItem) {
    const key = item.url.toString()
    if (this.visited.has(key) || this.pending.has(key) || this.failed.has(key)) return
    this.queue.push(item)
    const w = this.waiters.shift()
    if (w) w()
  }

  private async dequeue(): Promise<QueueItem | null> {
    while (true) {
      if (this.cb.isCancelled()) return null
      if (this.queue.length > 0) return this.queue.shift()!
      if (this.inFlight === 0) return null
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private async worker() {
    while (true) {
      const item = await this.dequeue()
      if (!item) return
      this.inFlight++
      try {
        await this.process(item)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log('error', `Failed ${item.url.toString()}: ${msg}`)
        this.stats.errors++
        this.stats.failedUrls.push(item.url.toString())
      } finally {
        this.inFlight--
        // wake any waiters so they can re-evaluate (queue may have grown)
        for (const w of this.waiters.splice(0)) w()
      }
    }
  }

  // ─── per-url processing ───────────────────────────────────────────

  private async process(item: QueueItem) {
    const key = item.url.toString()
    if (this.visited.has(key) || this.pending.has(key) || this.failed.has(key)) return
    if (!isSameSite(item.url, this.origin)) return

    const promise = this.fetchAndSave(item)
    this.pending.set(key, promise)
    try {
      const localPath = await promise
      if (localPath) this.visited.set(key, localPath)
      else this.failed.add(key)
    } catch (err) {
      this.failed.add(key)
      throw err
    } finally {
      this.pending.delete(key)
    }
  }

  private async fetchAndSave(item: QueueItem): Promise<string | null> {
    if (this.cb.isCancelled()) return null
    const urlStr = item.url.toString()
    this.log('info', `→ ${urlStr}`)

    if (this.options.mode === 'dynamic' && item.kind === 'page') {
      return this.handleDynamicPage(item)
    }

    const res = await fetchUrl(urlStr, {
      userAgent: this.options.userAgent,
      timeoutMs: this.options.timeoutMs,
      maxBytes: this.options.maxFileSizeBytes,
    })

    if (res.tooLarge) {
      this.log(
        'warn',
        `Skipping ${urlStr}: ${(res.contentLength ?? 0) / 1024 / 1024 | 0} MiB exceeds size limit (${(this.options.maxFileSizeBytes / 1024 / 1024) | 0} MiB)`,
      )
      this.stats.errors++
      this.stats.failedUrls.push(urlStr)
      return null
    }

    const html = isHtml(res.contentType)
    const css = isCss(res.contentType, item.url.pathname)

    if (res.status >= 400) {
      // Misconfigured proxies sometimes return 4xx with the real page body.
      // Only save in that case for *pages* — for assets, an HTML body almost
      // always means a block page, which would corrupt the snapshot.
      const isPageWithRealBody =
        item.kind === 'page' && html && res.body.length > 1024
      if (!isPageWithRealBody) {
        this.log('warn', `${res.status} ${urlStr}`)
        // Seed-URL 403/429/503 in static mode almost always means TLS-fingerprint
        // blocking (Cloudflare, Akamai…) — tell the user to switch modes.
        if (
          item.depth === 0 &&
          item.kind === 'page' &&
          this.options.mode === 'static' &&
          (res.status === 403 || res.status === 429 || res.status === 503)
        ) {
          this.log(
            'error',
            `Seed URL was blocked (HTTP ${res.status}). This site likely uses TLS-fingerprint ` +
              `or bot-detection that Node's fetch can't bypass. Try Dynamic (Playwright) mode — ` +
              `it uses a real Chromium and usually gets through.`,
          )
        }
        this.stats.errors++
        this.stats.failedUrls.push(urlStr)
        return null
      }
      this.log('warn', `${res.status} ${urlStr} — saving body anyway (${res.body.length} bytes)`)
    }

    if (html && item.kind === 'page') {
      return this.handleHtml(item, res.body, res.contentType)
    }
    if (css || item.kind === 'css') {
      return this.handleCss(item, res.body, res.contentType)
    }
    return this.handleBinary(item, res.body, res.contentType)
  }

  private async handleDynamicPage(item: QueueItem): Promise<string | null> {
    const cap = await renderPage(item.url.toString(), {
      userAgent: this.options.userAgent,
      timeoutMs: this.options.timeoutMs,
      maxFileSizeBytes: this.options.maxFileSizeBytes,
    })

    // Save every same-origin sub-resource Chromium downloaded while rendering.
    // Bypasses the TLS-fingerprint check that blocks Node fetch on protected CDNs.
    // Pre-marking each URL as visited makes the HTML rewrite below skip enqueueing
    // them for a (doomed) Node fetch.
    for (const asset of cap.assets) {
      let absUrl: URL
      try {
        absUrl = new URL(asset.url)
      } catch {
        continue
      }
      if (!isSameSite(absUrl, this.origin)) continue
      const stripped = stripFragment(absUrl)
      const key = stripped.toString()
      if (key === item.url.toString()) continue // the page itself
      if (this.visited.has(key) || this.pending.has(key)) continue

      try {
        const localPath = await this.saveCapturedAsset(stripped, asset.body, asset.contentType)
        if (localPath) {
          this.visited.set(key, localPath)
          this.log('info', `✓ ${stripped.toString()} (captured)`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.log('warn', `Failed to save captured asset ${stripped.toString()}: ${msg}`)
      }
    }

    return this.handleHtml(item, Buffer.from(cap.html, 'utf-8'), 'text/html; charset=utf-8')
  }

  private async saveCapturedAsset(
    url: URL,
    body: Buffer,
    contentType: string | null,
  ): Promise<string | null> {
    const html = isHtml(contentType)
    const css = isCss(contentType, url.pathname)

    // Skip HTML responses captured during render — they're (sub)pages, not assets.
    if (html) return null

    if (css) {
      const localPath = ensureExtension(urlToLocalPath(url, contentType, false), contentType)
      const cssText = body.toString('utf-8')
      const rewritten = rewriteCssUrls(cssText, url, (abs) => {
        if (!isSameSite(abs, this.origin)) return null
        const target = urlToLocalPath(abs, null, false)
        return relativeLink(localPath, target)
      })
      await this.writeFile(localPath, Buffer.from(rewritten, 'utf-8'))
      this.stats.assetsCrawled++
      this.cb.onStats(this.stats)
      return localPath
    }

    const localPath = ensureExtension(urlToLocalPath(url, contentType, false), contentType)
    await this.writeFile(localPath, body)
    this.stats.assetsCrawled++
    this.cb.onStats(this.stats)
    return localPath
  }

  private async handleHtml(
    item: QueueItem,
    body: Buffer,
    contentType: string | null,
  ): Promise<string> {
    const localPath = urlToLocalPath(item.url, contentType, true)
    const html = body.toString('utf-8')

    const childPages: URL[] = []
    const childAssets: { url: URL; kind: 'asset' | 'css' }[] = []

    const result = rewriteHtml(html, item.url, (u, kind) => {
      if (!isSameSite(u, this.origin)) return null
      if (kind === 'page') {
        childPages.push(u)
        // Predict the page's local path so we can write the relative link now.
        const target = urlToLocalPath(u, null, true)
        return relativeLink(localPath, target)
      } else {
        childAssets.push({ url: u, kind })
        const target = urlToLocalPath(u, null, false)
        return relativeLink(localPath, target)
      }
    })

    await this.writeFile(localPath, Buffer.from(result.html, 'utf-8'))
    this.stats.pagesCrawled++
    this.cb.onStats(this.stats)

    // Enqueue children.
    if (item.depth < this.options.depth) {
      for (const u of childPages) {
        this.enqueue({ url: u, depth: item.depth + 1, kind: 'page' })
      }
    }
    if (this.options.includeAssets) {
      for (const a of childAssets) {
        this.enqueue({ url: a.url, depth: item.depth, kind: a.kind })
      }
      // Media that only ever appears inside a <script> — hover/rollover images
      // and the like. Discovered, not rewritten: the mirror keeps the original
      // layout, so the path in the JS still resolves.
      for (const u of extractInlineScriptMedia(html, item.url)) {
        if (isSameSite(u, this.origin)) {
          this.enqueue({ url: canonicalizeToSite(u, this.origin), depth: item.depth, kind: 'asset' })
        }
      }
    }

    return localPath
  }

  private async handleCss(
    item: QueueItem,
    body: Buffer,
    contentType: string | null,
  ): Promise<string> {
    const localPath = ensureExtension(urlToLocalPath(item.url, contentType, false), contentType)
    const css = body.toString('utf-8')

    // Schedule fetch for any url() refs first
    const refs = extractCssUrls(css, item.url)
    for (const u of refs) {
      if (isSameSite(u, this.origin)) {
        this.enqueue({ url: u, depth: item.depth, kind: 'asset' })
      }
    }

    const rewritten = rewriteCssUrls(css, item.url, (abs) => {
      if (!isSameSite(abs, this.origin)) return null
      const target = urlToLocalPath(abs, null, false)
      return relativeLink(localPath, target)
    })

    await this.writeFile(localPath, Buffer.from(rewritten, 'utf-8'))
    this.stats.assetsCrawled++
    this.cb.onStats(this.stats)
    return localPath
  }

  private async handleBinary(
    item: QueueItem,
    body: Buffer,
    contentType: string | null,
  ): Promise<string> {
    const localPath = ensureExtension(urlToLocalPath(item.url, contentType, false), contentType)
    if (/\.js$/i.test(localPath)) this.discoverJsMedia(item, body)
    await this.writeFile(localPath, this.maybePatchJs(localPath, body))
    this.stats.assetsCrawled++
    this.cb.onStats(this.stats)
    return localPath
  }

  /**
   * Theme JS can hard-code assumptions that only hold on the origin server.
   * Uncode's init crashes on relative background URLs — see patchUncodeJs.
   */
  private maybePatchJs(localPath: string, body: Buffer): Buffer {
    if (!/\.js$/i.test(localPath)) return body
    const src = body.toString('utf-8')
    const patched = patchUncodeJs(src)
    if (patched === src) return body
    this.log('info', `Patched Uncode adaptive-image regex in ${localPath}`)
    return Buffer.from(patched, 'utf-8')
  }

  /**
   * Queue media referenced from a .js file. Relative paths in JS resolve
   * against the document, not the script, so try both bases — a miss is just a
   * 404 we skip, whereas a miss we never tried is an asset silently absent from
   * the mirror.
   */
  private discoverJsMedia(item: QueueItem, body: Buffer): void {
    if (!this.options.includeAssets) return
    const js = body.toString('utf-8')
    if (!/\.(gif|jpe?g|png|webp|svg|mp4|woff2?)['"]/i.test(js)) return

    const bases = [item.url, this.origin]
    for (const base of bases) {
      for (const u of extractJsMediaUrls(js, base)) {
        if (!isSameSite(u, this.origin)) continue
        this.enqueue({ url: canonicalizeToSite(u, this.origin), depth: item.depth, kind: 'asset' })
      }
    }
  }

  private async writeFile(relPath: string, body: Buffer): Promise<boolean> {
    const max = this.options.maxFileSizeBytes
    if (max > 0 && body.length > max) {
      this.log(
        'warn',
        `Skipping ${relPath}: ${(body.length / 1024 / 1024).toFixed(1)} MiB exceeds size limit (${(max / 1024 / 1024) | 0} MiB)`,
      )
      return false
    }
    const abs = path.join(this.options.outputDir, relPath)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, body)
    this.stats.bytesWritten += body.length
    return true
  }

  private log(level: JobLogEntry['level'], msg: string) {
    const entry: JobLogEntry = { ts: Date.now(), level, msg }
    this.cb.onLog(entry)
  }
}
