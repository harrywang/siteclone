/**
 * Retro-fix already-cloned Uncode sites: widen the theme's `uri_pattern` regex
 * so it also matches the relative background URLs a static mirror uses.
 *
 * See patchUncodeJs in lib/cloner/html-rewrite.ts for the full explanation —
 * in short, the un-widened regex returns null on `url(./wp-content/…)`, the
 * theme does `url[0]`, and the resulting TypeError kills its entire init,
 * leaving hero backgrounds black and scroll animations dead.
 *
 * Usage: npx tsx scripts/fix-uncode-uripattern.ts <dir> [<dir> ...]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { patchUncodeJs } from '../lib/cloner/html-rewrite'

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
  console.error('Usage: tsx scripts/fix-uncode-uripattern.ts <dir> [<dir> ...]')
  process.exit(1)
}

for (const dir of dirs) {
  const root = path.resolve(dir)
  const files = (await walk(root)).filter((f) => f.endsWith('.js'))
  let patched = 0

  for (const file of files) {
    const src = await readFile(file, 'utf-8')
    const out = patchUncodeJs(src)
    if (out === src) continue
    await writeFile(file, out, 'utf-8')
    patched++
  }

  console.log(`${path.basename(root)}: patched ${patched} js file(s)`)
}
