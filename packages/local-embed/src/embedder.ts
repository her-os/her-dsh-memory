/**
 * An {@link Embedder} that runs a small ONNX model on this machine. The first
 * use downloads the runtime and the model in the background; until they are
 * ready, calls fail with {@link EmbedderNotReadyError} so recall falls back to
 * keywords, and `onReady` tells the host to start backfill.
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { type EmbedPurpose, type Embedder, EmbedderNotReadyError } from '@her-os/memory-core'
import { Tokenizer } from '@huggingface/tokenizers'
import { type DownloadSource, downloadFile, modelUrls, tryLock } from './download.ts'
import { type LocalModel, modelBytes } from './models.ts'
import { ensureRuntime, loadRuntime, type OrtModule, type OrtSession, type OrtTensor, RUNTIME_DOWNLOAD_BYTES, runtimeDir, runtimeReady, runtimeSupported } from './runtime.ts'

/** Where the local model is in its life. */
export type LocalState =
  /** Files may be present; nothing loaded. */
  | 'idle'
  /** This process is downloading. */
  | 'downloading'
  /** Another process holds the download lock. */
  | 'waiting'
  | 'loading'
  | 'ready'
  /** The last download or load failed; see `error`. */
  | 'error'
  /** No runtime binaries for this platform. */
  | 'unsupported'

/** Snapshot for status pages. */
export interface LocalStatus {
  readonly model: string
  readonly state: LocalState
  /** Bytes present of everything to download. */
  readonly received: number
  /** Bytes to download in total (runtime and model). */
  readonly total: number
  /** Whether the runtime and model files are complete on disk. */
  readonly downloaded: boolean
  readonly error: string | null
}

/** Text tokenizer, as far as this module uses it. */
export interface TextTokenizer {
  encode(text: string): { ids: number[] }
}

/** Options of {@link LocalEmbedder}. */
export interface LocalEmbedderOptions {
  readonly model: LocalModel
  /** Cache root shared by every model: `models/<id>/` and `runtime/` live here. */
  readonly root: string
  readonly source: DownloadSource
  readonly logger?: { info(format: string, ...args: unknown[]): void; warn(format: string, ...args: unknown[]): void }
  /** Called each time the model finishes loading. */
  readonly onReady?: () => void
  /** Unload after this long without use; 0 keeps the model loaded. */
  readonly idleUnloadMs?: number
  /** Inference threads; defaults to half the cores, at most 4. */
  readonly threads?: number
  /** Test seams. */
  readonly runtime?: (root: string, options: { source: DownloadSource; signal: AbortSignal; onBytes: (bytes: number) => void }) => Promise<OrtModule>
  readonly tokenizer?: (dir: string) => TextTokenizer
  readonly fetchImpl?: typeof fetch
  readonly platform?: string
  readonly arch?: string
}

/** Poll interval while another process downloads. */
const WAIT_POLL_MS = 5000
/** A failed preparation is retried by the next call after this long. */
const RETRY_AFTER_MS = 60_000
const MARKER = '.complete'

/**
 * Directory of one model's files.
 * @param root - cache root.
 * @param id - model id.
 * @returns the directory.
 */
export const modelDir = (root: string, id: string): string => join(root, 'models', id)

/**
 * Whether a model's files are complete on disk.
 * @param root - cache root.
 * @param id - model id.
 * @returns `true` when downloaded.
 */
export const modelDownloaded = (root: string, id: string): boolean => existsSync(join(modelDir(root, id), MARKER))

/**
 * Remove a model's files.
 * @param root - cache root.
 * @param id - model id.
 */
export const deleteModel = (root: string, id: string): void => { rmSync(modelDir(root, id), { recursive: true, force: true }) }

