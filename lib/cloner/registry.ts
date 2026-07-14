import { CloneEngine } from './engine'
import type { CloneOptions, JobLogEntry, JobState, JobStatus } from './types'

const MAX_LOG_ENTRIES = 2000

class JobRegistry {
  private jobs = new Map<string, JobState>()
  private cancelFlags = new Map<string, boolean>()
  private listeners = new Map<string, Set<(state: JobState) => void>>()

  list(): JobState[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)
  }

  cancel(id: string): boolean {
    if (!this.jobs.has(id)) return false
    this.cancelFlags.set(id, true)
    return true
  }

  subscribe(id: string, fn: (state: JobState) => void): () => void {
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(fn)
    return () => {
      set?.delete(fn)
    }
  }

  async start(options: CloneOptions): Promise<string> {
    const id = makeJobId()
    const state: JobState = {
      id,
      options,
      status: 'pending',
      startedAt: Date.now(),
      stats: { pagesCrawled: 0, assetsCrawled: 0, bytesWritten: 0, errors: 0, failedUrls: [] },
      log: [],
    }
    this.jobs.set(id, state)
    this.cancelFlags.set(id, false)

    // Run async — don't await
    this.runJob(state).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      state.status = 'error'
      state.error = msg
      state.endedAt = Date.now()
      this.appendLog(state, { ts: Date.now(), level: 'error', msg })
      this.notify(state)
    })

    return id
  }

  private async runJob(state: JobState) {
    const engine = new CloneEngine(state.options, {
      onLog: (entry) => {
        this.appendLog(state, entry)
        this.notify(state)
      },
      onStats: (stats) => {
        state.stats = stats
        this.notify(state)
      },
      onStatus: (s: JobStatus) => {
        state.status = s
        if (s === 'done' || s === 'error' || s === 'cancelled') {
          state.endedAt = Date.now()
        }
        this.notify(state)
      },
      isCancelled: () => this.cancelFlags.get(state.id) === true,
    })
    await engine.run()
  }

  private appendLog(state: JobState, entry: JobLogEntry) {
    state.log.push(entry)
    if (state.log.length > MAX_LOG_ENTRIES) {
      state.log.splice(0, state.log.length - MAX_LOG_ENTRIES)
    }
  }

  private notify(state: JobState) {
    const set = this.listeners.get(state.id)
    if (!set) return
    for (const fn of set) {
      try {
        fn(state)
      } catch {
        // listener errors don't break the run
      }
    }
  }
}

// Singleton across hot-reloads (Next dev) and within the single utility-process server.
const KEY = Symbol.for('siteclone.registry')
type GlobalWithRegistry = typeof globalThis & { [KEY]?: JobRegistry }
const g = globalThis as GlobalWithRegistry
if (!g[KEY]) g[KEY] = new JobRegistry()
export const registry: JobRegistry = g[KEY]!

function makeJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
