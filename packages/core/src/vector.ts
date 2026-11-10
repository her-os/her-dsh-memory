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
  private ids = new Int32Array(0)
  private data = new Int8Array(0)
  private scales = new Float32Array(0)
  private readonly rowOf = new Map<number, number>()
  private count = 0

  /**
   * @param dim - vector dimension every row must have.
   */
  constructor(readonly dim: number) {}

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
    const unit = normalize(query)
    const top: VectorHit[] = []
    for (let row = 0; row < this.count; row++) {
      const id = this.ids[row]!
      if (accept !== undefined && !accept(id)) continue
      const score = this.dot(row, unit)
      if (top.length < k) {
        top.push({ id, score })
        if (top.length === k) top.sort((a, b) => b.score - a.score)
      } else if (score > top[k - 1]!.score) {
        let i = k - 1
        while (i > 0 && top[i - 1]!.score < score) {
          top[i] = top[i - 1]!
          i--
        }
        top[i] = { id, score }
      }
    }
    return top.length < k ? top.sort((a, b) => b.score - a.score) : top
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
    const ids = new Int32Array(capacity)
    ids.set(this.ids)
    const data = new Int8Array(capacity * this.dim)
    data.set(this.data)
    const scales = new Float32Array(capacity)
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
