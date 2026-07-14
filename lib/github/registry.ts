import { DeployEngine, type DeployOptions, type DeployState, type DeployLogEntry } from './deploy'

const MAX_LOG = 1000

class DeployRegistry {
  private jobs = new Map<string, DeployState>()
  private cancelFlags = new Map<string, boolean>()

  list(): DeployState[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): DeployState | undefined {
    return this.jobs.get(id)
  }

  cancel(id: string): boolean {
    if (!this.jobs.has(id)) return false
    this.cancelFlags.set(id, true)
    return true
  }

  async start(opts: DeployOptions): Promise<string> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // Strip token from the public state — never returned to UI.
    const { token: _token, ...optsForState } = opts
    void _token
    const state: DeployState = {
      id,
      options: optsForState,
      status: 'pending',
      startedAt: Date.now(),
      stats: { totalFiles: 0, uploaded: 0, bytes: 0 },
      log: [],
    }
    this.jobs.set(id, state)
    this.cancelFlags.set(id, false)

    void this.run(state, opts).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      state.status = 'error'
      state.error = msg
      state.endedAt = Date.now()
      this.appendLog(state, { ts: Date.now(), level: 'error', msg })
    })

    return id
  }

  private async run(state: DeployState, opts: DeployOptions) {
    const engine = new DeployEngine(opts, {
      onLog: (e) => this.appendLog(state, e),
      onStats: (s) => {
        state.stats = s
      },
      onStatus: (s) => {
        state.status = s
        if (s === 'done' || s === 'error' || s === 'cancelled') {
          state.endedAt = Date.now()
        }
      },
      isCancelled: () => this.cancelFlags.get(state.id) === true,
    })
    try {
      const result = await engine.run()
      state.result = result
      state.status = 'done'
      state.endedAt = Date.now()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'Cancelled') {
        state.status = 'cancelled'
      } else {
        state.status = 'error'
        state.error = msg
        this.appendLog(state, { ts: Date.now(), level: 'error', msg })
      }
      state.endedAt = Date.now()
    }
  }

  private appendLog(state: DeployState, entry: DeployLogEntry) {
    state.log.push(entry)
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG)
  }
}

const KEY = Symbol.for('siteclone.deploy-registry')
type GlobalWithRegistry = typeof globalThis & { [KEY]?: DeployRegistry }
const g = globalThis as GlobalWithRegistry
if (!g[KEY]) g[KEY] = new DeployRegistry()
export const deployRegistry: DeployRegistry = g[KEY]!
