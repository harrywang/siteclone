'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface Defaults {
  outputRoot: string
  hasChromium: boolean
  platform: string
}

interface DetectResult {
  url: string
  finalUrl: string
  status: number
  reachable: boolean
  blocked: boolean
  blockedButContentReadable: boolean
  stack: string
  stackLabel: string
  version: string | null
  theme: string | null
  generator: string | null
  cdn: string | null
  recommendedMode: 'static' | 'dynamic'
  recommendationReason: string
  signals: string[]
}

export default function HomePage() {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [depth, setDepth] = useState(2)
  const [concurrency, setConcurrency] = useState(4)
  const [maxFileSizeMiB, setMaxFileSizeMiB] = useState(10) // covers typical assets; bump for video
  const [mode, setMode] = useState<'static' | 'dynamic'>('static')
  const [modeTouched, setModeTouched] = useState(false)
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [detectedUrl, setDetectedUrl] = useState<string>('')

  const [folderStatus, setFolderStatus] = useState<{
    exists: boolean
    fileCount: number
    lastModified: number | null
  } | null>(null)
  const [overwriteAcknowledged, setOverwriteAcknowledged] = useState(false)
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/defaults')
        const j: Defaults = await res.json()
        setDefaults(j)
      } catch {
        // ignore — user can type manually
      }
    })()
  }, [])

  // Auto-suggest an output dir from the URL hostname.
  useEffect(() => {
    if (!defaults || !url || outputDir) return
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^www\./, '')
      const sep = defaults.platform === 'win32' ? '\\' : '/'
      setOutputDir(`${defaults.outputRoot}${sep}${host}`)
    } catch {
      // partial URL — ignore
    }
  }, [url, defaults, outputDir])

  // Auto-run detect 600ms after the URL stops changing — covers users who
  // paste and immediately click Start without blurring the input.
  useEffect(() => {
    if (!url || url === detectedUrl) return
    try {
      new URL(url)
    } catch {
      return
    }
    const t = setTimeout(() => {
      void runDetect(url)
    }, 600)
    return () => clearTimeout(t)
    // runDetect is stable enough — it reads modeTouched/detectedUrl from closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // Watch the output folder and warn if it already has files.
  useEffect(() => {
    setFolderStatus(null)
    setOverwriteAcknowledged(false)
    setConfirmingOverwrite(false)
    if (!outputDir) return
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/folder-status?path=${encodeURIComponent(outputDir)}`)
        if (!res.ok) return
        const j = (await res.json()) as {
          exists: boolean
          fileCount: number
          lastModified: number | null
        }
        setFolderStatus(j)
      } catch {
        // ignore — non-existent or permission-denied paths are fine
      }
    }, 400)
    return () => clearTimeout(t)
  }, [outputDir])

  async function runDetect(targetUrl: string) {
    if (!targetUrl || targetUrl === detectedUrl) return
    try {
      new URL(targetUrl)
    } catch {
      return
    }
    setDetecting(true)
    setDetectError(null)
    setDetect(null)
    try {
      const res = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      })
      const j = (await res.json()) as DetectResult & { error?: string }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setDetect(j)
      setDetectedUrl(targetUrl)
      // Auto-select the recommended mode unless the user already changed it.
      if (!modeTouched) setMode(j.recommendedMode)
    } catch (err: unknown) {
      setDetectError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetecting(false)
    }
  }

  // True once we have a detect result (success OR error) for the URL currently
  // in the input. Becomes false the moment the URL changes.
  const detectIsCurrent =
    !!url && url === detectedUrl && (detect !== null || detectError !== null)
  const startDisabled =
    submitting || !url || !outputDir || detecting || !detectIsCurrent
  const startBlockedReason = !url
    ? null
    : detecting
      ? 'Detecting site…'
      : !detectIsCurrent
        ? 'Waiting for detection…'
        : null

  async function startCloneRequest() {
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          outputDir,
          depth,
          concurrency,
          mode,
          includeAssets: true,
          maxFileSizeMiB,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      const { jobId } = (await res.json()) as { jobId: string }
      router.push(`/jobs/${jobId}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (
      folderStatus?.exists &&
      folderStatus.fileCount > 0 &&
      !overwriteAcknowledged
    ) {
      setConfirmingOverwrite(true)
      return
    }
    void startCloneRequest()
  }

  async function openOutputFolder() {
    if (!outputDir) return
    try {
      await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: outputDir }),
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">SiteClone</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Mirror any website into a self-contained static HTML/JS folder.
          </p>
        </div>
        <div className="flex items-center gap-2 self-center">
          <Link
            href="/history"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          >
            History
          </Link>
          <Link
            href="/settings"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          >
            Settings
          </Link>
        </div>
      </header>

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <Field label="Website URL" hint="The starting page. We crawl from here.">
          <div className="flex gap-2">
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={(e) => void runDetect(e.target.value)}
              placeholder="https://example.com"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="button"
              onClick={() => void runDetect(url)}
              disabled={!url || detecting}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
            >
              {detecting && <Spinner />}
              {detecting ? 'Detecting…' : 'Detect'}
            </button>
          </div>
        </Field>

        {detecting && !detect && (
          <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            <Spinner />
            <span>Probing {url} for tech stack…</span>
          </div>
        )}
        {detect && <DetectPanel detect={detect} />}
        {detectError && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Detect failed: {detectError}
          </div>
        )}

        <Field
          label="Output folder"
          hint="Absolute path where files will be written. Created if missing."
        >
          <input
            type="text"
            required
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder="/Users/you/Documents/SiteClone/example.com"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
          />
          {folderStatus?.exists && folderStatus.fileCount > 0 && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <span className="flex-1">
                Folder already has{' '}
                <strong className="tabular-nums">{folderStatus.fileCount}</strong>{' '}
                {folderStatus.fileCount === 1 ? 'item' : 'items'}
                {folderStatus.lastModified && (
                  <> (last modified {formatRelativeTime(folderStatus.lastModified)})</>
                )}
                . A new clone will write alongside the existing files.
              </span>
              <button
                type="button"
                onClick={openOutputFolder}
                className="rounded border border-amber-400 bg-white px-2 py-1 text-[11px] font-medium hover:bg-amber-100 dark:border-amber-700 dark:bg-zinc-900 dark:hover:bg-amber-900"
              >
                Open folder
              </button>
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Depth" hint="0 = single page only.">
            <input
              type="number"
              min={0}
              max={10}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>
          <Field label="Concurrency" hint="Parallel requests.">
            <input
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
            />
          </Field>
        </div>

        <Field
          label="Max file size (MiB)"
          hint="Skip individual assets larger than this. Set 0 to disable."
        >
          <input
            type="number"
            min={0}
            max={1024}
            value={maxFileSizeMiB}
            onChange={(e) => setMaxFileSizeMiB(Math.max(0, Number(e.target.value)))}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
          />
        </Field>

        <Field
          label="Render mode"
          hint="Dynamic launches Chromium for JS-heavy / SPA / TLS-blocked sites."
        >
          <div className="flex gap-2">
            <ModeButton
              active={mode === 'static'}
              onClick={() => {
                setMode('static')
                setModeTouched(true)
              }}
            >
              Static (fast)
            </ModeButton>
            <ModeButton
              active={mode === 'dynamic'}
              onClick={() => {
                setMode('dynamic')
                setModeTouched(true)
              }}
            >
              Dynamic (Playwright)
            </ModeButton>
            {detect && !modeTouched && mode === detect.recommendedMode && (
              <span className="self-center text-xs text-zinc-500">
                ← auto-selected from detection
              </span>
            )}
          </div>
          {mode === 'dynamic' && defaults && !defaults.hasChromium && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              Chromium not detected. Run{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-950">
                npx playwright install chromium
              </code>{' '}
              once, or set <code className="font-mono">PLAYWRIGHT_CHROMIUM_PATH</code> to a Chrome
              binary.
            </p>
          )}
        </Field>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {confirmingOverwrite && folderStatus && (
          <div className="space-y-3 rounded-md border border-amber-400 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <p className="font-medium text-amber-900 dark:text-amber-100">
              This folder isn't empty
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-200">
              <span className="font-mono">{outputDir}</span> contains{' '}
              <strong>{folderStatus.fileCount}</strong>{' '}
              {folderStatus.fileCount === 1 ? 'item' : 'items'}. Cloning will write new
              files alongside them; older files won't be deleted automatically.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openOutputFolder}
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-zinc-900 dark:text-amber-100 dark:hover:bg-amber-900"
              >
                Open folder first
              </button>
              <button
                type="button"
                onClick={() => {
                  setOverwriteAcknowledged(true)
                  setConfirmingOverwrite(false)
                  void startCloneRequest()
                }}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                Continue anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirmingOverwrite(false)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          {startBlockedReason && (
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              {detecting && <Spinner />}
              {startBlockedReason}
            </span>
          )}
          <button
            type="submit"
            disabled={startDisabled}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {submitting ? 'Starting…' : 'Start clone'}
          </button>
        </div>
      </form>

      <p className="text-xs text-zinc-500">
        Crawls same-origin pages only. Respect robots.txt and the site's terms of use.
      </p>
    </main>
  )
}

function DetectPanel({ detect }: { detect: DetectResult }) {
  const tone = detect.blocked
    ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
    : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950'
  return (
    <div className={`rounded-md border px-3 py-3 text-xs ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{detect.stackLabel}</span>
        <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 font-mono text-[10px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          HTTP {detect.status}
        </span>
        {detect.cdn && (
          <span className="rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {detect.cdn}
          </span>
        )}
        <span
          className={
            'rounded-full px-2 py-0.5 text-[10px] font-medium ' +
            (detect.recommendedMode === 'dynamic'
              ? 'bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100'
              : 'bg-green-200 text-green-900 dark:bg-green-900 dark:text-green-100')
          }
        >
          recommended: {detect.recommendedMode}
        </span>
      </div>
      <p className="mt-2 text-zinc-700 dark:text-zinc-300">{detect.recommendationReason}</p>
      {detect.signals.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Signals
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-600 dark:text-zinc-400">
            {detect.signals.map((s, i) => (
              <li key={i} className="font-mono text-[11px]">
                {s}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md border px-3 py-1.5 text-sm transition ' +
        (active
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-300 bg-white text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300')
      }
    >
      {children}
    </button>
  )
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-current"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return `${Math.round(diff / 86_400_000)} d ago`
}
