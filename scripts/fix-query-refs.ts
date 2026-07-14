/**
 * Companion to fix-query-filenames.ts.
 *
 * wget writes references to query-suffixed assets in two forms: literally
 * (`style.css?ver=1.css`) and percent-encoded (`index.html%3Fp=116.html`).
 * Once those files are renamed to use `__`, every reference has to follow —
 * including the encoded ones.
 *
 * Rewrites a local href/src only when the rewritten target actually exists on
 * disk, so a bad guess can never turn a working link into a broken one.
 *
 * Usage: npx tsx scripts/fix-query-refs.ts <dir> [<dir> ...]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const TEXT_EXT = /\.(html?|css|js)$/i
const REF = /((?:href|src)\s*=\s*)(["'])([^"']+)\2/gi

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === '.git') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('Usage: tsx scripts/fix-query-refs.ts <dir> [<dir> ...]')
  process.exit(1)
}

for (const dir of dirs) {
  const root = path.resolve(dir)
  const files = (await walk(root)).filter((f) => TEXT_EXT.test(f))
  let changedFiles = 0
  let changedRefs = 0

  for (const file of files) {
    const src = await readFile(file, 'utf-8')
    let n = 0

    const out = src.replace(REF, (whole, lead: string, q: string, url: string) => {
      // Only local refs; leave absolute URLs, data:, mailto:, anchors alone.
      if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return whole
      if (!/%3F|\?/i.test(url)) return whole

      const [rawPath, ...hashParts] = url.split('#')
      const candidate = rawPath.replace(/%3F/gi, '__').replace(/\?/g, '__')
      if (candidate === rawPath) return whole

      const target = path.resolve(path.dirname(file), decodeURIComponent(candidate))
      if (!existsSync(target)) return whole // don't touch what we can't confirm

      n++
      const rebuilt = hashParts.length ? `${candidate}#${hashParts.join('#')}` : candidate
      return `${lead}${q}${rebuilt}${q}`
    })

    if (n === 0) continue
    await writeFile(file, out, 'utf-8')
    changedFiles++
    changedRefs += n
  }

  console.log(`${path.basename(root)}: rewrote ${changedRefs} ref(s) in ${changedFiles} file(s)`)
}
