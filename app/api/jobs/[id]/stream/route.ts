import { registry } from '@/lib/cloner/registry'
import type { JobState } from '@/lib/cloner/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * SSE stream of job state updates. Emits the full JobState on every change.
 * Closes when the job reaches a terminal status (done/error/cancelled).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = registry.get(id)
  if (!job) {
    return new Response('Job not found', { status: 404 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      let unsubscribe: (() => void) | null = null
      let closed = false

      const send = (state: JobState) => {
        if (closed) return
        const payload = `data: ${JSON.stringify(state)}\n\n`
        controller.enqueue(encoder.encode(payload))
        if (state.status === 'done' || state.status === 'error' || state.status === 'cancelled') {
          closed = true
          unsubscribe?.()
          try { controller.close() } catch { /* ignore */ }
        }
      }

      // Subscribe first so a terminal initial snapshot can unsubscribe cleanly.
      unsubscribe = registry.subscribe(id, send)
      send(job)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
