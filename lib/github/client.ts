/**
 * Minimal GitHub REST client used for Pages deploys.
 *
 * Docs:
 *   - Repos:   https://docs.github.com/en/rest/repos
 *   - Git DB:  https://docs.github.com/en/rest/git
 *   - Pages:   https://docs.github.com/en/rest/pages
 *
 * Only authenticated calls are supported; we always send a Bearer token.
 */

const API = 'https://api.github.com'

export class GitHubError extends Error {
  status: number
  body: string
  constructor(method: string, path: string, status: number, body: string) {
    super(`GitHub ${method} ${path} → ${status}: ${body.slice(0, 300)}`)
    this.name = 'GitHubError'
    this.status = status
    this.body = body
  }
}

export interface GHUser {
  login: string
  name: string | null
  html_url: string
  avatar_url: string
}

export interface GHRepo {
  name: string
  full_name: string
  default_branch: string
  html_url: string
  private: boolean
  owner: { login: string }
}

export interface GHPages {
  html_url: string
  status: string | null
  source: { branch: string; path: string }
}

export interface GHTreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
  url?: string
}

export interface GHTree {
  sha: string
  url: string
  tree: GHTreeEntry[]
  truncated: boolean
}

export class GHClient {
  constructor(private token: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SiteClone/0.1',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new GitHubError(method, path, res.status, text)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  // ─── Users / repos ─────────────────────────────────────────────

  getUser(): Promise<GHUser> {
    return this.req<GHUser>('GET', '/user')
  }

  getRepo(owner: string, repo: string): Promise<GHRepo> {
    return this.req<GHRepo>('GET', `/repos/${owner}/${repo}`)
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Promise<GHRepo> {
    return this.req<GHRepo>('POST', '/user/repos', {
      name,
      private: opts.private ?? false,
      auto_init: true,
      description: opts.description ?? 'Static mirror created by SiteClone',
    })
  }

  listRepos(opts: { perPage?: number; affiliation?: string } = {}): Promise<GHRepo[]> {
    const perPage = Math.min(100, opts.perPage ?? 100)
    const affiliation = opts.affiliation ?? 'owner,collaborator'
    return this.req<GHRepo[]>(
      'GET',
      `/user/repos?per_page=${perPage}&affiliation=${encodeURIComponent(affiliation)}&sort=updated`,
    )
  }

  getCommit(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{ sha: string; tree: { sha: string; url: string }; message: string }> {
    return this.req('GET', `/repos/${owner}/${repo}/git/commits/${sha}`)
  }

  getTree(
    owner: string,
    repo: string,
    sha: string,
    recursive = false,
  ): Promise<GHTree> {
    const q = recursive ? '?recursive=1' : ''
    return this.req<GHTree>('GET', `/repos/${owner}/${repo}/git/trees/${sha}${q}`)
  }

  // ─── Git database (for fast bulk uploads) ──────────────────────

  createBlob(
    owner: string,
    repo: string,
    content: Buffer,
  ): Promise<{ sha: string }> {
    return this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    })
  }

  createTree(
    owner: string,
    repo: string,
    tree: { path: string; mode: string; type: 'blob'; sha: string }[],
    baseTree?: string,
  ): Promise<{ sha: string }> {
    return this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, {
      tree,
      ...(baseTree ? { base_tree: baseTree } : {}),
    })
  }

  getRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ object: { sha: string } }> {
    return this.req<{ object: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/ref/${ref}`,
    )
  }

  createCommit(
    owner: string,
    repo: string,
    message: string,
    tree: string,
    parents: string[],
  ): Promise<{ sha: string }> {
    return this.req<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree,
      parents,
    })
  }

  updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    force = true,
  ): Promise<unknown> {
    return this.req('PATCH', `/repos/${owner}/${repo}/git/refs/${ref}`, { sha, force })
  }

  // ─── Pages ─────────────────────────────────────────────────────

  enablePages(
    owner: string,
    repo: string,
    branch: string,
    pathRoot: string = '/',
  ): Promise<GHPages> {
    return this.req<GHPages>('POST', `/repos/${owner}/${repo}/pages`, {
      source: { branch, path: pathRoot },
    })
  }

  updatePagesSource(
    owner: string,
    repo: string,
    branch: string,
    pathRoot: string = '/',
  ): Promise<unknown> {
    // PUT updates an existing Pages site (no body returned on success).
    return this.req('PUT', `/repos/${owner}/${repo}/pages`, {
      source: { branch, path: pathRoot },
    })
  }

  getPages(owner: string, repo: string): Promise<GHPages> {
    return this.req<GHPages>('GET', `/repos/${owner}/${repo}/pages`)
  }
}
