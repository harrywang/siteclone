import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface StoredAuth {
  token: string
  login: string | null
  scopes?: string[] | null
  savedAt: number
}

/**
 * GitHub PAT lives under SITECLONE_USER_DATA (set by the Electron wrapper) or
 * ~/.siteclone in dev / CLI use. File is mode 0600.
 */
function authPath(): string {
  const root = process.env.SITECLONE_USER_DATA || path.join(os.homedir(), '.siteclone')
  return path.join(root, 'github-auth.json')
}

export function readAuth(): StoredAuth | null {
  const p = authPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as StoredAuth
  } catch {
    return null
  }
}

export function writeAuth(auth: StoredAuth): void {
  const p = authPath()
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(auth, null, 2), { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    // Windows doesn't honor POSIX modes — best-effort.
  }
}

export function clearAuth(): void {
  const p = authPath()
  if (existsSync(p)) {
    try {
      unlinkSync(p)
    } catch {
      // ignore
    }
  }
}
