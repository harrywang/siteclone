/**
 * Headless clone runner — drives CloneEngine directly, no server needed.
 *
 * Usage:
 *   npx tsx scripts/clone-cli.ts <url> <outputDir> [--depth N] [--mode static|dynamic]
 *     [--concurrency N] [--max-file-size MB] [--path-prefix /2007/]
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { Agent, setGlobalDispatcher } from 'undici'
import { CloneEngine } from '../lib/cloner/engine'
import { DEFAULT_MAX_FILE_SIZE_BYTES, type CloneOptions } from '../lib/cloner/types'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

/**
 * `--host-ip <ip>`: resolve every hostname to this address instead of using DNS.
 *
 * Needed to archive a site whose domain has lapsed or whose DNS already points
 * elsewhere: the files are still on the origin server, which serves them by
 * Host header, but there is no longer a DNS record pointing at it. Without this
 * the content is simply unreachable — and once the host is cancelled, gone.
 *
 * TLS certificate checks are relaxed alongside it, because a server reached
 * this way will present a certificate for some other name. That is expected
 * here and safe: we are pinning the connection to an IP the operator gave us,
 * not trusting an unknown network.
 */
const hostIp = arg('--host-ip')
if (hostIp) {
  setGlobalDispatcher(
    new Agent({
      connect: {
        rejectUnauthorized: false,
        // net.connect may request *all* addresses, which flips the callback
        // shape from (address, family) to an array — handle both.
        lookup: (
          _hostname: string,
          opts: { all?: boolean },
          cb: (
            err: Error | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number,
          ) => void,
        ) =>
          opts?.all ? cb(null, [{ address: hostIp, family: 4 }]) : cb(null, hostIp, 4),
      },
    }),
  )
  console.log(`[ ] Resolving all hostnames to ${hostIp} (DNS override; TLS verification relaxed)`)
}

const [url, outputDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!url || !outputDir) {
  console.error('Usage: tsx scripts/clone-cli.ts <url> <outputDir> [--depth N] [--mode static|dynamic] [--concurrency N] [--max-file-size MB]')
  process.exit(1)
}

// `--seeds <file>`: newline-delimited extra URLs to crawl from.
const seedsFile = arg('--seeds')
const extraSeeds = seedsFile
  ? readFileSync(seedsFile, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  : undefined

const options: CloneOptions = {
  url,
  extraSeeds,
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
