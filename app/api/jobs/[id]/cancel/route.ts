import { NextResponse } from 'next/server'
import { registry } from '@/lib/cloner/registry'

export const runtime = 'nodejs'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ok = registry.cancel(id)
  if (!ok) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  return NextResponse.json({ cancelled: true })
}
