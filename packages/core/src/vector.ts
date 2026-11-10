/**
 * In-memory vector index: L2-normalized vectors quantized to int8 in one
 * contiguous buffer, scanned by brute-force dot product. 50k × 1024 dims takes
 * about 50 MB. Rows are appended; removal swaps in the last row.
 */

/**
 * Normalize to unit length.
 * @param vector - any non-zero vector.
 * @returns a new unit vector; a zero vector is returned unchanged.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!
  const norm = Math.sqrt(sum)
  const out = new Float32Array(vector.length)
  if (norm === 0) return out
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm
  return out
}

/**
 * Cosine similarity of two float vectors of equal length.
 * @param a - first vector.
 * @param b - second vector.
 * @returns the similarity in [-1, 1]; 0 when either is zero.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/**
 * Encode a float vector as a little-endian Float32 BLOB.
 * @param vector - the vector.
 * @returns the bytes.
 */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

/**
 * Decode a Float32 BLOB.
 * @param blob - bytes written by {@link vectorToBlob}.
 * @returns the vector.
 */
export function blobToVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

/** One scored hit. */
export interface VectorHit {
  readonly id: number
  readonly score: number
}

/** Quantized brute-force index keyed by memory id. */
export class VectorIndex {
  private ids = new Int32Array(new SharedArrayBuffer(0))
  private data = new Int8Array(new SharedArrayBuffer(0))
  private scales = new Float32Array(new SharedArrayBuffer(0))
  private readonly rowOf = new Map<number, number>()
  private count = 0

  readonly dim: number

  /**
   * @param dim - vector dimension every row must have.
   */
  constructor(dim: number) {
    this.dim = dim
  }

  /** Number of rows. */
  get size(): number {
    return this.count
  }

  /**
   * Whether an id has a row.
   * @param id - memory id.
   * @returns membership.
   */
  has(id: number): boolean {
    return this.rowOf.has(id)
  }

  /**
   * Insert or replace a row.
   * @param id - memory id.
   * @param vector - a vector of length {@link dim}.
   */
  upsert(id: number, vector: Float32Array): void {
    if (vector.length !== this.dim) throw new RangeError(`vector has ${vector.length} dims, index has ${this.dim}`)
    let row = this.rowOf.get(id)
    if (row === undefined) {
      this.grow(this.count + 1)
      row = this.count++
      this.rowOf.set(id, row)
      this.ids[row] = id
    }
    const unit = normalize(vector)
    let max = 0
    for (let i = 0; i < unit.length; i++) max = Math.max(max, Math.abs(unit[i]!))
    const scale = max === 0 ? 1 : 127 / max
    const offset = row * this.dim
    for (let i = 0; i < unit.length; i++) this.data[offset + i] = Math.round(unit[i]! * scale)
    this.scales[row] = scale
  }

  /**
   * Remove a row if present.
   * @param id - memory id.
   */
  remove(id: number): void {
    const row = this.rowOf.get(id)
    if (row === undefined) return
    const last = this.count - 1
    if (row !== last) {
      const lastId = this.ids[last]!
      this.data.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim)
      this.scales[row] = this.scales[last]!
      this.ids[row] = lastId
      this.rowOf.set(lastId, row)
    }
    this.rowOf.delete(id)
    this.count = last
  }

  /**
   * Cosine similarity of the query with one row.
   * @param id - memory id.
   * @param query - query vector.
   * @returns the similarity, or `undefined` when the id has no row.
   */
  similarity(id: number, query: Float32Array): number | undefined {
    const row = this.rowOf.get(id)
    if (row === undefined) return undefined
    return this.dot(row, normalize(query))
  }

  /**
   * The `k` rows most similar to the query.
   * @param query - query vector of length {@link dim}.
   * @param k - result count.
   * @param accept - optional row filter by id.
   * @returns hits sorted by descending cosine similarity.
   */
  search(query: Float32Array, k: number, accept?: (id: number) => boolean): VectorHit[] {
    if (query.length !== this.dim || k <= 0) return []
    const { q, queryScale } = quantizeQuery(query)
    return scanTop(this.data, this.scales, this.ids, this.dim, 0, this.count, q, queryScale, k, accept)
  }

  /**
   * {@link search} off the main thread once the index holds
   * {@link WORKER_MIN_ROWS} rows, so a long scan never stalls the event loop.
   * Rows written during the scan may be seen old or new.
   * @param query - query vector of length {@link dim}.
   * @param k - result count.
   * @returns hits sorted by descending cosine similarity.
   */
  async searchAsync(query: Float32Array, k: number): Promise<VectorHit[]> {
    if (this.count < WORKER_MIN_ROWS || query.length !== this.dim || k <= 0) return this.search(query, k)
    const { q, queryScale } = quantizeQuery(query)
    const worker = scanWorker()
    if (worker === undefined) return this.search(query, k)
    return worker.scan({ data: this.data, scales: this.scales, ids: this.ids, dim: this.dim, count: this.count, q, queryScale, k })
  }

  private dot(row: number, unit: Float32Array): number {
    const offset = row * this.dim
    let sum = 0
    for (let i = 0; i < this.dim; i++) sum += this.data[offset + i]! * unit[i]!
    return sum / this.scales[row]!
  }

  private grow(rows: number): void {
    if (rows <= this.ids.length) return
    const capacity = Math.max(rows, this.ids.length * 2, 64)
    const ids = new Int32Array(new SharedArrayBuffer(capacity * 4))
    ids.set(this.ids)
    const data = new Int8Array(new SharedArrayBuffer(capacity * this.dim))
    data.set(this.data)
    const scales = new Float32Array(new SharedArrayBuffer(capacity * 4))
    scales.set(this.scales)
    this.ids = ids
    this.data = data
    this.scales = scales
  }
}

