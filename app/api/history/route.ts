import { NextResponse } from 'next/server'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const runtime = 'nodejs'

interface FolderEntry {
  name: string
  path: string
  fileCount: number
  totalBytes: number
  lastModified: number
}

function getRoot(): string {
  return (
    process.env.SITECLONE_OUTPUT_ROOT ||
    path.join(os.homedir(), 'Documents', 'SiteClone')
  )
}

function walkSize(dir: string): { count: number; bytes: number; mtime: number } {
  let count = 0
  let bytes = 0
  let mtime = 0
  const stack: string[] = [dir]
  while (stack.length) {
    const p = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(p)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name === '.DS_Store') continue
      const full = path.join(p, name)
      try {
        const s = statSync(full)
        if (s.mtimeMs > mtime) mtime = s.mtimeMs
        if (s.isDirectory()) {
          stack.push(full)
        } else if (s.isFile()) {
          count++
          bytes += s.size
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
  return { count, bytes, mtime }
}

export async function GET() {
  const root = getRoot()
  if (!existsSync(root)) {
    return NextResponse.json({ root, entries: [] as FolderEntry[] })
  }

  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }

  const entries: FolderEntry[] = []
  for (const name of names) {
    if (name === '.DS_Store' || name.startsWith('.')) continue
    const full = path.join(root, name)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (!s.isDirectory()) continue

    const { count, bytes, mtime } = walkSize(full)
    entries.push({
      name,
      path: full,
      fileCount: count,
      totalBytes: bytes,
      lastModified: mtime || s.mtimeMs,
    })
  }

  entries.sort((a, b) => b.lastModified - a.lastModified)
  return NextResponse.json({ root, entries })
}

/**
 * Deletes a clone folder. Refuses any path outside the configured output root —
 * this endpoint must NOT be a generic rm-rf primitive.
 */
export async function DELETE(req: Request) {
  let body: { path?: string } = {}
  try {
    body = (await req.json()) as { path?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const target = body.path
  if (!target || typeof target !== 'string') {
    return NextResponse.json({ error: 'path is required' }, { status: 400 })
  }
  if (!path.isAbsolute(target)) {
    return NextResponse.json({ error: 'path must be absolute' }, { status: 400 })
  }
  const root = path.resolve(getRoot())
  const resolved = path.resolve(target)
  // Must be a strict child of root (not root itself, not outside root).
  if (!resolved.startsWith(root + path.sep) || resolved === root) {
    return NextResponse.json(
      { error: 'path must be inside the SiteClone output root' },
      { status: 400 },
    )
  }
  if (!existsSync(resolved)) {
    return NextResponse.json({ error: 'path does not exist' }, { status: 404 })
  }
  let s
  try {
    s = statSync(resolved)
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
  if (!s.isDirectory()) {
    return NextResponse.json({ error: 'path is not a directory' }, { status: 400 })
  }

  try {
    await rm(resolved, { recursive: true, force: true })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
