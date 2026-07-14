/**
 * Completion pass for wget-mirrored static sites whose navigation is built
 * with document.write() in JS include files — wget can't see those links.
 *
 * Scans every .js/.htm/.html/.css file in the folder for relative-path-looking
 * refs (foo.htm, images/x.gif …), downloads any that are missing from the
 * matching path under the base URL, and repeats until no new files appear.
 *
 * Usage: npx tsx scripts/s3-complete.ts <dir> <baseUrl>
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fetchUrl } from '../lib/cloner/fetcher'

const [dirArg, baseArg] = process.argv.slice(2)
if (!dirArg || !baseArg) {
  console.error('Usage: tsx scripts/s3-complete.ts <dir> <baseUrl>')
  process.exit(1)
}
const root = path.resolve(dirArg)
const base = baseArg.endsWith('/') ? baseArg : baseArg + '/'

const REF_RE =
  /(?:href|src)\s*=\s*\\?["']?([a-zA-Z0-9_][a-zA-Z0-9_\-./%]*\.(?:htm|html|css|js|gif|jpg|jpeg|png|webp|ico|pdf|doc|docx|ppt|pptx|xls|xlsx|zip|mp4|mp3|swf))\\?["']?/gi
const CSS_URL_RE = /url\(\s*['"]?([a-zA-Z0-9_][a-zA-Z0-9_\-./%]*)['"]?\s*\)/gi

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

let downloaded = 0
let failed = 0
const attempted = new Set<string>()

for (let round = 0; round < 10; round++) {
  const scannable = (await walk(root)).filter((f) => /\.(js|html?|css)$/i.test(f))
  const wanted = new Set<string>()

  for (const file of scannable) {
    const text = await readFile(file, 'utf-8')
    const fileDir = path.dirname(file)
    const addCandidate = (raw: string) => {
      const rel = decodeURIComponent(raw).replace(/^\.\//, '')
      if (rel.includes('..')) return
      // JS includes are written into pages that live at the site root, so
      // root-relative is the primary resolution; also try file-relative.
      for (const cand of [path.join(root, rel), path.resolve(fileDir, rel)]) {
        if (cand.startsWith(root) && !existsSync(cand)) {
          wanted.add(path.relative(root, cand))
          return
        }
      }
    }
    for (const m of text.matchAll(REF_RE)) addCandidate(m[1])
    if (/\.css$/i.test(file)) for (const m of text.matchAll(CSS_URL_RE)) addCandidate(m[1])
  }

  const fresh = [...wanted].filter((r) => !attempted.has(r))
  if (fresh.length === 0) break
  console.log(`round ${round + 1}: fetching ${fresh.length} missing file(s)`)

  for (const rel of fresh) {
    attempted.add(rel)
    const url = base + rel.split(path.sep).join('/')
    try {
      const res = await fetchUrl(url, { timeoutMs: 30000 })
      if (res.status >= 400) {
        failed++
        console.log(`  ${res.status} ${url}`)
        continue
      }
      const abs = path.join(root, rel)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, res.body)
      downloaded++
      console.log(`  + ${rel} (${res.body.length} bytes)`)
    } catch (err) {
      failed++
      console.log(`  ERR ${url}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

console.log(JSON.stringify({ downloaded, failed }))