/**
 * Reciprocal rank fusion of ranked id lists.
 * @param lists - each list ordered best first.
 * @param k - the RRF constant; 60 by convention.
 * @returns fused scores by id.
 */
export function reciprocalRankFusion(lists: readonly (readonly number[])[], k = 60): Map<number, number> {
  const scores = new Map<number, number>()
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)))
  }
  return scores
}

/** Row count from which {@link VectorIndex.searchAsync} scans in a worker thread. */
export const WORKER_MIN_ROWS = 20_000

const quantizeQuery = (query: Float32Array): { q: Int32Array; queryScale: number } => {
  const unit = normalize(query)
  let max = 0
  for (let i = 0; i < unit.length; i++) max = Math.max(max, Math.abs(unit[i]!))
  const queryScale = max === 0 ? 1 : 127 / max
  const q = new Int32Array(unit.length)
  for (let i = 0; i < unit.length; i++) q[i] = Math.round(unit[i]! * queryScale)
  return { q, queryScale }
}

/**
 * Integer dot-product scan keeping the `k` best rows. Self-contained: its
 * source is also run inside the worker.
 */
function scanTop(data: Int8Array, scales: Float32Array, ids: Int32Array, dim: number, from: number, to: number, q: Int32Array, queryScale: number, k: number, accept?: (id: number) => boolean): VectorHit[] {
  const tail = dim - (dim % 4)
  const top: VectorHit[] = []
  let floor = -Infinity
  for (let row = from; row < to; row++) {
    const id = ids[row]!
    if (accept !== undefined && !accept(id)) continue
    const offset = row * dim
    let s0 = 0
    let s1 = 0
    let s2 = 0
    let s3 = 0
    let i = 0
    for (; i < tail; i += 4) {
      s0 = (s0 + data[offset + i]! * q[i]!) | 0
      s1 = (s1 + data[offset + i + 1]! * q[i + 1]!) | 0
      s2 = (s2 + data[offset + i + 2]! * q[i + 2]!) | 0
      s3 = (s3 + data[offset + i + 3]! * q[i + 3]!) | 0
    }
    for (; i < dim; i++) s0 = (s0 + data[offset + i]! * q[i]!) | 0
    const score = (s0 + s1 + s2 + s3) / (scales[row]! * queryScale)
    if (top.length < k) {
      top.push({ id, score })
      if (top.length === k) {
        top.sort((a, b) => b.score - a.score)
        floor = top[k - 1]!.score
      }
    } else if (score > floor) {
      let j = k - 1
      while (j > 0 && top[j - 1]!.score < score) {
        top[j] = top[j - 1]!
        j--
      }
      top[j] = { id, score }
      floor = top[k - 1]!.score
    }
  }
  return top.length < k ? top.sort((a, b) => b.score - a.score) : top
}

interface ScanRequest {
  readonly data: Int8Array
  readonly scales: Float32Array
  readonly ids: Int32Array
  readonly dim: number
  readonly count: number
  readonly q: Int32Array
  readonly queryScale: number
  readonly k: number
}

interface ScanWorker {
  scan(request: ScanRequest): Promise<VectorHit[]>
}

let sharedWorker: ScanWorker | null | undefined

/**
 * The process-wide scan worker, started on first use and unref'd so it never
 * keeps the process alive. `undefined` when worker threads are unavailable.
 */
const scanWorker = (): ScanWorker | undefined => {
  if (sharedWorker !== undefined) return sharedWorker ?? undefined
  try {
    const { Worker } = process.getBuiltinModule('node:worker_threads')
    const source = `const scanTop = ${scanTop.toString()}
const { parentPort } = require('node:worker_threads')
parentPort.on('message', ({ id, r }) => {
  try { parentPort.postMessage({ id, hits: scanTop(r.data, r.scales, r.ids, r.dim, 0, r.count, r.q, r.queryScale, r.k) }) }
  catch (error) { parentPort.postMessage({ id, error: String(error) }) }
})`
    const worker = new Worker(source, { eval: true })
    worker.unref()
    const pending = new Map<number, { resolve: (hits: VectorHit[]) => void; reject: (error: Error) => void }>()
    let next = 0
    worker.on('message', (message: { id: number; hits?: VectorHit[]; error?: string }) => {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (pending.size === 0) worker.unref()
      if (message.error !== undefined) waiter?.reject(new Error(message.error))
      else waiter?.resolve(message.hits ?? [])
    })
    const fail = (error: unknown): void => {
      sharedWorker = null
      for (const waiter of pending.values()) waiter.reject(error instanceof Error ? error : new Error(String(error)))
      pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', () => fail(new Error('vector scan worker exited')))
    sharedWorker = {
      scan: request => new Promise((resolve, reject) => {
        const id = next++
        pending.set(id, { resolve, reject })
        worker.ref()
        worker.postMessage({ id, r: request })
      }),
    }
    return sharedWorker
  } catch {
    sharedWorker = null
    return undefined
  }
}
