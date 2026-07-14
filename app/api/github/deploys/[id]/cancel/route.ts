import { NextResponse } from 'next/server'
import { deployRegistry } from '@/lib/github/registry'

export const runtime = 'nodejs'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ok = deployRegistry.cancel(id)
  if (!ok) return NextResponse.json({ error: 'Deploy not found' }, { status: 404 })
  return NextResponse.json({ cancelled: true })
}