const bytesOnDisk = (path: string): number => {
  for (const candidate of [path, `${path}.part`]) {
    try { return statSync(candidate).size } catch { /* absent */ }
  }
  return 0
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Turn model output into one unit vector per input.
 * @param outputs - session outputs.
 * @param mask - attention mask, row-major `[batch, length]`.
 * @param batch - number of inputs.
 * @param length - padded length.
 * @param pooling - fallback pooling when no pooled output exists.
 * @returns the vectors.
 */
export function poolOutputs(outputs: Record<string, OrtTensor>, mask: BigInt64Array, batch: number, length: number, pooling: 'cls' | 'mean'): Float32Array[] {
  const pooled = outputs.sentence_embedding
  const vectors: Float32Array[] = []
  if (pooled !== undefined) {
    const data = pooled.data as Float32Array
    const dims = pooled.dims[1]!
    for (let row = 0; row < batch; row++) vectors.push(data.slice(row * dims, (row + 1) * dims))
  } else {
    const hidden = outputs.last_hidden_state ?? Object.values(outputs)[0]
    if (hidden === undefined) throw new Error('model returned no output')
    const data = hidden.data as Float32Array
    const dims = hidden.dims[2]!
    for (let row = 0; row < batch; row++) {
      const vector = new Float32Array(dims)
      if (pooling === 'cls') {
        vector.set(data.subarray(row * length * dims, row * length * dims + dims))
      } else {
        let count = 0
        for (let token = 0; token < length; token++) {
          if (mask[row * length + token] === 0n) continue
          count++
          const offset = (row * length + token) * dims
          for (let d = 0; d < dims; d++) vector[d]! += data[offset + d]!
        }
        if (count > 0) for (let d = 0; d < dims; d++) vector[d]! /= count
      }
      vectors.push(vector)
    }
  }
  for (const vector of vectors) {
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm > 0) for (let d = 0; d < vector.length; d++) vector[d]! /= norm
  }
  return vectors
}

/**
 * Cut token ids to a length, keeping the final special token.
 * @param ids - token ids with special tokens.
 * @param max - longest length.
 * @returns the ids, at most `max` long.
 */
export const truncateIds = (ids: readonly number[], max: number): number[] =>
  ids.length <= max ? [...ids] : [...ids.slice(0, max - 1), ids.at(-1)!]

const defaultTokenizer = (dir: string): TextTokenizer => new Tokenizer(
  JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')) as object,
  JSON.parse(readFileSync(join(dir, 'tokenizer_config.json'), 'utf8')) as object,
)

/** The on-device embedder. */
export class LocalEmbedder implements Embedder {
  readonly model: LocalModel
  private readonly options: LocalEmbedderOptions
  private state: LocalState = 'idle'
  private received = 0
  private total = 0
  private error: string | null = null
  private failedAt = 0
  private preparing: Promise<void> | undefined
  private loaded: { ort: OrtModule; session: OrtSession; tokenizer: TextTokenizer } | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | undefined
  private readonly abort = new AbortController()
  private disposed = false

  /**
   * @param options - model, cache root, mirror preference, callbacks.
   */
  constructor(options: LocalEmbedderOptions) {
    this.options = options
    this.model = options.model
    if (!runtimeSupported(options.platform, options.arch)) this.state = 'unsupported'
  }

  fingerprint(): string { return `local|${this.model.id}|${this.model.dims}` }

  /** Whether runtime and model files are on disk. */
  get downloaded(): boolean {
    return runtimeReady(this.options.root) && modelDownloaded(this.options.root, this.model.id)
  }

  /**
   * Current state and download progress.
   * @returns the snapshot.
   */
  status(): LocalStatus {
    const downloaded = this.state !== 'unsupported' && this.downloaded
    const total = this.total > 0 ? this.total : modelBytes(this.model) + (runtimeReady(this.options.root) ? 0 : RUNTIME_DOWNLOAD_BYTES)
    return { model: this.model.id, state: this.state, received: downloaded ? total : this.received, total, downloaded, error: this.error }
  }

  /**
   * Download what is missing and load the model. Concurrent calls share one run.
   * @returns when ready, or when the attempt failed (see {@link status}).
   */
  prepare(): Promise<void> {
    if (this.state === 'unsupported' || this.disposed) return Promise.resolve()
    if (this.loaded !== undefined) return Promise.resolve()
    this.preparing ??= this.runPrepare().finally(() => { this.preparing = undefined })
    return this.preparing
  }

  private async runPrepare(): Promise<void> {
    const signal = this.abort.signal
    try {
      while (!this.downloaded) {
        const lock = tryLock(join(this.options.root, '.download.lock'))
        if (lock === undefined) {
          this.state = 'waiting'
          await sleep(WAIT_POLL_MS, signal)
          if (signal.aborted) return
          continue
        }
        try {
          await this.download(signal)
        } finally {
          lock.release()
        }
      }
      if (signal.aborted) return
      this.state = 'loading'
      await this.load()
      this.error = null
      this.state = 'ready'
      this.options.logger?.info('local embedding model %s ready', this.model.id)
      this.touch()
      this.options.onReady?.()
    } catch (error) {
      if (signal.aborted) return
      this.error = errorText(error)
      this.failedAt = Date.now()
      this.state = 'error'
      this.options.logger?.warn('local embedding model %s unavailable: %s', this.model.id, this.error)
    }
  }

