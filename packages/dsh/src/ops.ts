/**
 * Management operations behind the `herMemory/call` Remote method. Each op
 * takes and returns plain JSON so the browser page needs no shared types at
 * runtime; {@link MemoryOps} is the one place that maps them onto the engine.
 */

import { deleteModel, LOCAL_MODELS, type LocalEmbedder, modelBytes, modelDownloaded, runtimeSupported } from '@her-os/memory-local-embed'
import { type Embedder, type ListQuery, type Memory, MEMORY_KINDS, type MemoryEngine, type MemoryKind, type MemoryPatch, type MemoryStatus, MEMORY_STATUSES } from '@her-os/memory-core'

/** Semantic search as the settings configured it. */
export interface OpsEmbedding {
  readonly provider: 'local' | 'remote' | 'off'
  /** The live embedder, or `null` when vectors are off or unconfigured. */
  readonly embedder: Embedder | null
  /** The local embedder when the provider is `local`. */
  readonly local: LocalEmbedder | undefined
  /** Local model cache root. */
  readonly root: string
}

/** Runtime switches the ops read and change. */
export interface OpsHost {
  readonly engine: MemoryEngine
  readonly embedding: OpsEmbedding
  paused(): boolean
  setPaused(paused: boolean): void
}

/** A request the page made that cannot be served. */
export class OpError extends Error {
  override name = 'OpError'
}

const PAGE_MAX = 200

const int = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new OpError(`${field} must be an integer`)
  return value
}

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new OpError(`${field} must be a non-empty string`)
  return value
}

const optional = <T>(value: unknown, read: (v: unknown) => T): T | undefined => value === undefined || value === null ? undefined : read(value)

const kindOf = (value: unknown): MemoryKind => {
  if (!MEMORY_KINDS.includes(value as MemoryKind)) throw new OpError(`unknown kind ${String(value)}`)
  return value as MemoryKind
}

const statusOf = (value: unknown): MemoryStatus => {
  if (!MEMORY_STATUSES.includes(value as MemoryStatus)) throw new OpError(`unknown status ${String(value)}`)
  return value as MemoryStatus
}

const PATCH_FIELDS = {
  content: (v: unknown) => str(v, 'content').trim(),
  kind: kindOf,
  people: (v: unknown) => {
    if (!Array.isArray(v) || v.some(p => typeof p !== 'string')) throw new OpError('people must be a string list')
    return (v as string[]).map(p => p.trim()).filter(p => p !== '')
  },
  occurredAt: (v: unknown) => v === null ? null : str(v, 'occurredAt'),
  followUpAt: (v: unknown) => v === null ? null : str(v, 'followUpAt'),
  importance: (v: unknown) => Math.min(3, Math.max(1, int(v, 'importance'))),
  sensitive: (v: unknown) => v === true,
  pinned: (v: unknown) => v === true,
  mentionBlocked: (v: unknown) => v === true,
  needsConfirm: (v: unknown) => v === true,
  status: (v: unknown) => {
    const status = statusOf(v)
    if (status === 'deleted' || status === 'superseded') throw new OpError('use remove or correct for this status')
    return status
  },
} satisfies Partial<Record<keyof MemoryPatch, (v: unknown) => unknown>>

/** Page-facing summary of a memory. */
export type MemoryView = Memory

/** Dispatcher of management operations. */
export class MemoryOps {
  private readonly host: OpsHost

  /**
   * @param host - engine and runtime switches.
   */
  constructor(host: OpsHost) {
    this.host = host
  }

