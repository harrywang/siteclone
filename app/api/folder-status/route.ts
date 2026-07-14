import { NextResponse } from 'next/server'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const runtime = 'nodejs'

/**
 * Inspects a folder so the UI can warn before overwriting an existing clone.
 * Refuses non-absolute paths and root-ish paths to avoid being weaponized.
 */
export async function GET(req: Request) {
  const u = new URL(req.url)
  const target = u.searchParams.get('path')
  if (!target) return NextResponse.json({ error: 'path is required' }, { status: 400 })
  if (!path.isAbsolute(target)) {
    return NextResponse.json({ error: 'path must be absolute' }, { status: 400 })
  }

  if (!existsSync(target)) {
    return NextResponse.json({ exists: false, fileCount: 0, lastModified: null })
  }

  let entries: string[] = []
  try {
    entries = readdirSync(target)
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }

  let fileCount = 0
  let lastModified = 0
  for (const name of entries) {
    if (name === '.DS_Store') continue
    try {
      const s = statSync(path.join(target, name))
      if (s.isFile()) fileCount++
      else if (s.isDirectory()) fileCount++ // count dirs too — they're stuff in the folder
      if (s.mtimeMs > lastModified) lastModified = s.mtimeMs
    } catch {
      // skip unreadable entries
    }
  }

  return NextResponse.json({
    exists: true,
    fileCount,
    lastModified: lastModified > 0 ? lastModified : null,
  })
}
