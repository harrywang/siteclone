import { NextResponse } from 'next/server'
import { detectStack, detectStackDeep } from '@/lib/cloner/detect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  let body: { url?: string; deep?: boolean } = {}
  try {
    body = (await req.json()) as { url?: string; deep?: boolean }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.url) return NextResponse.json({ error: 'url is required' }, { status: 400 })
  try {
    new URL(body.url)
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  try {
    // Default to deep — it adds latency only when the shallow probe couldn't
    // classify, and gives us the right answer for TLS-blocked sites.
    const result = body.deep === false ? await detectStack(body.url) : await detectStackDeep(body.url)
    return NextResponse.json(result)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
