'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface AuthStatus {
  connected: boolean
  login?: string
  name?: string | null
  avatarUrl?: string
  htmlUrl?: string
  degraded?: boolean
  error?: string
}

export default function SettingsPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/github/auth', { cache: 'no-store' })
      const j = (await res.json()) as AuthStatus
      setStatus(j)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function save() {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/github/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const j = (await res.json()) as AuthStatus & { error?: string }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setStatus(j)
      setToken('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      await fetch('/api/github/auth', { method: 'DELETE' })
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <Link
        href="/"
        className="self-start text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        ← Back
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-base font-semibold">GitHub</h2>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Connect a GitHub account to deploy clones to GitHub Pages. We use a personal
          access token (PAT) with <code className="font-mono">repo</code> scope. The token
          is stored locally (mode 0600), never sent anywhere except to{' '}
          <code className="font-mono">api.github.com</code>.
        </p>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {status?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-md border border-green-300 bg-green-50 px-3 py-2 dark:border-green-900 dark:bg-green-950">
              {status.avatarUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={status.avatarUrl}
                  alt=""
                  className="h-8 w-8 rounded-full"
                />
              )}
              <div className="text-sm">
                <div className="font-medium text-green-900 dark:text-green-100">
                  Connected as @{status.login}
                </div>
                {status.name && (
                  <div className="text-xs text-green-800 dark:text-green-200">
                    {status.name}
                  </div>
                )}
              </div>
            </div>
            {status.degraded && status.error && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Warning: {status.error}
              </p>
            )}
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-zinc-950 dark:text-red-300 dark:hover:bg-red-950"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… or github_pat_…"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={busy || !token.trim()}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {busy ? 'Verifying…' : 'Connect'}
              </button>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=SiteClone"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Generate a token →
              </a>
            </div>
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer">What scopes do I need?</summary>
              <p className="mt-1">
                <strong>Classic PAT</strong>: <code className="font-mono">repo</code>{' '}
                (creates the deployment repo + pushes content + enables Pages).
              </p>
              <p className="mt-1">
                <strong>Fine-grained PAT</strong>: select{' '}
                <em>All repositories</em> or specific ones, then enable{' '}
                <em>Administration: read & write</em>,{' '}
                <em>Contents: read & write</em>, and <em>Pages: read & write</em>.
              </p>
            </details>
          </div>
        )}
      </section>
    </main>
  )
}
