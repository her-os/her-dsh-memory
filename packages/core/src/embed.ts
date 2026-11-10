/** OpenAI-compatible embedding client. */

/** What a text is embedded for; asymmetric models prefix queries and documents differently. */
export type EmbedPurpose = 'query' | 'document'

/** Embedding port of the engine. */
export interface Embedder {
  /**
   * Embed texts in order.
   * @param texts - inputs.
   * @param signal - cancels the request.
   * @param purpose - search query or stored memory; defaults to `document`.
   * @returns one vector per input.
   */
  embed(texts: readonly string[], signal?: AbortSignal, purpose?: EmbedPurpose): Promise<Float32Array[]>
  /**
   * Identity of the vector space: endpoint, model, and dimension. Vectors with another fingerprint are stale.
   * @returns the fingerprint.
   */
  fingerprint(): string
}

/** Settings of an OpenAI-compatible `/embeddings` endpoint. */
export interface EmbeddingSettings {
  readonly baseURL: string
  readonly apiKey?: string
  readonly model: string
  /** Requested dimension; omitted means the model default. */
  readonly dimensions?: number
}

/** A non-2xx response or malformed body from the endpoint. */
export class EmbeddingError extends Error {
  readonly status: number | undefined

  /**
   * @param message - what went wrong, without request text.
   * @param status - HTTP status, when any.
   */
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
    this.name = 'EmbeddingError'
  }
}

/**
 * Build an embedder over `POST {baseURL}/embeddings`.
 * @param settings - endpoint, key, model, dimension.
 * @param fetchImpl - fetch implementation; defaults to the global one.
 * @returns the embedder.
 */
export function openAICompatibleEmbedder(settings: EmbeddingSettings, fetchImpl: typeof fetch = fetch): Embedder {
  const url = `${settings.baseURL.replace(/\/+$/, '')}/embeddings`
  const fingerprint = `${settings.baseURL.replace(/\/+$/, '')}|${settings.model}|${settings.dimensions ?? 'auto'}`
  let dimension = settings.dimensions
  return {
    fingerprint: () => fingerprint,
    async embed(texts, signal) {
      if (texts.length === 0) return []
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (settings.apiKey !== undefined && settings.apiKey !== '') headers.authorization = `Bearer ${settings.apiKey}`
      const body: Record<string, unknown> = { model: settings.model, input: texts }
      if (settings.dimensions !== undefined) body.dimensions = settings.dimensions
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
      if (!response.ok) throw new EmbeddingError(`embedding endpoint returned HTTP ${response.status}`, response.status)
      const json = await response.json() as { data?: { embedding?: unknown; index?: number }[] }
      if (!Array.isArray(json.data) || json.data.length !== texts.length) throw new EmbeddingError('embedding response has the wrong number of vectors')
      const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      return ordered.map(item => {
        if (!Array.isArray(item.embedding)) throw new EmbeddingError('embedding response item has no vector')
        const vector = Float32Array.from(item.embedding as number[])
        dimension ??= vector.length
        if (vector.length !== dimension) throw new EmbeddingError(`embedding dimension changed from ${dimension} to ${vector.length}`)
        return vector
      })
    },
  }
}

/**
 * The embedder cannot answer yet, e.g. a local model still downloading. Callers
 * fall back to keywords and wait for the embedder to announce readiness.
 */
export class EmbedderNotReadyError extends Error {
  /**
   * @param message - what the embedder is waiting for.
   */
  constructor(message: string) {
    super(message)
    this.name = 'EmbedderNotReadyError'
  }
}

/** Raised when an embedding call exceeds its time limit. */
export class EmbeddingTimeoutError extends Error {
  readonly ms: number

  /**
   * @param ms - the limit that elapsed.
   */
  constructor(ms: number) {
    super(`embedding request exceeded ${ms} ms`)
    this.name = 'EmbeddingTimeoutError'
    this.ms = ms
  }
}

/**
 * Embed with a time limit.
 * @param embedder - the embedder.
 * @param texts - inputs.
 * @param ms - time limit.
 * @param signal - outer cancellation.
 * @param purpose - search query or stored memory.
 * @returns the vectors.
 * @throws {EmbeddingTimeoutError} when the limit elapses first.
 */
export async function embedWithin(embedder: Embedder, texts: readonly string[], ms: number, signal?: AbortSignal, purpose: EmbedPurpose = 'document'): Promise<Float32Array[]> {
  const timeout = AbortSignal.timeout(ms)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    return await embedder.embed(texts, combined, purpose)
  } catch (error) {
    if (timeout.aborted && signal?.aborted !== true) throw new EmbeddingTimeoutError(ms)
    throw error
  }
}
