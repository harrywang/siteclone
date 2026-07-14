/**
 * Rewrite absolute references to a site's *own* origin into local relative
 * paths, so the mirror is genuinely self-contained.
 *
 * Two things go wrong when these survive:
 *   1. The archive isn't portable — every image still round-trips to the live
 *      domain, so it only renders while that domain exists.
 *   2. `http://` asset refs on an `https://` page are blocked as mixed content,
 *      so the image silently never appears.
 *
 * Only asset-loading references are touched (src=, stylesheet href=, CSS
 * url()); <a> page links are left alone. A ref is rewritten only when the file
 * exists in the mirror, so nothing working can be turned into a broken link.
 *
 * Usage: npx tsx scripts/fix-selforigin-assets.ts <dir> [<dir> ...]
 *   (directory name must be the site's host, e.g. 2016.cswimworkshop.org)
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const TEXT_EXT = /\.(html?|css|js)$/i

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
  console.error('Usage: tsx scripts/fix-selforigin-assets.ts <dir> [<dir> ...]')
  process.exit(1)
}

for (const dir of dirs) {
  const root = path.resolve(dir)
  const host = path.basename(root)
  // src="…", srcset entries, <link href="…"> and CSS url(…) — asset loads only.
  const ASSET = new RegExp(
    String.raw`(src\s*=\s*["']|url\(\s*["']?|<link[^>]*href\s*=\s*["'])(https?://(?:www\.)?${host.replace(/\./g, '\\.')}/[^"')\s>]+)`,
    'gi',
  )

  const files = (await walk(root)).filter((f) => TEXT_EXT.test(f))
  let changedFiles = 0
  let rewritten = 0
  let missing = 0

  for (const file of files) {
    const src = await readFile(file, 'utf-8')
    let n = 0

    const out = src.replace(ASSET, (whole, lead: string, url: string) => {
      let rel: string
      try {
        rel = new URL(url).pathname.replace(/^\/+/, '')
      } catch {
        return whole
      }
      if (!rel) return whole

      const target = path.join(root, decodeURIComponent(rel))
      if (!existsSync(target)) {
        missing++
        return whole // leave anything we can't satisfy locally
      }

      let link = path.posix.relative(
        path.dirname(file).split(path.sep).join('/'),
        target.split(path.sep).join('/'),
      )
      if (!link) link = path.posix.basename(target)
      if (!link.startsWith('.')) link = `./${link}`

      n++
      return lead + link
    })

    if (n === 0) continue
    await writeFile(file, out, 'utf-8')
    changedFiles++
    rewritten += n
  }

  console.log(
    `${host}: localized ${rewritten} asset ref(s) in ${changedFiles} file(s)` +
      (missing ? `, ${missing} not present locally (left as-is)` : ''),
  )
}
