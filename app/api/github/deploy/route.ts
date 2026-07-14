import { NextResponse } from 'next/server'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { readAuth } from '@/lib/github/auth'
import { sanitizeRepoName, sanitizeSubpath, type DeployTarget } from '@/lib/github/deploy'
import { deployRegistry } from '@/lib/github/registry'

export const runtime = 'nodejs'

interface DeployRequest {
  folder?: string
  message?: string
  target?:
    | { kind: 'new-repo'; repoName?: string; isPrivate?: boolean }
    | { kind: 'existing-repo'; owner?: string; repo?: string; subpath?: string }
}

export async function POST(req: Request) {
  const auth = readAuth()
  if (!auth) {
    return NextResponse.json(
      { error: 'GitHub not connected — visit /settings to add a token' },
      { status: 401 },
    )
  }

  let body: DeployRequest = {}
  try {
    body = (await req.json()) as DeployRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const folder = body.folder
  if (!folder || !path.isAbsolute(folder)) {
    return NextResponse.json({ error: 'folder must be an absolute path' }, { status: 400 })
  }
  if (!existsSync(folder)) {
    return NextResponse.json({ error: 'folder does not exist' }, { status: 404 })
  }
  let s
  try {
    s = statSync(folder)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
  if (!s.isDirectory()) {
    return NextResponse.json({ error: 'folder is not a directory' }, { status: 400 })
  }

  if (!body.target) {
    return NextResponse.json({ error: 'target is required' }, { status: 400 })
  }

  let target: DeployTarget
  if (body.target.kind === 'new-repo') {
    const repoName = sanitizeRepoName(
      body.target.repoName || path.basename(folder),
    )
    if (!repoName) {
      return NextResponse.json({ error: 'Could not derive a valid repo name' }, { status: 400 })
    }
    target = {
      kind: 'new-repo',
      repoName,
      isPrivate: !!body.target.isPrivate,
    }
  } else if (body.target.kind === 'existing-repo') {
    const owner = (body.target.owner || auth.login || '').trim()
    const repo = (body.target.repo || '').trim()
    if (!owner || !repo) {
      return NextResponse.json(
        { error: 'existing-repo target needs owner and repo' },
        { status: 400 },
      )
    }
    target = {
      kind: 'existing-repo',
      owner,
      repo,
      subpath: sanitizeSubpath(body.target.subpath || path.basename(folder)),
    }
  } else {
    return NextResponse.json({ error: 'unknown target.kind' }, { status: 400 })
  }

  const id = await deployRegistry.start({
    token: auth.token,
    folder,
    target,
    message: body.message,
  })
  return NextResponse.json({ deployId: id, target })
}
