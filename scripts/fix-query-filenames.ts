/**
 * wget mirrors of WordPress sites save versioned assets under their literal
 * query string — e.g. `style.css?ver=2013-07-18.css`. That works on a plain
 * filesystem (and on S3, where `?` is just another character in the key), but
 * over HTTP `?` starts the query string: the browser asks for `style.css`,
 * which doesn't exist, so every stylesheet 404s and the page renders unstyled.
 *
 * Rename those files so the `?` becomes `__` and rewrite every reference to
 * match, using the same query-folding convention the cloner already uses.
 *
 * Usage: npx tsx scripts/fix-query-filenames.ts <dir> [<dir> ...]
 */
import { readdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const TEXT_EXT = /\.(html?|css|js|xml|txt|json)$/i

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
  console.error('Usage: tsx scripts/fix-query-filenames.ts <dir> [<dir> ...]')
  process.exit(1)
}

for (const dir of dirs) {
  const root = path.resolve(dir)
  const files = await walk(root)

  // basename (with '?') -> basename (with '__'). Longest first so that a short
  // name can't clobber part of a longer one during textual replacement.
  const renames = files
    .map((f) => path.basename(f))
    .filter((b) => b.includes('?'))
    .sort((a, b) => b.length - a.length)
  const unique = [...new Set(renames)]

  if (unique.length === 0) {
    console.log(`${path.basename(root)}: nothing to do`)
    continue
  }

  // 1. rewrite references in every text file
  let rewritten = 0
  for (const file of files) {
    if (!TEXT_EXT.test(path.basename(file).replace(/\?.*$/, ''))) continue
    const src = await readFile(file, 'utf-8')
    let out = src
    for (const oldName of unique) {
      if (!out.includes(oldName)) continue
      out = out.split(oldName).join(oldName.replace(/\?/g, '__'))
    }
    if (out === src) continue
    await writeFile(file, out, 'utf-8')
    rewritten++
  }

  // 2. rename the files themselves (deepest first is irrelevant — only basenames change)
  let renamed = 0
  for (const file of files) {
    const base = path.basename(file)
    if (!base.includes('?')) continue
    const target = path.join(path.dirname(file), base.replace(/\?/g, '__'))
    await rename(file, target)
    renamed++
  }

  console.log(
    `${path.basename(root)}: renamed ${renamed} file(s), rewrote refs in ${rewritten} file(s)`,
  )
}
