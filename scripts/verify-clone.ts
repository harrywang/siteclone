/**
 * Verify a cloned folder against the live original.
 *
 * Checks, per cloned HTML page:
 *   1. The live page still returns 200 and its visible text matches the clone's
 *      (whitespace-normalized) — proves content parity.
 *   2. Every local href/src/srcset/url() reference in the clone resolves to a
 *      file on disk — proves the snapshot is self-contained.
 *
 * Usage: npx tsx scripts/verify-clone.ts <outputDir> <originalBaseUrl> [--max-pages N]
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as cheerio from 'cheerio'
import { fetchUrl } from '../lib/cloner/fetcher'

const [outDirArg, baseUrlArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!outDirArg || !baseUrlArg) {
  console.error('Usage: tsx scripts/verify-clone.ts <outputDir> <originalBaseUrl>')
  process.exit(1)
}
const outDir = path.resolve(outDirArg)
const baseUrl = new URL(baseUrlArg)

function argNum(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : fallback
}
const maxPages = argNum('--max-pages', 200)

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

/** Map a cloned local file path back to the original URL it was saved from. */
function localPathToUrl(relPath: string): string {
  const posix = relPath.split(path.sep).join('/')
  let urlPath: string
  if (posix === 'index.html') urlPath = ''
  else if (posix.endsWith('/index.html')) urlPath = posix.slice(0, -'index.html'.length)
  else urlPath = posix
  // query-folded filenames (index__q=1.html) can't be reversed reliably — skip
  if (/__/.test(urlPath)) return ''
  // resolve relative to the base so a base with a path prefix (S3 site under
  // /2007/) maps clone-root-relative files under that prefix
  const base = baseUrl.toString().endsWith('/') ? baseUrl.toString() : baseUrl.toString() + '/'
  return new URL(urlPath, base).toString()
}

function visibleText($: cheerio.CheerioAPI): string {
  $('script, style, noscript').remove()
  return $('body').text().replace(/\s+/g, ' ').trim()
}

/** Collect every local (relative) reference from a cloned HTML file. */
function localRefs(html: string): string[] {
  const $ = cheerio.load(html)
  const refs: string[] = []
  const push = (v?: string) => {
    if (!v) return
    const raw = v.trim()
    // Skip anything with a scheme (http, https, data, mailto, webcal, …),
    // protocol-relative URLs, and fragments — only local file refs matter.
    if (!raw || raw.startsWith('//') || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw))
      return
    refs.push(raw.split('#')[0].split('?')[0])
  }
  $('a[href], link[href]').each((_, el) => push($(el).attr('href')))
  $('script[src], img[src], source[src], iframe[src], video[src], audio[src], embed[src]').each(
    (_, el) => push($(el).attr('src')),
  )
  $('img[srcset], source[srcset]').each((_, el) => {
    for (const part of ($(el).attr('srcset') || '').split(',')) {
      push(part.trim().split(/\s+/)[0])
    }
  })
  // url() refs — only inside CSS contexts (<style> blocks + style attributes),
  // scanning the raw HTML would false-positive on url(...) in inline JS.
  const cssChunks: string[] = []
  $('style').each((_, el) => {
    cssChunks.push($(el).html() ?? '')
  })
  $('[style]').each((_, el) => {
    cssChunks.push($(el).attr('style') ?? '')
  })
  for (const css of cssChunks) {
    for (const m of css.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi)) push(m[2])
  }
  return refs.filter(Boolean)
}

const report = {
  pagesChecked: 0,
  pagesTextMatch: 0,
  pagesTextMismatch: [] as { file: string; url: string; similarity: number }[],
  pagesFetchFailed: [] as { file: string; url: string; status: number }[],
  brokenRefs: [] as { file: string; ref: string }[],
  brokenUpstream: [] as { file: string; ref: string }[], // ref is broken on the live site too — clone is faithful
  totalRefs: 0,
}

/**
 * A ref that doesn't resolve locally may be broken on the original site too
 * (WP themes ship 404 asset refs surprisingly often). Reconstruct candidate
 * original URLs from the rewritten local ref and probe them: if none returns
 * <400, the breakage is upstream, not a cloning defect.
 */
const upstreamCache = new Map<string, boolean>()
async function isBrokenUpstream(pageRel: string, ref: string): Promise<boolean> {
  const pageUrl = localPathToUrl(pageRel) || new URL('/', baseUrl).toString()
  const resolved = new URL(ref, pageUrl)
  const p = resolved.pathname
  const candidates = new Set([
    p,
    p.replace(/\/index\.html$/, ''),
    p.replace(/\/index\.html$/, '/'),
    p.replace(/\.html$/, ''),
  ])
  for (const cand of candidates) {
    const u = new URL(cand, baseUrl).toString()
    if (upstreamCache.has(u)) {
      if (!upstreamCache.get(u)) return false
      continue
    }
    try {
      const res = await fetchUrl(u, { timeoutMs: 20000, maxBytes: 1 })
      const ok = res.status < 400
      upstreamCache.set(u, !ok)
      if (ok) return false
    } catch {
      upstreamCache.set(u, true)
    }
  }
  return true
}

function similarity(a: string, b: string): number {
  if (a === b) return 1
  // token-level Jaccard — robust to nonce/timestamp churn
  const ta = new Set(a.split(' '))
  const tb = new Set(b.split(' '))
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.max(ta.size, tb.size, 1)
}

const files = (await walk(outDir)).filter((f) => /\.html?$/i.test(f))
const htmlFiles = files.slice(0, maxPages)

for (const file of htmlFiles) {
  const rel = path.relative(outDir, file)
  const html = await readFile(file, 'utf-8')

  // 1. broken local refs
  const dir = path.dirname(file)
  for (const ref of localRefs(html)) {
    report.totalRefs++
    const target = path.resolve(dir, decodeURIComponent(ref))
    if (!existsSync(target)) {
      if (await isBrokenUpstream(rel, ref)) report.brokenUpstream.push({ file: rel, ref })
      else report.brokenRefs.push({ file: rel, ref })
    }
  }

  // 2. text parity with live original
  const url = localPathToUrl(rel)
  if (!url) continue
  report.pagesChecked++
  try {
    const res = await fetchUrl(url, { timeoutMs: 30000 })
    if (res.status >= 400) {
      report.pagesFetchFailed.push({ file: rel, url, status: res.status })
      continue
    }
    const liveText = visibleText(cheerio.load(res.body.toString('utf-8')))
    const cloneText = visibleText(cheerio.load(html))
    const sim = similarity(liveText, cloneText)
    if (sim >= 0.98) report.pagesTextMatch++
    else report.pagesTextMismatch.push({ file: rel, url, similarity: +sim.toFixed(3) })
  } catch (err) {
    report.pagesFetchFailed.push({ file: rel, url, status: -1 })
  }
}

console.log(
  JSON.stringify(
    {
      outDir,
      htmlFiles: files.length,
      ...report,
      brokenRefs: report.brokenRefs.slice(0, 40),
      brokenRefCount: report.brokenRefs.length,
      brokenUpstream: report.brokenUpstream.slice(0, 15),
      brokenUpstreamCount: report.brokenUpstream.length,
    },
    null,
    2,
  ),
)
process.exit(report.brokenRefs.length > 0 || report.pagesTextMismatch.length > 0 ? 2 : 0)
