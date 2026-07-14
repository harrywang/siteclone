import { NextResponse } from 'next/server'
import os from 'node:os'
import path from 'node:path'

export const runtime = 'nodejs'

/**
 * Returns sensible defaults for the UI:
 *   - outputRoot: where clones are saved by default (set by Electron via env;
 *     falls back to ~/Documents/SiteClone in dev or standalone CLI use).
 *   - hasChromium: best-effort hint for whether dynamic mode is ready.
 */
export async function GET() {
  const outputRoot =
    process.env.SITECLONE_OUTPUT_ROOT ||
    path.join(os.homedir(), 'Documents', 'SiteClone')

  const hasChromium = !!process.env.PLAYWRIGHT_CHROMIUM_PATH || hasPlaywrightCache()

  return NextResponse.json({
    outputRoot,
    hasChromium,
    platform: process.platform,
  })
}

function hasPlaywrightCache(): boolean {
  // Heuristic — playwright stores browsers under these paths by default.
  // We don't actually open them; we just check existence as a hint.
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const candidates = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
      path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
      path.join(os.homedir(), '.cache', 'ms-playwright'),
    ].filter(Boolean) as string[]
    return candidates.some((c) => fs.existsSync(c))
  } catch {
    return false
  }
}
