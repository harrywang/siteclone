import { NextResponse } from 'next/server'
import { GHClient, GitHubError } from '@/lib/github/client'
import { clearAuth, readAuth, writeAuth } from '@/lib/github/auth'

export const runtime = 'nodejs'

export async function GET() {
  const a = readAuth()
  if (!a) return NextResponse.json({ connected: false })
  // Verify the stored token still works — invalidates lazily.
  try {
    const user = await new GHClient(a.token).getUser()
    return NextResponse.json({
      connected: true,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url,
    })
  } catch (err) {
    if (err instanceof GitHubError && err.status === 401) {
      clearAuth()
      return NextResponse.json({ connected: false, error: 'Token rejected by GitHub' })
    }
    return NextResponse.json({
      connected: true,
      login: a.login,
      degraded: true,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function POST(req: Request) {
  let body: { token?: string } = {}
  try {
    body = (await req.json()) as { token?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const token = (body.token || '').trim()
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 })

  // Validate by calling /user. Anything other than 2xx → reject.
  try {
    const user = await new GHClient(token).getUser()
    writeAuth({ token, login: user.login, savedAt: Date.now() })
    return NextResponse.json({
      connected: true,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Token check failed: ${msg}` }, { status: 401 })
  }
}

export async function DELETE() {
  clearAuth()
  return NextResponse.json({ connected: false })
}
