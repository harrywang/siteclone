import { NextResponse } from 'next/server'
import { registry } from '@/lib/cloner/registry'
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  type CloneMode,
  type CloneOptions,
} from '@/lib/cloner/types'

export const runtime = 'nodejs'

interface StartRequest {
  url?: string
  outputDir?: string
  depth?: number
  concurrency?: number
  mode?: CloneMode
  includeAssets?: boolean
  maxFileSizeMiB?: number // human-friendly; we convert to bytes
}

export async function POST(req: Request) {
  let body: StartRequest = {}
  try {
    body = (await req.json()) as StartRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.url) return NextResponse.json({ error: 'url is required' }, { status: 400 })
  if (!body.outputDir)
    return NextResponse.json({ error: 'outputDir is required' }, { status: 400 })

  let parsed: URL
  try {
    parsed = new URL(body.url)
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'URL must be http(s)' }, { status: 400 })
  }

  const maxBytes =
    typeof body.maxFileSizeMiB === 'number' && body.maxFileSizeMiB >= 0
      ? Math.floor(body.maxFileSizeMiB * 1024 * 1024)
      : DEFAULT_MAX_FILE_SIZE_BYTES

  const options: CloneOptions = {
    url: body.url,
    outputDir: body.outputDir,
    depth: clamp(body.depth ?? 2, 0, 10),
    concurrency: clamp(body.concurrency ?? 4, 1, 16),
    mode: body.mode === 'dynamic' ? 'dynamic' : 'static',
    includeAssets: body.includeAssets ?? true,
    rewriteRoot: true,
    maxFileSizeBytes: maxBytes,
    timeoutMs: 30_000,
  }

  const jobId = await registry.start(options)
  return NextResponse.json({ jobId })
}

export async function GET() {
  return NextResponse.json({ jobs: registry.list() })
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}
