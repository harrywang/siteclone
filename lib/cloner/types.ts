export type CloneMode = 'static' | 'dynamic'

export interface CloneOptions {
  url: string
  outputDir: string
  depth: number
  concurrency: number
  mode: CloneMode
  includeAssets: boolean
  rewriteRoot: boolean
  /**
   * Maximum file size in bytes; assets larger than this are skipped with a warning.
   * Default 10 MiB covers all typical web assets (images, fonts, CSS, JS bundles)
   * while skipping hero videos and other outliers. Bump up to 100 MiB (GitHub's
   * per-blob hard cap) if you want media too. Set 0 to disable.
   */
  maxFileSizeBytes: number
  userAgent?: string
  timeoutMs?: number
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

export interface JobLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  msg: string
}

export interface JobStats {
  pagesCrawled: number
  assetsCrawled: number
  bytesWritten: number
  errors: number
  failedUrls: string[]
}

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface JobState {
  id: string
  options: CloneOptions
  status: JobStatus
  startedAt: number
  endedAt?: number
  stats: JobStats
  log: JobLogEntry[]
  error?: string
}
