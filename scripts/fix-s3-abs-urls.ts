/**
 * wget's --convert-links leaves some references pointing at the origin it
 * mirrored from — here, the S3 website endpoint:
 *
 *   <img src="http://cswim.s3-website-ap-northeast-1.amazonaws.com/2012/images/Banner.jpg">
 *
 * Two problems on a real host: the archive isn't self-contained (it depends on
 * a bucket we're about to delete), and the `http://` reference on an `https://`
 * page is blocked as mixed content — so the image silently never renders.
 *
 * Rewrite those to relative paths, but only when the file actually exists in
 * the mirror, so a reference we can't satisfy is left visibly intact rather
 * than turned into a broken relative link.
 *
 * Usage: npx tsx scripts/fix-s3-abs-urls.ts <dir> [<dir> ...]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const TEXT_EXT = /\.(html?|css|js|xml)$/i
const S3_URL = /https?:\/\/cswim\.s3-website-ap-northeast-1\.amazonaws\.com\/([^\s"'()<>]*)/gi

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
  console.error('Usage: tsx scripts/fix-s3-abs-urls.ts <dir> [<dir> ...]')
  process.exit(1)
}

for (const dir of dirs) {
  const root = path.resolve(dir)
  // The mirror's root corresponds to the bucket's <year>/ prefix.
  const year = path.basename(root).split('.')[0]
  const files = (await walk(root)).filter((f) => TEXT_EXT.test(f))

  let changedFiles = 0
  let rewritten = 0
  const unresolved = new Set<string>()

  for (const file of files) {
    const src = await readFile(file, 'utf-8')
    let n = 0

    const out = src.replace(S3_URL, (whole, rest: string) => {
      // rest looks like "2012/images/Banner.jpg" (or occasionally without the year)
      let rel = rest
      if (rel.startsWith(`${year}/`)) rel = rel.slice(year.length + 1)
      rel = rel.replace(/^\/+/, '')
      if (!rel) rel = 'index.html'

      const [pathPart, ...hashParts] = rel.split('#')
      const target = path.join(root, decodeURIComponent(pathPart))
      if (!existsSync(target)) {
        unresolved.add(whole.slice(0, 90))
        return whole
      }

      let link = path.posix.relative(
        path.dirname(file).split(path.sep).join('/'),
        target.split(path.sep).join('/'),
      )
      if (!link) link = path.posix.basename(target)
      if (!link.startsWith('.')) link = `./${link}`

      n++
      return hashParts.length ? `${link}#${hashParts.join('#')}` : link
    })

    if (n === 0) continue
    await writeFile(file, out, 'utf-8')
    changedFiles++
    rewritten += n
  }

  console.log(
    `${path.basename(root)}: rewrote ${rewritten} url(s) in ${changedFiles} file(s)` +
      (unresolved.size ? `, ${unresolved.size} unresolved (left as-is)` : ''),
  )
  for (const u of [...unresolved].slice(0, 3)) console.log(`    unresolved: ${u}`)
}
