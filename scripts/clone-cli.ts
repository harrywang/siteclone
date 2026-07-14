/**
 * Headless clone runner — drives CloneEngine directly, no server needed.
 *
 * Usage:
 *   npx tsx scripts/clone-cli.ts <url> <outputDir> [--depth N] [--mode static|dynamic]
 *     [--concurrency N] [--max-file-size MB] [--path-prefix /2007/]
 */
import path from 'node:path'
import { CloneEngine } from '../lib/cloner/engine'
import { DEFAULT_MAX_FILE_SIZE_BYTES, type CloneOptions } from '../lib/cloner/types'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const [url, outputDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!url || !outputDir) {
  console.error('Usage: tsx scripts/clone-cli.ts <url> <outputDir> [--depth N] [--mode static|dynamic] [--concurrency N] [--max-file-size MB]')
  process.exit(1)
}

const options: CloneOptions = {
  url,
  outputDir: path.resolve(outputDir),
  depth: parseInt(arg('--depth', '8')!, 10),
  concurrency: parseInt(arg('--concurrency', '6')!, 10),
  mode: (arg('--mode', 'static') as CloneOptions['mode']) ?? 'static',
  includeAssets: true,
  rewriteRoot: true,
  maxFileSizeBytes: arg('--max-file-size')
    ? parseInt(arg('--max-file-size')!, 10) * 1024 * 1024
    : DEFAULT_MAX_FILE_SIZE_BYTES,
}

const engine = new CloneEngine(options, {
  onLog: (e) => {
    const tag = e.level === 'info' ? ' ' : e.level === 'warn' ? '!' : 'X'
    console.log(`[${tag}] ${e.msg}`)
  },
  onStats: () => {},
  onStatus: (s) => console.log(`== status: ${s}`),
  isCancelled: () => false,
})

engine.run().then(
  () => {
    const s = engine.getStats()
    console.log(JSON.stringify({ ...s, failedUrls: s.failedUrls.slice(0, 50) }, null, 2))
    process.exit(s.errors > 0 ? 2 : 0)
  },
  (err) => {
    console.error('FATAL:', err)
    process.exit(1)
  },
)
