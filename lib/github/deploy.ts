import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { GHClient, GitHubError, type GHTreeEntry } from './client'

/**
 * Two deployment shapes:
 *   - 'new-repo'      → create a fresh repo, push the clone at root, enable Pages.
 *   - 'existing-repo' → push the clone into a subpath of an existing repo,
 *                       preserving untouched files. URL ends up as
 *                       https://<owner>.github.io/<repo>/<subpath>/.
 */
export type DeployTarget =
  | { kind: 'new-repo'; repoName: string; isPrivate: boolean }
  | { kind: 'existing-repo'; owner: string; repo: string; subpath: string }

export interface DeployOptions {
  token: string
  folder: string
  target: DeployTarget
  message?: string
}

export interface DeployLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  msg: string
}

export interface DeployStats {
  totalFiles: number
  uploaded: number
  bytes: number
}

export type DeployStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface DeployResult {
  pagesUrl: string
  repoUrl: string
}

export interface DeployState {
  id: string
  options: Omit<DeployOptions, 'token'>
  status: DeployStatus
  startedAt: number
  endedAt?: number
  stats: DeployStats
  log: DeployLogEntry[]
  result?: DeployResult
  error?: string
}

interface DeployCallbacks {
  onLog: (entry: DeployLogEntry) => void
  onStats: (stats: DeployStats) => void
  onStatus: (s: DeployStatus) => void
  isCancelled: () => boolean
}

const BLOB_CONCURRENCY = 6
const MAX_FILE_BYTES = 95 * 1024 * 1024

export class DeployEngine {
  private opts: DeployOptions
  private cb: DeployCallbacks
  private stats: DeployStats = { totalFiles: 0, uploaded: 0, bytes: 0 }

  constructor(opts: DeployOptions, cb: DeployCallbacks) {
    this.opts = opts
    this.cb = cb
  }

