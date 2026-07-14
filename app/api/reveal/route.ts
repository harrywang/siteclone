import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const runtime = 'nodejs'

/**
 * Open a folder in the OS file manager (Finder / Explorer / xdg-open).
 * The folder must be an absolute path that exists — refuses anything else
 * to avoid being abused as a "run arbitrary path" endpoint.
 */
export async function POST(req: Request) {
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
  if (!existsSync(target)) {
    return NextResponse.json({ error: 'path does not exist' }, { status: 404 })
  }

  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open'

  try {
    const child = spawn(cmd, [target], { stdio: 'ignore', detached: true })
    child.unref()
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
