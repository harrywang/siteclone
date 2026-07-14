#!/usr/bin/env node

/**
 * Prepare the Next.js standalone build for Electron packaging.
 * Resolves symlinks and copies everything into a flat directory structure
 * that electron-builder can handle.
 *
 * Mirrors agentfit's prepare-electron.mjs.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  readlinkSync,
  lstatSync,
  readdirSync,
} from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const STANDALONE = path.join(ROOT, '.next', 'standalone')
const DEST = path.join(ROOT, 'electron', 'server')

console.log('Preparing standalone build for Electron...')

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })

cpSync(STANDALONE, DEST, { recursive: true, dereference: true })

function fixSymlinks(dir) {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    try {
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(fullPath)
        if (path.isAbsolute(target) || !target.startsWith('.')) {
          const moduleName = entry.name.replace(/-[a-f0-9]+$/, '')
          const scope = path.basename(path.dirname(fullPath))
          const resolvedInDest = path.join(DEST, 'node_modules', scope, moduleName)
          if (existsSync(resolvedInDest)) {
            console.log(`  Fixing symlink: ${path.relative(DEST, fullPath)}`)
            unlinkSync(fullPath)
            cpSync(resolvedInDest, fullPath, { recursive: true, dereference: true })
          } else {
            console.log(`  Warning: Cannot resolve symlink ${path.relative(DEST, fullPath)} -> ${target}`)
            unlinkSync(fullPath)
          }
        }
      } else if (stat.isDirectory()) {
        fixSymlinks(fullPath)
      }
    } catch {
      // ignore individual file errors
    }
  }
}

fixSymlinks(path.join(DEST, '.next', 'node_modules'))

const staticSrc = path.join(ROOT, '.next', 'static')
const staticDest = path.join(DEST, '.next', 'static')
if (existsSync(staticSrc)) cpSync(staticSrc, staticDest, { recursive: true })

const publicSrc = path.join(ROOT, 'public')
const publicDest = path.join(DEST, 'public')
if (existsSync(publicSrc)) cpSync(publicSrc, publicDest, { recursive: true })

for (const localPath of ['output', 'dist-electron']) {
  const p = path.join(DEST, localPath)
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true })
    console.log(`  Removed: ${localPath}`)
  }
}

const pruneList = [
  'typescript',
  '@img',
  'sharp',
  '@next/swc-linux-x64-gnu',
  '@next/swc-linux-x64-musl',
  '@next/swc-linux-arm64-gnu',
  '@next/swc-linux-arm64-musl',
  '@next/swc-win32-x64-msvc',
  '@next/swc-win32-arm64-msvc',
]
for (const pkg of pruneList) {
  const pkgPath = path.join(DEST, 'node_modules', pkg)
  if (existsSync(pkgPath)) {
    rmSync(pkgPath, { recursive: true, force: true })
    console.log(`  Pruned: node_modules/${pkg}`)
  }
}

try {
  const remaining = execSync(`find "${DEST}" -type l 2>/dev/null`).toString().trim()
  if (remaining) {
    console.log('\nWarning: remaining symlinks found:')
    console.log(remaining)
  } else {
    console.log('\nNo symlinks remaining - clean build!')
  }
} catch {
  // find returns non-zero if no matches
}

console.log('Done! Standalone server prepared at electron/server/')
