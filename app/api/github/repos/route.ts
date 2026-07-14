import { NextResponse } from 'next/server'
import { readAuth } from '@/lib/github/auth'
import { GHClient } from '@/lib/github/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = readAuth()
  if (!auth) {
    return NextResponse.json({ error: 'not connected' }, { status: 401 })
  }
  try {
    const repos = await new GHClient(auth.token).listRepos({ perPage: 100 })
    return NextResponse.json({
      repos: repos.map((r) => ({
        name: r.name,
        fullName: r.full_name,
        owner: r.owner.login,
        defaultBranch: r.default_branch,
        private: r.private,
        htmlUrl: r.html_url,
      })),
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