  async run(): Promise<DeployResult> {
    this.cb.onStatus('running')
    const client = new GHClient(this.opts.token)

    this.log('info', 'Verifying GitHub access…')
    const user = await client.getUser()
    const owner = user.login
    this.log('info', `Signed in as @${owner}`)

    const target = this.opts.target

    // 1. Resolve / create the destination repo.
    let repoName: string
    let repoUrl: string
    let branch: string
    let pagesPath = '/'
    let subpathPrefix = ''
    if (target.kind === 'new-repo') {
      repoName = target.repoName
      this.log('info', `Creating repo ${owner}/${repoName}…`)
      let repo
      try {
        repo = await client.createRepo(repoName, { private: target.isPrivate })
        this.log('info', `Repo created: ${repo.html_url}`)
      } catch (err) {
        if (err instanceof GitHubError && err.status === 422) {
          this.log('warn', `Repo ${repoName} already exists, reusing it`)
          repo = await client.getRepo(owner, repoName)
        } else {
          throw err
        }
      }
      repoUrl = repo.html_url
      branch = repo.default_branch || 'main'
    } else {
      repoName = target.repo
      this.log('info', `Using existing repo ${target.owner}/${repoName}…`)
      const repo = await client.getRepo(target.owner, repoName)
      repoUrl = repo.html_url
      branch = repo.default_branch
      this.log('info', `Default branch: ${branch}`)
      // Sanitize subpath: strip slashes, refuse traversal.
      const sub = (target.subpath || '').replace(/^\/+|\/+$/g, '')
      if (sub.includes('..')) throw new Error('subpath cannot contain ".."')
      subpathPrefix = sub ? sub + '/' : ''
      if (subpathPrefix) pagesPath = '/'
    }

    // 2. Walk local files.
    this.log('info', `Walking ${this.opts.folder}…`)
    const files = walkFiles(this.opts.folder)
    this.stats.totalFiles = files.length
    this.cb.onStats(this.stats)
    if (files.length === 0) throw new Error('Folder is empty — nothing to deploy')
    this.log(
      'info',
      `Found ${files.length} files, total ${(sumBytes(files) / 1024 / 1024).toFixed(2)} MiB`,
    )

    // 3. Upload blobs in parallel.
    this.log('info', `Uploading blobs (concurrency=${BLOB_CONCURRENCY})…`)
    const blobs: { path: string; sha: string }[] = []
    await runConcurrent(files, BLOB_CONCURRENCY, async (f) => {
      if (this.cb.isCancelled()) throw new Error('Cancelled')
      if (f.size > MAX_FILE_BYTES) {
        this.log(
          'warn',
          `Skipping ${f.relPath}: ${(f.size / 1024 / 1024).toFixed(1)} MiB exceeds GitHub blob limit`,
        )
        return
      }
      const content = await readFile(f.fullPath)
      const blob = await client.createBlob(owner, repoName, content)
      blobs.push({ path: f.relPath, sha: blob.sha })
      this.stats.uploaded++
      this.stats.bytes += f.size
      this.cb.onStats(this.stats)
    })
    if (this.cb.isCancelled()) {
      this.cb.onStatus('cancelled')
      throw new Error('Cancelled')
    }

    // 4. Build the new tree.
    //    - new-repo: only our files (auto_init README is replaced).
    //    - existing-repo: keep all blobs not under subpathPrefix, then add ours
    //      with the prefix. Empty subpath → replaces everything.
    const newEntries: GHTreeEntry[] = blobs.map((b) => ({
      path: subpathPrefix + b.path.split(path.sep).join('/'),
      mode: '100644',
      type: 'blob',
      sha: b.sha,
    }))

    let parentSha: string | null = null
    let preservedEntries: GHTreeEntry[] = []
    if (target.kind === 'existing-repo') {
      try {
        const ref = await client.getRef(owner, repoName, `heads/${branch}`)
        parentSha = ref.object.sha
        const parentCommit = await client.getCommit(owner, repoName, parentSha)
        const existing = await client.getTree(owner, repoName, parentCommit.tree.sha, true)
        if (existing.truncated) {
          this.log(
            'warn',
            'Existing repo has more files than the API can return in one tree — preserving what we got',
          )
        }
        preservedEntries = existing.tree.filter((e) => {
          if (e.type !== 'blob') return false
          if (!subpathPrefix) return false // root-level deploy replaces everything
          return !e.path.startsWith(subpathPrefix)
        })
        this.log(
          'info',
          subpathPrefix
            ? `Preserving ${preservedEntries.length} existing files outside ${subpathPrefix.replace(/\/$/, '')}/`
            : 'Replacing entire repo content',
        )
      } catch (err) {
        if (!(err instanceof GitHubError && err.status === 404)) throw err
        // Empty repo with no default branch yet — proceed with no parent.
      }
    } else {
      // new-repo path: auto_init created an initial commit; we want to set our
      // tree as the new state, fast-forwarding past the README.
      try {
        const ref = await client.getRef(owner, repoName, `heads/${branch}`)
        parentSha = ref.object.sha
      } catch (err) {
        if (!(err instanceof GitHubError && err.status === 404)) throw err
      }
    }

    this.log('info', 'Creating tree…')
    const treeEntries: { path: string; mode: string; type: 'blob'; sha: string }[] = [
      ...preservedEntries.map((e) => ({
        path: e.path,
        mode: e.mode,
        type: 'blob' as const,
        sha: e.sha,
      })),
      ...newEntries.map((e) => ({
        path: e.path,
        mode: e.mode,
        type: 'blob' as const,
        sha: e.sha,
      })),
    ]
    const tree = await client.createTree(owner, repoName, treeEntries)

    // 5. Create commit + move ref.
    this.log('info', 'Creating commit…')
    const commitMessage =
      this.opts.message ||
      (target.kind === 'new-repo'
        ? `siteclone deploy: ${repoName}`
        : `siteclone: update ${subpathPrefix || '/'}`)
    const commit = await client.createCommit(
      owner,
      repoName,
      commitMessage,
      tree.sha,
      parentSha ? [parentSha] : [],
    )

    this.log('info', `Updating ${branch} ref…`)
    await client.updateRef(owner, repoName, `heads/${branch}`, commit.sha, true)

    // 6. Enable Pages (or leave existing config).
    this.log('info', 'Enabling GitHub Pages…')
    let pagesAlreadyEnabled = false
    try {
      await client.enablePages(owner, repoName, branch, '/')
    } catch (err) {
      if (err instanceof GitHubError && err.status === 409) {
        pagesAlreadyEnabled = true
        this.log('info', 'Pages already enabled — leaving existing config alone')
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        this.log('warn', `Pages enable failed (you can enable from Settings → Pages): ${msg}`)
      }
    }

    // For existing-repo deploys, warn if the existing Pages source isn't the
    // branch we just pushed to — the URL may not reflect our commit.
    if (target.kind === 'existing-repo' && pagesAlreadyEnabled) {
      try {
        const pages = await client.getPages(owner, repoName)
        if (pages.source && pages.source.branch && pages.source.branch !== branch) {
          this.log(
            'warn',
            `Pages publishes from ${pages.source.branch} but we pushed to ${branch} — your live URL may not show this deploy until you change the Pages source.`,
          )
        }
      } catch {
        // ignore — non-fatal
      }
    }

    const pagesUrl =
      target.kind === 'new-repo'
        ? `https://${owner}.github.io/${repoName}/`
        : `https://${owner}.github.io/${repoName}/${subpathPrefix}`
    this.log('info', `Deploy complete (Pages can take ~30s to go live).`)
    this.log('info', pagesUrl)
    void pagesPath // pagesPath kept for future per-subpath Pages config
    this.cb.onStatus('done')
    return { pagesUrl, repoUrl }
  }

  private log(level: DeployLogEntry['level'], msg: string) {
    this.cb.onLog({ ts: Date.now(), level, msg })
  }
}

interface FileEntry {
  fullPath: string
  relPath: string
  size: number
}

function walkFiles(root: string): FileEntry[] {
  const out: FileEntry[] = []
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === '.DS_Store' || name === '.git') continue
      const full = path.join(dir, name)
      let s
      try {
        s = statSync(full)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        stack.push(full)
      } else if (s.isFile()) {
        out.push({ fullPath: full, relPath: path.relative(root, full), size: s.size })
      }
    }
  }
  return out
}

function sumBytes(files: FileEntry[]): number {
  return files.reduce((a, f) => a + f.size, 0)
}

async function runConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0
  const workers: Promise<void>[] = []
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    workers.push(
      (async () => {
        while (i < items.length) {
          const idx = i++
          await fn(items[idx])
        }
      })(),
    )
  }
  await Promise.all(workers)
}

export function sanitizeRepoName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
}

export function sanitizeSubpath(input: string): string {
  return input
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
