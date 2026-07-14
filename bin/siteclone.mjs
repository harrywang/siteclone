#!/usr/bin/env node

/**
 * Headless CLI runner — used for "npx siteclone" or local dev without Electron.
 * Starts the Next.js production server on a free port and prints the URL.
 */

import { execSync, spawn } from 'child_process'
import { createServer } from 'net'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(startPort, () => {
      server.close(() => resolve(startPort))
    })
    server.on('error', () => resolve(findAvailablePort(startPort + 1)))
  })
}

const preferredPort = parseInt(process.env.SITECLONE_PORT || process.env.PORT || '3000', 10)
const PORT = await findAvailablePort(preferredPort)

function info(msg) { console.log(`\x1b[1;34m==>\x1b[0m ${msg}`) }
function ok(msg)   { console.log(`\x1b[1;32m==>\x1b[0m ${msg}`) }

function run(cmd, opts = {}) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts })
}

const nextDir = path.join(ROOT, '.next')
if (!existsSync(nextDir)) {
  info('Building production bundle (first run)...')
  run('npm run build')
}

if (PORT !== preferredPort) info(`Port ${preferredPort} is in use, using ${PORT} instead`)
ok(`Starting SiteClone on http://localhost:${PORT}`)
console.log('  Press Ctrl+C to stop.\n')

const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
})

server.on('close', (code) => process.exit(code ?? 0))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.kill(sig))
}
