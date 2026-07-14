/**
 * Byte-level verification for a wget-mirrored static site: every local file
 * must be byte-identical to the object served at <base>/<relative path>.
 *
 * Old static WP exports have literal '?' in object keys (index.html?p=116.html)
 * — those must be percent-encoded when re-fetching or the server treats them
 * as a query string.
 *
 * Usage: npx tsx scripts/s3-byteverify.ts <dir> <baseUrl>
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchUrl } from '../lib/cloner/fetcher'

const [dirArg, baseArg] = process.argv.slice(2)
if (!dirArg || !baseArg) {
  console.error('Usage: tsx scripts/s3-byteverify.ts <dir> <baseUrl>')
  process.exit(1)
}
const root = path.resolve(dirArg)
const base = baseArg.endsWith('/') ? baseArg : baseArg + '/'

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

// Minimal escaping: keep existing %XX sequences (they're part of the key),
// escape only characters that change URL semantics.
function escapeSegment(seg: string): string {
  return seg
    .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
    .replace(/\?/g, '%3F')
    .replace(/#/g, '%23')
    .replace(/ /g, '%20')
}

let identical = 0
const different: string[] = []
const fetchFailed: string[] = []

const files = await walk(root)
for (const file of files) {
  const rel = path.relative(root, file)
  const urlPath = rel.split(path.sep).map(escapeSegment).join('/')
  const url = base + urlPath
  try {
    const res = await fetchUrl(url, { timeoutMs: 30000 })
    if (res.status >= 400) {
      fetchFailed.push(`${res.status} ${rel}`)
      continue
    }
    const local = await readFile(file)
    if (local.equals(res.body)) identical++
    else different.push(rel)
  } catch (err) {
    fetchFailed.push(`ERR ${rel}: ${err instanceof Error ? err.message : err}`)
  }
}

console.log(
  JSON.stringify(
    {
      files: files.length,
      identical,
      different: different.slice(0, 300),
      differentCount: different.length,
      fetchFailed: fetchFailed.slice(0, 20),
      fetchFailedCount: fetchFailed.length,
    },
    null,
    1,
  ),
)
process.exit(different.length > 0 ? 2 : 0)
