import { NextResponse } from 'next/server'
import { deployRegistry } from '@/lib/github/registry'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = deployRegistry.get(id)
  if (!job) return NextResponse.json({ error: 'Deploy not found' }, { status: 404 })
  return NextResponse.json(job)
}