  /**
   * Run one operation.
   * @param op - operation name.
   * @param payload - JSON arguments.
   * @returns the JSON result.
   * @throws {OpError} for unknown ops and invalid arguments.
   */
  async run(op: string, payload: Record<string, unknown>): Promise<unknown> {
    const { engine } = this.host
    switch (op) {
      case 'overview': return this.overview()
      case 'list': return engine.list(this.listQuery(payload))
      case 'detail': {
        const detail = engine.detail(int(payload.id, 'id'))
        if (detail === undefined) throw new OpError('memory not found')
        return detail
      }
      case 'patch': {
        const patch: Record<string, unknown> = {}
        const raw = (payload.patch ?? {}) as Record<string, unknown>
        for (const [field, read] of Object.entries(PATCH_FIELDS)) {
          if (Object.hasOwn(raw, field)) patch[field] = read(raw[field])
        }
        if (Object.keys(patch).length === 0) throw new OpError('patch is empty')
        return engine.patch(int(payload.id, 'id'), patch as MemoryPatch)
      }
      case 'correct': return engine.correct(int(payload.id, 'id'), str(payload.content, 'content'))
      case 'forget': return engine.forget(int(payload.id, 'id'))
      case 'remove': engine.remove(int(payload.id, 'id')); return { ok: true }
      case 'restore': engine.restore(int(payload.id, 'id')); return { ok: true }
      case 'purge': engine.purge(int(payload.id, 'id')); return { ok: true }
      case 'emptyTrash': {
        const { items } = await engine.list({ offset: 0, limit: 10_000, statuses: ['deleted'] })
        for (const memory of items) engine.purge(memory.id)
        return { purged: items.length }
      }
      case 'people': return engine.repo.people()
      case 'updatePerson': {
        const patch: { relation?: string | null; note?: string | null; aliases?: readonly string[] } = {}
        if (Object.hasOwn(payload, 'relation')) patch.relation = typeof payload.relation === 'string' && payload.relation.trim() !== '' ? payload.relation.trim() : null
        if (Object.hasOwn(payload, 'note')) patch.note = typeof payload.note === 'string' && payload.note.trim() !== '' ? payload.note.trim() : null
        if (Array.isArray(payload.aliases)) patch.aliases = (payload.aliases as unknown[]).flatMap(a => typeof a === 'string' && a.trim() !== '' ? [a.trim()] : [])
        engine.repo.updatePerson(int(payload.id, 'id'), patch, new Date())
        return { ok: true }
      }
      case 'suppressions': return engine.repo.suppressions().map(s => ({ id: s.id, summary: s.summary }))
      case 'removeSuppression': engine.repo.removeSuppression(int(payload.id, 'id')); return { ok: true }
      case 'embeddingStatus': return this.embeddingStatus()
      case 'testEmbedding': {
        const { embedder } = this.host.embedding
        if (embedder === null) throw new OpError('embedding is not configured')
        return engine.testEmbedding(embedder)
      }
      case 'localModels': return this.localModels()
      case 'prepareLocalModel': {
        const { local } = this.host.embedding
        if (local === undefined) throw new OpError('the local model is not selected')
        void local.prepare()
        return local.status()
      }
      case 'deleteLocalModel': {
        const id = str(payload.id, 'id')
        if (!LOCAL_MODELS.some(model => model.id === id)) throw new OpError(`unknown model ${id}`)
        if (this.host.embedding.local?.model.id === id) throw new OpError('the model in use cannot be deleted')
        deleteModel(this.host.embedding.root, id)
        return { ok: true }
      }
      case 'backfill': void engine.backfill(); return { ok: true }
      case 'setPaused': this.host.setPaused(payload.paused === true); return { paused: this.host.paused() }
      default: throw new OpError(`unknown op ${op}`)
    }
  }

  private overview(): unknown {
    const { engine } = this.host
    return {
      paused: this.host.paused(),
      counts: engine.repo.countByStatus(),
      queue: engine.repo.queueLength(),
      extractError: engine.lastExtractionError(),
      embedding: this.embeddingStatus(),
    }
  }

  private embeddingStatus(): unknown {
    const { provider, local } = this.host.embedding
    return { ...this.host.engine.embeddingStatus(), provider, local: local?.status() ?? null }
  }

  private localModels(): unknown {
    const { local, root } = this.host.embedding
    return {
      supported: runtimeSupported(),
      models: LOCAL_MODELS.map(model => ({
        id: model.id,
        name: model.name,
        downloadMB: Math.round(modelBytes(model) / 1e6),
        dims: model.dims,
        languages: model.languages,
        quality: model.quality,
        speed: model.speed,
        memoryMB: model.memoryMB,
        downloaded: modelDownloaded(root, model.id),
        selected: local?.model.id === model.id,
      })),
    }
  }

  private listQuery(payload: Record<string, unknown>): ListQuery {
    const statuses = Array.isArray(payload.statuses) ? (payload.statuses as unknown[]).map(statusOf) : undefined
    const search = typeof payload.search === 'string' && payload.search.trim() !== '' ? payload.search.trim() : undefined
    const person = typeof payload.person === 'string' && payload.person.trim() !== '' ? payload.person.trim() : undefined
    return {
      offset: Math.max(0, optional(payload.offset, v => int(v, 'offset')) ?? 0),
      limit: Math.min(PAGE_MAX, Math.max(1, optional(payload.limit, v => int(v, 'limit')) ?? 50)),
      ...(payload.kind === undefined || payload.kind === null || payload.kind === '' ? {} : { kind: kindOf(payload.kind) }),
      ...(statuses === undefined ? {} : { statuses }),
      ...(person === undefined ? {} : { person }),
      ...(typeof payload.sensitive === 'boolean' ? { sensitive: payload.sensitive } : {}),
      ...(typeof payload.pinned === 'boolean' ? { pinned: payload.pinned } : {}),
      ...(search === undefined ? {} : { search }),
    }
  }
}
