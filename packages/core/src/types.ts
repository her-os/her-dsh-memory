/** Record types of the memory core. */

import type { MEMORY_KINDS, MEMORY_STATUSES } from './schema.ts'

/** Memory category. */
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** Memory lifecycle state. */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/** One stored memory as the core reads it. */
export interface Memory {
  readonly id: number
  readonly content: string
  readonly kind: MemoryKind
  readonly factKey: string | null
  readonly people: readonly string[]
  /** `YYYY-MM-DD` the event happened, when known. */
  readonly occurredAt: string | null
  /** ISO instant the memory was written. */
  readonly learnedAt: string
  /** `YYYY-MM-DD` to follow up on, when any. */
  readonly followUpAt: string | null
  /** 1 low … 3 high. */
  readonly importance: number
  readonly emotion: string | null
  readonly sensitive: boolean
  readonly status: MemoryStatus
  readonly pinned: boolean
  /** Remember but never bring up in recall or proactive mention. */
  readonly mentionBlocked: boolean
  readonly needsConfirm: boolean
  readonly sourceSession: string | null
  readonly sourceTurn: number | null
  readonly scope: string
  /** Base strength before time decay; grows when the user brings the memory up again. */
  readonly strength: number
  readonly reinforcedAt: string | null
  readonly supersedes: number | null
  readonly supersededBy: number | null
  readonly deletedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** Fields a writer supplies for a new memory. */
export interface NewMemory {
  readonly content: string
  readonly kind: MemoryKind
  readonly factKey?: string | null
  readonly people?: readonly string[]
  readonly occurredAt?: string | null
  readonly followUpAt?: string | null
  readonly importance?: number
  readonly emotion?: string | null
  readonly sensitive?: boolean
  readonly pinned?: boolean
  readonly mentionBlocked?: boolean
  readonly needsConfirm?: boolean
  readonly sourceSession?: string | null
  readonly sourceTurn?: number | null
  readonly scope: string
}

/** Fields an edit may change. */
export type MemoryPatch = Partial<Pick<Memory,
  'content' | 'kind' | 'factKey' | 'people' | 'occurredAt' | 'followUpAt' | 'importance' | 'emotion'
  | 'sensitive' | 'pinned' | 'mentionBlocked' | 'needsConfirm' | 'status' | 'strength' | 'reinforcedAt'>>

/** A person in the relationship graph. */
export interface Person {
  readonly id: number
  readonly name: string
  readonly aliases: readonly string[]
  readonly relation: string | null
  readonly note: string | null
  readonly memoryCount: number
}

/** Logger used by the core; messages never contain memory text. */
export interface Logger {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
}

/** A logger that drops everything. */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {} }
