/**
 * Dynamic-mode page renderer.
 *
 * Loads playwright-core lazily (so the static path doesn't pay for it).
 * Detects a usable Chromium in this order:
 *   1. PLAYWRIGHT_CHROMIUM_PATH env var
 *   2. Standard Playwright cache (~/Library/Caches/ms-playwright on mac,
 *      %USERPROFILE%/AppData/Local/ms-playwright on win)
 *   3. System Chrome / Edge (auto-discovered by playwright-core)
 *
 * The renderer captures BOTH the post-JS DOM AND the bodies of every same-origin
 * sub-resource Chromium fetched while loading the page. We surface both back to
 * the engine so it can save assets without re-fetching them through Node — vital
 * for sites whose CDN blocks Node's TLS fingerprint while letting Chromium through.
 */

export interface CapturedAsset {
  url: string
  body: Buffer
  contentType: string | null
  status: number
}

export interface PageCapture {
  html: string
  finalUrl: string
  assets: CapturedAsset[]
}

let _browser: import('playwright-core').Browser | null = null
let _initPromise: Promise<import('playwright-core').Browser> | null = null

async function getBrowser(): Promise<import('playwright-core').Browser> {
  // If we have a cached browser but it got disconnected (e.g. a previous
  // shutdownRenderer call killed it, or Chromium crashed), discard and relaunch.
  if (_browser && !_browser.isConnected()) {
    _browser = null
    _initPromise = null
  }
  if (_browser) return _browser
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    const { chromium } = await import('playwright-core')
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_PATH ||
      process.env.SITECLONE_CHROMIUM_PATH ||
      undefined

    const launchOpts: Parameters<typeof chromium.launch>[0] = { headless: true }
    if (executablePath) launchOpts.executablePath = executablePath

    try {
      _browser = await chromium.launch(launchOpts)
    } catch (err: unknown) {
      _initPromise = null
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to launch Chromium for dynamic mode: ${msg}\n` +
          `Try one of:\n` +
          `  • Run "npx playwright install chromium" once.\n` +
          `  • Set PLAYWRIGHT_CHROMIUM_PATH to a Chrome/Chromium binary.\n`,
      )
    }
    return _browser
  })()
  return _initPromise
}

export async function renderPage(
  url: string,
  opts: {
    userAgent?: string
    timeoutMs?: number
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
    /** Skip individual response bodies larger than this many bytes. */
    maxFileSizeBytes?: number
  } = {},
): Promise<PageCapture> {
  const browser = await getBrowser()
  const ctx = await browser.newContext({ userAgent: opts.userAgent })
  const page = await ctx.newPage()
  const assets: CapturedAsset[] = []
  // URLs we've already seen a response event for — used solely to dedupe
  // event firings, NOT to gate the prefetch loop below (which needs to be
  // able to refetch URLs the page started but didn't fully capture, e.g.
  // 206 partial responses for media).
  const seenResponses = new Set<string>()
  // URLs whose full body landed in `assets` successfully. The prefetch loop
  // skips these.
  const capturedUrls = new Set<string>()
  const pendingBodies: Promise<void>[] = []

  const maxBytes = opts.maxFileSizeBytes ?? 0
  page.on('response', (res) => {
    const u = res.url()
    if (!u.startsWith('http') || seenResponses.has(u)) return
    seenResponses.add(u)
    const status = res.status()
    // Only trust full 200s. 206 = partial content (e.g. video preload
    // metadata), which would give us a truncated file. 3xx = redirect,
    // 4xx/5xx = error. The prefetch loop will refetch any of these.
    if (status !== 200) return
    const cl = parseInt(res.headers()['content-length'] || '', 10)
    if (maxBytes > 0 && Number.isFinite(cl) && cl > maxBytes) return
    pendingBodies.push(
      (async () => {
        try {
          const body = await res.body()
          if (maxBytes > 0 && body.length > maxBytes) return
          const ct = res.headers()['content-type'] || null
          assets.push({ url: u, body, contentType: ct, status })
          capturedUrls.add(u)
        } catch {
          // body() can fail for preflights, no-content responses, or if the
          // page closes mid-flight — best-effort capture.
        }
      })(),
    )
  })

  // Use 'load' by default (more reliable than networkidle for sites that
  // long-poll or send WP heartbeats), then add a short settle delay so
  // late-loading widgets have a chance to fire requests we still want to
  // capture. networkidle is opt-in for SPAs that need it.
  const waitUntil = opts.waitUntil ?? 'load'
  const timeoutMs = opts.timeoutMs ?? 45_000

  try {
    let response
    try {
      response = await page.goto(url, { waitUntil, timeout: timeoutMs })
    } catch (err: unknown) {
      // goto can throw on slow heavy pages even when the DOM is usable.
      // Log and try to extract whatever's there before giving up.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/closed|cancel/i.test(msg)) {
        console.warn(`[renderer] goto warning for ${url}: ${msg}`)
      }
    }

    // Give post-load JS an unconditional head start. Many themes (e.g. Uncode's
    // adaptive-images) inject high-res image siblings or upgrade placeholder
    // <img src> tags only after `load` fires. Without this pause we'd capture
    // the page mid-swap and lose the high-res references.
    await page.waitForTimeout(1500)

    // Scroll through the page to wake IntersectionObserver-based lazy loaders.
    try {
      await page.evaluate(async () => {
        const totalHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
        )
        const step = Math.max(window.innerHeight, 600)
        for (let y = 0; y < totalHeight; y += step) {
          window.scrollTo(0, y)
          await new Promise((r) => setTimeout(r, 200))
        }
        window.scrollTo(0, 0)
        await new Promise((r) => setTimeout(r, 200))
      })
    } catch {
      // page may have navigated; ignore
    }

    // Wait until "lazy-load placeholders" disappear OR a hard ceiling.
    // We look for a few well-known signals:
    //   - Uncode: <img class="adaptive-fetching"> is the in-flight state
    //   - Generic: <img loading="lazy"> with no naturalWidth yet
    // When the count of these reaches zero, lazy loaders are done.
    try {
      await page.waitForFunction(
        () => {
          const fetching = document.querySelectorAll('img.adaptive-fetching').length
          const lazyPending = Array.from(
            document.querySelectorAll('img[loading="lazy"]'),
          ).filter((i) => !(i as HTMLImageElement).complete).length
          return fetching === 0 && lazyPending === 0
        },
        { timeout: 6000, polling: 400 },
      )
    } catch {
      // Some lazy items may never resolve (e.g. below-fold offscreen).
      // Don't block — proceed and accept partial.
    }

    // Wait for the DOM to look stable: same image count + same src for ~1.2s.
    // This catches systems that inject sibling <img> elements (Uncode's
    // "placeH" pattern) after the placeholders settle.
    try {
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __scStable?: number; __scKey?: string }
          const imgs = document.querySelectorAll('img')
          let key = String(imgs.length)
          for (let i = 0; i < imgs.length; i++) {
            key +=
              '|' +
              (imgs[i].currentSrc || imgs[i].src || '').slice(-40) +
              '|' +
              (imgs[i] as HTMLImageElement).className.slice(-30)
          }
          if (w.__scKey === key) {
            w.__scStable = (w.__scStable ?? 0) + 1
            // require 4 stable polls (≈1.6s) before we trust it
            return w.__scStable >= 4
          }
          w.__scKey = key
          w.__scStable = 0
          return false
        },
        { timeout: 8000, polling: 400 },
      )
    } catch {
      // Stability never reached — proceed with what we have.
    }

    // Wait for any visible images to actually finish decoding.
    try {
      await page.evaluate(async () => {
        const imgs = Array.from(document.querySelectorAll('img'))
        await Promise.all(
          imgs.map((img) => {
            if (img.complete) return Promise.resolve()
            return new Promise<void>((resolve) => {
              const done = () => resolve()
              img.addEventListener('load', done, { once: true })
              img.addEventListener('error', done, { once: true })
              setTimeout(done, 3000)
            })
          }),
        )
      })
    } catch {
      // ignore
    }

    // Final settle pause for any tail requests.
    await page.waitForTimeout(500)
    // Drain in-flight body() reads so we don't lose them when the context closes.
    await Promise.allSettled(pendingBodies.splice(0))

    // Pre-fetch any lazy-load URLs that weren't loaded by the live page —
    // these are the high-res originals we'll point HTML at after upgrading
    // placeholder src. Use the browser context's request API so we share
    // Chromium's TLS fingerprint (Node fetch would 403 on TLS-protected CDNs).
    try {
      const lazyTargets = await page.evaluate(() => {
        const out: string[] = []
        const seen = new Set<string>()
        const attrs = [
          'data-guid',
          'data-src',
          'data-lazy-src',
          'data-original',
          'data-img-url',
          'data-bg-image',
        ]
        // Lazy data-* attrs on <img> and on bg-image divs (Uncode hero).
        document
          .querySelectorAll(
            'img, [data-guid], [data-bg-image], [data-lazy-src], [data-src][style*="background"]',
          )
          .forEach((el) => {
            for (const a of attrs) {
              const v = el.getAttribute(a)
              if (v && v.startsWith('http') && !seen.has(v)) {
                seen.add(v)
                out.push(v)
              }
            }
          })
        // Media elements: <video>, <audio>, <source> srcs that the live page
        // may not have downloaded (autoplay-blocked in headless, or user-triggered).
        document
          .querySelectorAll('video[src], audio[src], video source[src], audio source[src]')
          .forEach((el) => {
            const src = (el as HTMLMediaElement | HTMLSourceElement).src
            if (src && src.startsWith('http') && !seen.has(src)) {
              seen.add(src)
              out.push(src)
            }
          })
        return out
      })
      for (const lazyUrl of lazyTargets) {
        if (capturedUrls.has(lazyUrl)) continue
        try {
          const res = await ctx.request.get(lazyUrl)
          if (res.ok()) {
            const cl = parseInt(res.headers()['content-length'] || '', 10)
            if (maxBytes > 0 && Number.isFinite(cl) && cl > maxBytes) {
              continue
            }
            const body = Buffer.from(await res.body())
            if (maxBytes > 0 && body.length > maxBytes) continue
            const ct = res.headers()['content-type'] || null
            assets.push({ url: lazyUrl, body, contentType: ct, status: res.status() })
            capturedUrls.add(lazyUrl)
          }
        } catch {
          // best-effort — skip on failure
        }
      }
    } catch {
      // page may have closed early; skip
    }

    let html = ''
    try {
      html = await page.content()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to read page content: ${msg}`)
    }
    const finalUrl = response?.url() || page.url() || url
    return { html, finalUrl, assets }
  } finally {
    // Best-effort context close — never let close errors mask the rendered output.
    try {
      await ctx.close()
    } catch {
      // ignore — browser may have crashed; the page data we have is still valid.
    }
  }
}

export async function shutdownRenderer(): Promise<void> {
  const b = _browser
  _browser = null
  _initPromise = null
  if (b) {
    try {
      await b.close()
    } catch {
      // best-effort
    }
  }
}
