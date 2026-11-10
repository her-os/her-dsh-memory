/**
 * Resumable file downloads with mirror fallback and content checks, plus a
 * cross-process lock so two DSH processes do not fetch the same files.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, renameSync, rmSync, statSync, utimesSync, writeSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Where model and runtime files come from. */
export type DownloadSource = 'auto' | 'huggingface' | 'modelscope'

/** Wait for response headers before trying the next mirror. */
const CONNECT_TIMEOUT_MS = 15_000
/** Give up on a connection that delivers nothing for this long. */
const STALL_TIMEOUT_MS = 60_000

/** A download that failed on every mirror. */
export class DownloadError extends Error {
  /**
   * @param message - every mirror's failure, joined.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

/** Options of {@link downloadFile}. */
export interface DownloadOptions {
  /** Expected size; a finished file of this size is not fetched again. */
  readonly size?: number
  /** Expected SHA-256 (hex). */
  readonly sha256?: string
  /** Expected npm `integrity` (`sha512-<base64>`). */
  readonly integrity?: string
  readonly signal?: AbortSignal
  /** Called with the number of new bytes written. */
  readonly onBytes?: (bytes: number) => void
  readonly fetchImpl?: typeof fetch
}

const message = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  return cause === undefined ? error.message : `${error.message} (${cause.code ?? cause.message ?? ''})`
}

const digest = (path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash(algorithm)
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => { resolve(hash.digest(encoding)) })
})

async function verify(path: string, options: DownloadOptions): Promise<string | undefined> {
  if (options.size !== undefined && statSync(path).size !== options.size) return `size ${statSync(path).size} instead of ${options.size}`
  if (options.sha256 !== undefined && await digest(path, 'sha256', 'hex') !== options.sha256) return 'SHA-256 mismatch'
  if (options.integrity !== undefined) {
    const [algorithm, expected] = options.integrity.split('-', 2) as [string, string]
    if (algorithm !== 'sha512' || await digest(path, 'sha512', 'base64') !== expected) return 'integrity mismatch'
  }
  return undefined
}

/**
 * Fetch one URL into `part`, resuming from the bytes already there.
 * @returns when the body is complete.
 */
async function fetchInto(url: string, part: string, options: DownloadOptions): Promise<void> {
  const have = existsSync(part) ? statSync(part).size : 0
  if (options.size !== undefined && have === options.size) return
  const controller = new AbortController()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
  let timer = setTimeout(() => { controller.abort(new Error(`no response in ${CONNECT_TIMEOUT_MS} ms`)) }, CONNECT_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { signal, redirect: 'follow', headers: have > 0 ? { range: `bytes=${have}-` } : {} })
    if (response.status === 416 && have > 0) { rmSync(part, { force: true }); throw new Error('stale partial file') }
    if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
    const append = response.status === 206
    const fd = openSync(part, append ? 'a' : 'w')
    if (!append && have > 0) options.onBytes?.(-have)
    try {
      const restart = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => { controller.abort(new Error(`stalled for ${STALL_TIMEOUT_MS} ms`)) }, STALL_TIMEOUT_MS)
      }
      restart()
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        writeSync(fd, chunk)
        options.onBytes?.(chunk.byteLength)
        restart()
      }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason
    throw controller.signal.aborted ? controller.signal.reason : error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download to `dest`, trying each URL in turn and resuming partial files.
 * A finished file that passes the checks is kept as is.
 * @param urls - mirrors, preferred first.
 * @param dest - final path; `dest.part` holds the partial content.
 * @param options - expected size and hash, cancellation, progress.
 * @throws {DownloadError} when every mirror fails or the content does not match.
 */
export async function downloadFile(urls: readonly string[], dest: string, options: DownloadOptions = {}): Promise<void> {
  if (existsSync(dest) && (options.size === undefined || statSync(dest).size === options.size)) return
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const failures: string[] = []
  for (const url of urls) {
    try {
      await fetchInto(url, part, options)
      const problem = await verify(part, options)
      if (problem !== undefined) {
        options.onBytes?.(-statSync(part).size)
        rmSync(part, { force: true })
        throw new Error(problem)
      }
      renameSync(part, dest)
      return
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      failures.push(`${new URL(url).host}: ${message(error)}`)
    }
  }
  throw new DownloadError(`download of ${dest.split(/[\\/]/u).at(-1)} failed: ${failures.join('; ')}`)
}

/** How long a lock lives without being refreshed. */
const LOCK_STALE_MS = 120_000
const LOCK_REFRESH_MS = 30_000

/** A held cross-process lock. */
export interface Lock {
  release(): void
}

/**
 * Take a lock file, or report that another live process holds it.
 * A lock its holder stopped refreshing for {@link LOCK_STALE_MS} is taken over.
 * @param path - lock file path.
 * @returns the lock, or `undefined` while someone else holds it.
 */
export function tryLock(path: string): Lock | undefined {
  mkdirSync(dirname(path), { recursive: true })
  const take = (): boolean => {
    try {
      closeSync(openSync(path, 'wx'))
      writeFileSync(path, String(process.pid))
      return true
    } catch {
      return false
    }
  }
  if (!take()) {
    let age = 0
    try { age = Date.now() - statSync(path).mtimeMs } catch { /* released meanwhile */ }
    if (age < LOCK_STALE_MS) return undefined
    rmSync(path, { force: true })
    if (!take()) return undefined
  }
  const refresh = setInterval(() => {
    const now = new Date()
    try { utimesSync(path, now, now) } catch { /* removed by a takeover */ }
  }, LOCK_REFRESH_MS)
  refresh.unref()
  return {
    release() {
      clearInterval(refresh)
      rmSync(path, { force: true })
    },
  }
}

/**
 * Mirrors of a Hugging Face model file, preferred first.
 * @param repo - repository, e.g. `Xenova/bge-m3`.
 * @param file - path inside the repository.
 * @param source - user preference.
 * @returns URLs.
 */
export function modelUrls(repo: string, file: string, source: DownloadSource): string[] {
  const hf = `https://huggingface.co/${repo}/resolve/main/${file}`
  const ms = `https://www.modelscope.cn/models/${repo}/resolve/master/${file}`
  if (source === 'huggingface') return [hf]
  if (source === 'modelscope') return [ms]
  return [hf, ms]
}

/**
 * Mirrors of an npm package tarball, preferred first.
 * @param name - unscoped package name.
 * @param version - exact version.
 * @param source - user preference; `modelscope` selects the China npm mirror.
 * @returns URLs.
 */
export function npmUrls(name: string, version: string, source: DownloadSource): string[] {
  const npm = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
  const cn = `https://registry.npmmirror.com/${name}/-/${name}-${version}.tgz`
  if (source === 'huggingface') return [npm]
  if (source === 'modelscope') return [cn]
  return [npm, cn]
}
