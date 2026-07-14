/**
 * Retro-fix already-cloned Uncode (WordPress) sites whose hero/background
 * images never appear.
 *
 * Uncode gates every background behind `opacity: 0` until its adaptive-images
 * JS loads a server-generated `-uai-<w>x<h>` variant and sets
 * `data-imgready="true"`. Those variants are produced on demand by WordPress,
 * so on a static mirror they 404 and the background stays invisible.
 *
 * Applies the same transformation the cloner now does at rewrite time, so
 * existing clones don't need re-downloading.
 *
 * Usage: npx tsx scripts/fix-uncode-heroes.ts <dir> [<dir> ...]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as cheerio from 'cheerio'

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
  console.error('Usage: tsx scripts/fix-uncode-heroes.ts <dir> [<dir> ...]')
  process.exit(1)
}

for (const dir of dirs) {
  const root = path.resolve(dir)
  const files = (await walk(root)).filter((f) => /\.html?$/i.test(f))
  let changedFiles = 0
  let touchedEls = 0

  for (const file of files) {
    const html = await readFile(file, 'utf-8')
    if (!/adaptive-async|adaptive-fetching|background-inner|page-header/.test(html)) continue

    const $ = cheerio.load(html)
    let n = 0

    $('.adaptive-async, .adaptive-fetching').each((_, el) => {
      const $el = $(el)
      const kept = ($el.attr('class') || '')
        .split(/\s+/)
        .filter((c) => c && c !== 'adaptive-async' && c !== 'adaptive-fetching')
      if (!kept.includes('async-done')) kept.push('async-done')
      $el.attr('class', kept.join(' '))
      $el.attr('data-imgready', 'true')
      $el.removeAttr('data-guid')
      $el.removeAttr('data-uniqueid')
      n++
    })

    $('#page-header').each((_, el) => {
      if ($(el).attr('data-imgready') !== 'true') n++
      $(el).attr('data-imgready', 'true')
    })
    $('.background-inner').each((_, el) => {
      if ($(el).attr('data-imgready') !== 'true') n++
      $(el).attr('data-imgready', 'true')
    })

    // Scroll-reveal gating keeps headings at opacity 0 until the theme's
    // Waypoints runner fires, which is unreliable in an archived snapshot.
    // Text that never fades in is text that is simply missing — drop the gate.
    $('.animate_when_almost_visible').each((_, el) => {
      const $el = $(el)
      const kept = ($el.attr('class') || '')
        .split(/\s+/)
        .filter((c) => c && c !== 'animate_when_almost_visible')
      $el.attr('class', kept.join(' '))
      n++
    })

    if (n === 0) continue
    await writeFile(file, $.html(), 'utf-8')
    changedFiles++
    touchedEls += n
  }

  console.log(
    `${path.basename(root)}: patched ${changedFiles}/${files.length} html files, ${touchedEls} elements`,
  )
}