  private async download(signal: AbortSignal): Promise<void> {
    this.state = 'downloading'
    const root = this.options.root
    const dir = modelDir(root, this.model.id)
    const runtimeMissing = !runtimeReady(root)
    this.total = modelBytes(this.model) + (runtimeMissing ? RUNTIME_DOWNLOAD_BYTES : 0)
    this.received = this.model.files.reduce((sum, file) => sum + bytesOnDisk(join(dir, file.path)), 0)
    const onBytes = (bytes: number): void => { this.received += bytes }
    if (runtimeMissing) {
      await ensureRuntime(root, { source: this.options.source, signal, onBytes, ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }) })
    }
    for (const file of this.model.files) {
      await downloadFile(modelUrls(this.model.repo, file.path, this.options.source), join(dir, file.path), {
        size: file.size,
        ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
        signal,
        onBytes,
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      })
    }
    writeFileSync(join(dir, MARKER), JSON.stringify({ model: this.model.id, files: this.model.files.map(file => file.path) }))
  }

  private async load(): Promise<void> {
    const root = this.options.root
    const ort = this.options.runtime === undefined
      ? loadRuntime(runtimeDir(root))
      : await this.options.runtime(root, { source: this.options.source, signal: this.abort.signal, onBytes: () => {} })
    const dir = modelDir(root, this.model.id)
    const tokenizer = (this.options.tokenizer ?? defaultTokenizer)(dir)
    const threads = this.options.threads ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
    const session = await ort.InferenceSession.create(join(dir, this.model.onnx), {
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    })
    if (this.disposed) { await session.release(); return }
    this.loaded = { ort, session, tokenizer }
  }

  /**
   * Embed texts on this machine.
   * @param texts - inputs.
   * @param signal - stops waiting; a running inference still completes.
   * @param purpose - query or stored memory; selects the model's prefix.
   * @returns unit vectors.
   * @throws {EmbedderNotReadyError} while the model is not downloaded yet.
   */
  async embed(texts: readonly string[], signal?: AbortSignal, purpose: EmbedPurpose = 'document'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (this.state === 'unsupported') throw new Error(`本地模型不支持 ${this.options.platform ?? process.platform}-${this.options.arch ?? process.arch}`)
    if (this.loaded === undefined) {
      if (!this.downloaded || this.state === 'error') {
        if (this.state !== 'error' || Date.now() - this.failedAt > RETRY_AFTER_MS) void this.prepare()
        throw new EmbedderNotReadyError(this.state === 'error' ? `local model failed: ${this.error ?? ''}` : 'local model is downloading')
      }
      await abortable(this.prepare(), signal)
      if (this.loaded === undefined) throw new EmbedderNotReadyError(`local model is not loaded: ${this.error ?? this.state}`)
    }
    const run = this.queue.then(() => {
      signal?.throwIfAborted()
      return this.infer(texts, purpose)
    })
    this.queue = run.catch(() => {})
    return abortable(run, signal)
  }

  private async infer(texts: readonly string[], purpose: EmbedPurpose): Promise<Float32Array[]> {
    const loaded = this.loaded
    if (loaded === undefined) throw new EmbedderNotReadyError('local model was unloaded')
    const prefix = purpose === 'query' ? this.model.queryPrefix : this.model.documentPrefix
    const encoded = texts.map(text => truncateIds(loaded.tokenizer.encode(prefix + text).ids, this.model.maxTokens))
    const batch = encoded.length
    const length = Math.max(1, ...encoded.map(ids => ids.length))
    const ids = new BigInt64Array(batch * length)
    const mask = new BigInt64Array(batch * length)
    encoded.forEach((row, i) => row.forEach((id, j) => { ids[i * length + j] = BigInt(id); mask[i * length + j] = 1n }))
    const dims = [batch, length]
    const feeds: Record<string, OrtTensor> = {
      input_ids: new loaded.ort.Tensor('int64', ids, dims),
      attention_mask: new loaded.ort.Tensor('int64', mask, dims),
    }
    if (loaded.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new loaded.ort.Tensor('int64', new BigInt64Array(batch * length), dims)
    try {
      return poolOutputs(await loaded.session.run(feeds), mask, batch, length, this.model.pooling)
    } finally {
      this.touch()
    }
  }

  private touch(): void {
    const ms = this.options.idleUnloadMs ?? 0
    if (ms <= 0) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.unload() }, ms)
    this.idleTimer.unref()
  }

  /** Release the loaded model; the next call loads it again. */
  async unload(): Promise<void> {
    clearTimeout(this.idleTimer)
    const loaded = this.loaded
    if (loaded === undefined) return
    this.loaded = undefined
    if (this.state === 'ready') this.state = 'idle'
    await this.queue
    await loaded.session.release()
  }

  /** Stop downloads and release the model. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.abort.abort()
    await this.unload()
  }
}

const abortable = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}
