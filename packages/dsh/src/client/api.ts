/**
 * Page-side wrapper of the `herMemory/call` Remote method. The wire carries
 * JSON text both ways; this file owns the shapes the page reads. They mirror
 * the Host's {@link MemoryOps} results and must stay in step with them.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Memory category. */
export const KINDS = ['profile', 'event', 'promise', 'person', 'preference', 'shared'] as const
/** Memory category. */
export type Kind = (typeof KINDS)[number]

/** Memory lifecycle state. */
export const STATUSES = ['active', 'faded', 'archived', 'superseded', 'deleted'] as const
/** Memory lifecycle state. */
export type Status = (typeof STATUSES)[number]

/** One memory as the page shows it. */
export interface MemoryItem {
  readonly id: number
  readonly content: string
  readonly kind: Kind
  readonly people: readonly string[]
  readonly occurredAt: string | null
  readonly learnedAt: string
  readonly followUpAt: string | null
  readonly importance: number
  readonly sensitive: boolean
  readonly status: Status
  readonly pinned: boolean
  readonly mentionBlocked: boolean
  readonly needsConfirm: boolean
  readonly scope: string
  readonly supersedes: number | null
  readonly supersededBy: number | null
  readonly updatedAt: string
}

/** Why and when a memory was recalled. */
export interface RecallEntry {
  readonly sessionId: string
  readonly turn: number
  readonly score: number
  readonly reason: string
  readonly filtered: string | null
  readonly createdAt: string
}

/** Detail view of one memory. */
export interface MemoryDetail {
  readonly memory: MemoryItem
  readonly history: readonly MemoryItem[]
  readonly successor: MemoryItem | undefined
  readonly recalls: readonly RecallEntry[]
  readonly mentions: readonly { mentionedAt: string; sessionId: string; responded: boolean | null }[]
  readonly strength: number
}

/** Semantic-search index progress. */
export interface EmbeddingStatus {
  readonly configured: boolean
  readonly done: number
  readonly total: number
  readonly running: boolean
  readonly lastError: string | null
}

/** Header numbers. */
export interface Overview {
  readonly paused: boolean
  readonly counts: Record<Status, number>
  readonly queue: number
  /** Last background extraction failure, `null` once a batch succeeds. */
  readonly extractError: { readonly at: string; readonly message: string } | null
  readonly embedding: EmbeddingStatus
}

/** A person memories mention. */
export interface PersonItem {
  readonly id: number
  readonly name: string
  readonly aliases: readonly string[]
  readonly relation: string | null
  readonly note: string | null
  readonly memoryCount: number
}

/** List filters. */
export interface ListFilter {
  readonly search?: string
  readonly kind?: Kind
  readonly statuses?: readonly Status[]
  readonly person?: string
  readonly pinned?: boolean
  readonly sensitive?: boolean
}

/** Fields the page may change on a memory. */
export type MemoryPatch = Partial<Pick<MemoryItem, 'content' | 'kind' | 'people' | 'occurredAt' | 'followUpAt' | 'importance' | 'sensitive' | 'pinned' | 'mentionBlocked' | 'needsConfirm'>> & {
  readonly status?: 'active' | 'faded' | 'archived'
}

/** The raw Remote method as the Gateway exposes it. */
export type CallRemote = (op: string, payload: string) => Promise<RemoteResult<string>>

/** Typed management operations. */
export interface MemoryApi {
  overview(): Promise<Overview>
  list(filter: ListFilter, offset: number, limit: number): Promise<{ items: MemoryItem[]; total: number }>
  detail(id: number): Promise<MemoryDetail>
  patch(id: number, patch: MemoryPatch): Promise<MemoryItem>
  correct(id: number, content: string): Promise<MemoryItem>
  forget(id: number): Promise<MemoryItem>
  remove(id: number): Promise<void>
  restore(id: number): Promise<void>
  purge(id: number): Promise<void>
  emptyTrash(): Promise<{ purged: number }>
  people(): Promise<PersonItem[]>
  updatePerson(id: number, patch: { relation?: string; note?: string; aliases?: readonly string[] }): Promise<void>
  suppressions(): Promise<{ id: number; summary: string }[]>
  removeSuppression(id: number): Promise<void>
  embeddingStatus(): Promise<EmbeddingStatus>
  testEmbedding(): Promise<{ dimension: number; ms: number }>
  backfill(): Promise<void>
  setPaused(paused: boolean): Promise<{ paused: boolean }>
}

/** A refused or failed operation, carrying the Host's message. */
export class MemoryApiError extends Error {
  override name = 'MemoryApiError'
}

/**
 * Wrap the Remote method in typed operations.
 * @param call - `remote.herMemory.call`.
 * @returns the operations; each rejects with {@link MemoryApiError} on failure.
 */
export function createMemoryApi(call: CallRemote): MemoryApi {
  const run = async <T>(op: string, payload: object = {}): Promise<T> => {
    const result = await call(op, JSON.stringify(payload))
    if (!result.ok) throw new MemoryApiError(result.error.message)
    return JSON.parse(result.value) as T
  }
  const done = async (op: string, payload: object): Promise<void> => { await run(op, payload) }
  return {
    overview: () => run('overview'),
    list: (filter, offset, limit) => run('list', { ...filter, offset, limit }),
    detail: id => run('detail', { id }),
    patch: (id, patch) => run('patch', { id, patch }),
    correct: (id, content) => run('correct', { id, content }),
    forget: id => run('forget', { id }),
    remove: id => done('remove', { id }),
    restore: id => done('restore', { id }),
    purge: id => done('purge', { id }),
    emptyTrash: () => run('emptyTrash'),
    people: () => run('people'),
    updatePerson: (id, patch) => done('updatePerson', { id, ...patch }),
    suppressions: () => run('suppressions'),
    removeSuppression: id => done('removeSuppression', { id }),
    embeddingStatus: () => run('embeddingStatus'),
    testEmbedding: () => run('testEmbedding'),
    backfill: () => done('backfill', {}),
    setPaused: paused => run('setPaused', { paused }),
  }
}
