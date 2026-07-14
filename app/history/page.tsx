'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface FolderEntry {
  name: string
  path: string
  fileCount: number
  totalBytes: number
  lastModified: number
}

interface HistoryResponse {
  root: string
  entries: FolderEntry[]
}

interface AuthStatus {
  connected: boolean
  login?: string
  avatarUrl?: string
}

export default function HistoryPage() {
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [openDeployFor, setOpenDeployFor] = useState<string | null>(null)

  async function load() {
    setError(null)
    try {
      const res = await fetch('/api/history', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as HistoryResponse
      setData(j)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function loadAuth() {
    try {
      const res = await fetch('/api/github/auth', { cache: 'no-store' })
      const j = (await res.json()) as AuthStatus
      setAuth(j)
    } catch {
      // ignore — we'll show "Connect" anyway
    }
  }

  useEffect(() => {
    void load()
    void loadAuth()
  }, [])

  async function reveal(p: string) {
    try {
      await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function confirmDelete(p: string) {
    setDeleting(p)
    setError(null)
    try {
      const res = await fetch('/api/history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      setPendingDelete(null)
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← New clone
        </Link>
        <Link
          href="/settings"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Settings
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Clone history</h1>
        {data && <p className="font-mono text-xs text-zinc-500">{data.root}</p>}
      </header>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      {!data ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : data.entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">No clones yet.</p>
          <Link
            href="/"
            className="mt-3 inline-block text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
          >
            Start your first clone →
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {data.entries.map((e) => (
            <li
              key={e.path}
              className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                      {e.name}
                    </span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {e.fileCount} {e.fileCount === 1 ? 'file' : 'files'}
                    </span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {formatBytes(e.totalBytes)}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {formatRelativeTime(e.lastModified)}
                    </span>
                  </div>
                  <p className="truncate font-mono text-[11px] text-zinc-500">{e.path}</p>
                </div>

                <div className="flex flex-shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void reveal(e.path)}
                    className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenDeployFor(openDeployFor === e.path ? null : e.path)
                    }
                    className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
                  >
                    {openDeployFor === e.path ? 'Hide deploy' : 'Deploy'}
                  </button>
                  {pendingDelete === e.path ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void confirmDelete(e.path)}
                        disabled={deleting === e.path}
                        className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleting === e.path ? 'Deleting…' : 'Confirm delete'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(null)}
                        disabled={deleting === e.path}
                        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(e.path)}
                      className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {openDeployFor === e.path && (
                <DeployPanel
                  folder={e.path}
                  defaultName={`siteclone-${e.name}`}
                  auth={auth}
                  onAuthChange={loadAuth}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-zinc-500">
        Folders directly under your SiteClone output root. Clones saved elsewhere aren't
        tracked here.
      </p>
    </main>
  )
}

interface DeployState {
  id: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  stats: { totalFiles: number; uploaded: number; bytes: number }
  log: { ts: number; level: 'info' | 'warn' | 'error'; msg: string }[]
  result?: { pagesUrl: string; repoUrl: string }
  error?: string
}

interface RepoSummary {
  name: string
  fullName: string
  owner: string
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

type DeployMode = 'new-repo' | 'existing-repo'

function DeployPanel({
  folder,
  defaultName,
  auth,
  onAuthChange,
}: {
  folder: string
  defaultName: string
  auth: AuthStatus | null
  onAuthChange: () => void | Promise<void>
}) {
  const [mode, setMode] = useState<DeployMode>('new-repo')
  const [repoName, setRepoName] = useState(sanitizeRepo(defaultName))
  const [isPrivate, setIsPrivate] = useState(false)

  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [selectedRepo, setSelectedRepo] = useState<string>('') // fullName "owner/repo"
  const folderBaseName = defaultName.replace(/^siteclone-/, '')
  const [subpath, setSubpath] = useState(sanitizeSub(folderBaseName))

  const [deploy, setDeploy] = useState<DeployState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lazy-fetch repos when the user switches to existing-repo mode.
  useEffect(() => {
    if (mode !== 'existing-repo' || repos !== null || !auth?.connected) return
    void (async () => {
      try {
        const res = await fetch('/api/github/repos', { cache: 'no-store' })
        const j = (await res.json()) as { repos?: RepoSummary[]; error?: string }
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
        setRepos(j.repos ?? [])
      } catch (err: unknown) {
        setReposError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [mode, repos, auth])

  // Poll deploy status while it's running.
  useEffect(() => {
    if (
      !deploy ||
      deploy.status === 'done' ||
      deploy.status === 'error' ||
      deploy.status === 'cancelled'
    )
      return
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/github/deploys/${deploy.id}`, { cache: 'no-store' })
        if (!res.ok) return
        const j = (await res.json()) as DeployState
        setDeploy(j)
      } catch {
        // keep polling
      }
    }, 1000)
    return () => clearInterval(t)
  }, [deploy])

  async function start() {
    setSubmitting(true)
    setError(null)
    try {
      let target: unknown
      if (mode === 'new-repo') {
        if (!repoName) throw new Error('Repo name is required')
        target = { kind: 'new-repo', repoName, isPrivate }
      } else {
        if (!selectedRepo) throw new Error('Pick an existing repo')
        const [owner, repo] = selectedRepo.split('/')
        target = { kind: 'existing-repo', owner, repo, subpath }
      }
      const res = await fetch('/api/github/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, target }),
      })
      const j = (await res.json()) as { deployId?: string; error?: string }
      if (!res.ok || !j.deployId) throw new Error(j.error || `HTTP ${res.status}`)
      const stateRes = await fetch(`/api/github/deploys/${j.deployId}`, { cache: 'no-store' })
      setDeploy((await stateRes.json()) as DeployState)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!auth?.connected) {
    return (
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Not connected to GitHub.{' '}
        <Link href="/settings" className="font-medium underline" onClick={() => void onAuthChange()}>
          Connect a token
        </Link>{' '}
        to deploy this folder.
      </div>
    )
  }

  if (deploy) {
    return <DeployProgress deploy={deploy} />
  }

  // Compute live URL preview for the user.
  const previewUrl = (() => {
    if (mode === 'new-repo') {
      return `https://${auth.login}.github.io/${repoName || '<repo>'}/`
    }
    if (!selectedRepo) return ''
    const [owner, repo] = selectedRepo.split('/')
    return subpath
      ? `https://${owner}.github.io/${repo}/${subpath}/`
      : `https://${owner}.github.io/${repo}/`
  })()

  return (
    <div className="mt-3 space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs text-zinc-600 dark:text-zinc-400">
        Deploy as <strong>@{auth.login}</strong>.
      </div>

      <div className="flex flex-wrap gap-1 rounded-md border border-zinc-300 bg-white p-1 dark:border-zinc-700 dark:bg-zinc-900">
        <ModeTab active={mode === 'new-repo'} onClick={() => setMode('new-repo')}>
          New repo
        </ModeTab>
        <ModeTab active={mode === 'existing-repo'} onClick={() => setMode('existing-repo')}>
          Existing repo
        </ModeTab>
      </div>

      {mode === 'new-repo' && (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="block font-medium text-zinc-700 dark:text-zinc-300">Repo name</span>
            <input
              type="text"
              value={repoName}
              onChange={(e) => setRepoName(sanitizeRepo(e.target.value))}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            <span>
              Private repo{' '}
              <span className="text-zinc-500">
                (Pages from private repos requires GitHub Pro/Team)
              </span>
            </span>
          </label>
        </div>
      )}

      {mode === 'existing-repo' && (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="block font-medium text-zinc-700 dark:text-zinc-300">
              Repo
            </span>
            {repos === null && !reposError ? (
              <p className="mt-1 text-zinc-500">Loading your repos…</p>
            ) : reposError ? (
              <p className="mt-1 text-red-600 dark:text-red-400">{reposError}</p>
            ) : repos && repos.length === 0 ? (
              <p className="mt-1 text-zinc-500">No repos found.</p>
            ) : (
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">Select a repo…</option>
                {repos!.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                    {r.private ? ' (private)' : ''}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="block text-xs">
            <span className="block font-medium text-zinc-700 dark:text-zinc-300">
              Subfolder
            </span>
            <input
              type="text"
              value={subpath}
              onChange={(e) => setSubpath(sanitizeSub(e.target.value))}
              placeholder="(empty = repo root, replaces all)"
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="mt-1 block text-[11px] text-zinc-500">
              {subpath
                ? `Replaces files under "${subpath}/" — other repo content is preserved.`
                : 'Empty subfolder — replaces every file in the repo. Be careful with shared repos.'}
            </span>
          </label>
        </div>
      )}

      {previewUrl && (
        <div className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-zinc-500">Will be served at:</span>{' '}
          <span className="break-all font-mono text-zinc-800 dark:text-zinc-200">
            {previewUrl}
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={() => void start()}
        disabled={
          submitting ||
          (mode === 'new-repo' && !repoName) ||
          (mode === 'existing-repo' && !selectedRepo)
        }
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {submitting ? 'Starting…' : 'Deploy to GitHub Pages'}
      </button>
    </div>
  )
}

function ModeTab({
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
        'flex-1 rounded px-2 py-1 text-xs font-medium transition ' +
        (active
          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')
      }
    >
      {children}
    </button>
  )
}

function DeployProgress({ deploy }: { deploy: DeployState }) {
  return (
    <div className="mt-3 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={
            'rounded-full border px-2 py-0.5 font-medium ' +
            (deploy.status === 'done'
              ? 'border-green-300 bg-green-100 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300'
              : deploy.status === 'error'
                ? 'border-red-300 bg-red-100 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                : 'border-blue-300 bg-blue-100 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300')
          }
        >
          {deploy.status}
        </span>
        {deploy.stats.totalFiles > 0 && (
          <span className="text-zinc-600 dark:text-zinc-400">
            {deploy.stats.uploaded} / {deploy.stats.totalFiles} files
          </span>
        )}
      </div>

      {deploy.result && (
        <div className="space-y-1 rounded-md border border-green-300 bg-green-50 p-2 text-xs dark:border-green-900 dark:bg-green-950">
          <p className="font-medium text-green-900 dark:text-green-100">
            Deploy complete (Pages can take ~30s to go live).
          </p>
          <p className="break-all">
            <span className="text-zinc-600 dark:text-zinc-400">Site:</span>{' '}
            <a
              href={deploy.result.pagesUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-zinc-900 underline dark:text-zinc-100"
            >
              {deploy.result.pagesUrl}
            </a>
          </p>
          <p className="break-all">
            <span className="text-zinc-600 dark:text-zinc-400">Repo:</span>{' '}
            <a
              href={deploy.result.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-zinc-900 underline dark:text-zinc-100"
            >
              {deploy.result.repoUrl}
            </a>
          </p>
        </div>
      )}

      {deploy.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {deploy.error}
        </div>
      )}

      <details className="text-[11px] text-zinc-500">
        <summary className="cursor-pointer">Log</summary>
        <div className="mt-1 max-h-48 overflow-auto rounded bg-zinc-950 p-2 font-mono text-zinc-100">
          {deploy.log.map((entry, i) => (
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
              {entry.msg}
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

function sanitizeSub(s: string): string {
  return s
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((seg) =>
      seg
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, ''),
    )
    .filter(Boolean)
    .join('/')
    .slice(0, 200)
}

function sanitizeRepo(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return `${Math.round(diff / 86_400_000)} d ago`
}
