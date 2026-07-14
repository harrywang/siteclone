'use client'

import { useEffect, useRef, useState, use } from 'react'
import Link from 'next/link'
import type { JobState } from '@/lib/cloner/types'

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [job, setJob] = useState<JobState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const ev = new EventSource(`/api/jobs/${id}/stream`)
    ev.onmessage = (e) => {
      try {
        setJob(JSON.parse(e.data) as JobState)
      } catch {
        // ignore parse errors
      }
    }
    ev.onerror = () => {
      // EventSource auto-reconnects; we only surface errors when the job is missing.
      if (ev.readyState === EventSource.CLOSED) {
        ev.close()
      }
    }
    return () => ev.close()
  }, [id])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [job?.log.length])

  async function cancel() {
    try {
      await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function openFolder() {
    if (!job) return
    try {
      const res = await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: job.options.outputDir }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${res.status}`)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!job) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <p className="text-sm text-zinc-500">Loading job…</p>
      </main>
    )
  }

  const running = job.status === 'pending' || job.status === 'running'
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <Link href="/" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            ← New clone
          </Link>
          <Link
            href="/history"
            className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            History
          </Link>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950"
            >
              Cancel
            </button>
          )}
          {!running && job.stats.bytesWritten > 0 && (
            <button
              type="button"
              onClick={openFolder}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Open folder
            </button>
          )}
        </div>
      </div>

      <header className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{job.options.url}</h1>
          <StatusBadge status={job.status} />
        </div>
        <button
          type="button"
          onClick={openFolder}
          className="font-mono text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
          title="Open folder"
        >
          {job.options.outputDir}
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Pages" value={job.stats.pagesCrawled} />
        <Stat label="Assets" value={job.stats.assetsCrawled} />
        <Stat
          label="Size"
          value={`${(job.stats.bytesWritten / 1024 / 1024).toFixed(2)} MiB`}
        />
        <Stat label="Elapsed" value={`${elapsed.toFixed(1)}s`} />
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
      {job.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {job.error}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">Activity</h2>
        <div
          ref={logRef}
          className="h-96 overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-3 font-mono text-xs text-zinc-100 dark:border-zinc-800"
        >
          {job.log.map((entry, i) => (
            <div
              key={i}
              className={
                entry.level === 'error'
                  ? 'text-red-300'
                  : entry.level === 'warn'
                    ? 'text-amber-300'
                    : 'text-zinc-200'
              }
            >
              <span className="text-zinc-500">{new Date(entry.ts).toLocaleTimeString()}</span>{' '}
              {entry.msg}
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

function StatusBadge({ status }: { status: JobState['status'] }) {
  const map: Record<JobState['status'], string> = {
    pending:
      'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700',
    running:
      'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
    done: 'bg-green-100 text-green-700 border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-900',
    error:
      'bg-red-100 text-red-700 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-900',
    cancelled:
      'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
  }
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${map[status]}`}>
      {status}
    </span>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
