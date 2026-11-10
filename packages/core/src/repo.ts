/**
 * Reads and writes on the memory database. Every multi-statement write runs in
 * one short `BEGIN IMMEDIATE` transaction; the FTS row of a memory always has
 * the memory's id as its rowid.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { ftsQuery, ftsText } from './text.ts'
import type { Memory, MemoryKind, MemoryPatch, MemoryStatus, NewMemory, Person } from './types.ts'
import { blobToVector, vectorToBlob } from './vector.ts'

type Row = Record<string, SQLInputValue>

const toMemory = (row: Row): Memory => ({
  id: Number(row.id),
  content: String(row.content),
  kind: row.kind as MemoryKind,
  factKey: row.fact_key === null ? null : String(row.fact_key),
  people: JSON.parse(String(row.people)) as string[],
  occurredAt: row.occurred_at === null ? null : String(row.occurred_at),
  learnedAt: String(row.learned_at),
  followUpAt: row.follow_up_at === null ? null : String(row.follow_up_at),
  importance: Number(row.importance),
  emotion: row.emotion === null ? null : String(row.emotion),
  sensitive: row.sensitive === 1,
  status: row.status as MemoryStatus,
  pinned: row.pinned === 1,
  mentionBlocked: row.mention_blocked === 1,
  needsConfirm: row.needs_confirm === 1,
  sourceSession: row.source_session === null ? null : String(row.source_session),
  sourceTurn: row.source_turn === null ? null : Number(row.source_turn),
  scope: String(row.scope),
  strength: Number(row.strength),
  reinforcedAt: row.reinforced_at === null ? null : String(row.reinforced_at),
  supersedes: row.supersedes === null ? null : Number(row.supersedes),
  supersededBy: row.superseded_by === null ? null : Number(row.superseded_by),
  deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

const PATCH_COLUMNS: Readonly<Record<keyof MemoryPatch, string>> = {
  content: 'content', kind: 'kind', factKey: 'fact_key', people: 'people', occurredAt: 'occurred_at',
  followUpAt: 'follow_up_at', importance: 'importance', emotion: 'emotion', sensitive: 'sensitive',
  pinned: 'pinned', mentionBlocked: 'mention_blocked', needsConfirm: 'needs_confirm', status: 'status',
  strength: 'strength', reinforcedAt: 'reinforced_at',
}

const sqlValue = (value: unknown): SQLInputValue => {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Array.isArray(value)) return JSON.stringify(value)
  return value as SQLInputValue
}

/** Filters for {@link MemoryRepo.list}. */
export interface ListQuery {
  readonly offset: number
  readonly limit: number
  readonly kind?: MemoryKind
  readonly statuses?: readonly MemoryStatus[]
  readonly person?: string
  readonly sensitive?: boolean
  readonly pinned?: boolean
  readonly search?: string
  readonly scopes?: readonly string[]
  /** Only these memory ids. */
  readonly ids?: readonly number[]
}

/** Filters of a {@link ListQuery} without its page window. */
export type ListFilter = Omit<ListQuery, 'offset' | 'limit'>

/** One queued extraction unit. */
export interface QueueItem {
  readonly id: number
  readonly sessionId: string
  readonly turn: number
  readonly payload: string
  readonly attempts: number
}

/** One row of the recall log. */
export interface RecallLogEntry {
  readonly sessionId: string
  readonly turn: number
  readonly memoryId: number
  readonly score: number
  readonly reason: string
  readonly filtered: string | null
  readonly createdAt: string
}

/** One suppression: content the user asked to forget. */
export interface Suppression {
  readonly id: number
  readonly summary: string
  readonly factKey: string | null
  readonly fingerprint: string | null
  readonly vector: Float32Array | null
}

/** One proactive mention record. */
export interface ProactiveEntry {
  readonly id: number
  readonly memoryId: number
  readonly sessionId: string
  readonly scope: string
  readonly mentionedAt: string
  readonly responded: boolean | null
}

/** Typed access to one open memory database. */
export class MemoryRepo {
  readonly db: DatabaseSync

  /**
   * @param db - an open, migrated connection.
   */
  constructor(db: DatabaseSync) {
    this.db = db
  }

  /**
   * Run `fn` inside one immediate transaction.
   * @param fn - the work; its return value is passed through.
   * @returns what `fn` returned.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Insert a memory with its FTS row and people links.
   * @param input - the new memory.
   * @param now - write instant; becomes `learned_at`.
   * @returns the stored memory.
   */
  insert(input: NewMemory, now: Date): Memory {
    const at = now.toISOString()
    const people = [...new Set(input.people ?? [])]
    const result = this.db.prepare(`INSERT INTO memories (content, kind, fact_key, people, occurred_at, learned_at,
      follow_up_at, importance, emotion, sensitive, pinned, mention_blocked, needs_confirm, source_session, source_turn,
      scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.content, input.kind, input.factKey ?? null, JSON.stringify(people), input.occurredAt ?? null, at,
      input.followUpAt ?? null, input.importance ?? 2, input.emotion ?? null, input.sensitive === true ? 1 : 0,
      input.pinned === true ? 1 : 0, input.mentionBlocked === true ? 1 : 0, input.needsConfirm === true ? 1 : 0,
      input.sourceSession ?? null, input.sourceTurn ?? null, input.scope, at, at,
    )
    const id = Number(result.lastInsertRowid)
    this.db.prepare('INSERT INTO memory_fts (rowid, tokens) VALUES (?, ?)').run(id, ftsText(indexText(input.content, people)))
    this.linkPeople(id, people, at)
    return this.require(id)
  }

  /**
   * Apply a patch; content or people changes re-index FTS and drop the stale vector.
   * @param id - memory id.
   * @param patch - changed fields.
   * @param now - edit instant.
   * @returns the updated memory.
   */
  update(id: number, patch: MemoryPatch, now: Date): Memory {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof MemoryPatch, unknown][]
    const at = now.toISOString()
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${PATCH_COLUMNS[key]} = ?`).join(', ')
      this.db.prepare(`UPDATE memories SET ${sets}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => sqlValue(value)), at, id)
    }
    const memory = this.require(id)
    if (patch.content !== undefined || patch.people !== undefined) {
      this.db.prepare('UPDATE memory_fts SET tokens = ? WHERE rowid = ?').run(ftsText(indexText(memory.content, memory.people)), id)
      this.db.prepare('DELETE FROM memory_people WHERE memory_id = ?').run(id)
      this.linkPeople(id, memory.people, at)
    }
    if (patch.content !== undefined) this.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id)
    return memory
  }

  /**
   * Mark `oldId` as superseded by `newId` and link both directions.
   * @param oldId - the replaced memory.
   * @param newId - the replacement.
   * @param now - edit instant.
   */
  supersede(oldId: number, newId: number, now: Date): void {
    const at = now.toISOString()
    this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(newId, at, oldId)
    this.db.prepare('UPDATE memories SET supersedes = ?, updated_at = ? WHERE id = ?').run(oldId, at, newId)
  }

  /**
   * Fetch one memory.
   * @param id - memory id.
   * @returns the memory, or `undefined`.
   */
  get(id: number): Memory | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : toMemory(row)
  }

  /**
   * Fetch a memory that must exist.
   * @param id - memory id.
   * @returns the memory.
   */
  require(id: number): Memory {
    const memory = this.get(id)
    if (memory === undefined) throw new Error(`memory ${id} does not exist`)
    return memory
  }

  /**
   * Fetch several memories.
   * @param ids - memory ids.
   * @returns memories by id; missing ids are absent.
   */
  getMany(ids: readonly number[]): Map<number, Memory> {
    const out = new Map<number, Memory>()
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Row[]
      for (const row of rows) out.set(Number(row.id), toMemory(row))
    }
    return out
  }

  /**
   * The current (active or faded) memories carrying a fact key in a scope.
   * @param factKey - the fact key.
   * @param scopes - visible scopes.
   * @returns matching memories, newest first.
   */
  currentByFactKey(factKey: string, scopes: readonly string[]): Memory[] {
    const rows = this.db.prepare(`SELECT * FROM memories WHERE fact_key = ? AND status IN ('active', 'faded')
      AND scope IN (${scopes.map(() => '?').join(',')}) ORDER BY learned_at DESC`).all(factKey, ...scopes) as Row[]
    return rows.map(toMemory)
  }

  /**
   * The superseded predecessors of a memory, newest first.
   * @param id - the current memory.
   * @returns the chain, excluding `id` itself.
   */
  history(id: number): Memory[] {
    const chain: Memory[] = []
    let next = this.get(id)?.supersedes ?? null
    const seen = new Set<number>([id])
    while (next !== null && !seen.has(next)) {
      seen.add(next)
      const memory = this.get(next)
      if (memory === undefined) break
      chain.push(memory)
      next = memory.supersedes
    }
    return chain
  }

  /**
   * BM25-ranked ids matching any token of the text.
   * @param text - query text.
   * @param limit - result cap.
   * @param statuses - accepted states.
   * @param scopes - visible scopes; omitted means all.
   * @returns ids, best first.
   */
  keywordSearch(text: string, limit: number, statuses: readonly MemoryStatus[], scopes?: readonly string[]): number[] {
    const match = ftsQuery(text)
    if (match === undefined) return []
    const scopeSql = scopes === undefined ? '' : ` AND m.scope IN (${scopes.map(() => '?').join(',')})`
    const rows = this.db.prepare(`SELECT m.id AS id FROM memory_fts f JOIN memories m ON m.id = f.rowid
      WHERE memory_fts MATCH ? AND m.status IN (${statuses.map(() => '?').join(',')})${scopeSql}
      ORDER BY bm25(memory_fts) LIMIT ?`).all(match, ...statuses, ...scopes ?? [], limit) as Row[]
    return rows.map(row => Number(row.id))
  }

  /**
   * One page of memories for the management page, newest first.
   * @param query - filters and page window.
   * @returns the page and the total match count.
   */
  list(query: ListQuery): { items: Memory[]; total: number } {
    const filter = this.filterSql(query)
    if (filter === undefined) return { items: [], total: 0 }
    const { clause, args } = filter
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM memories m ${clause}`).get(...args) as Row).n)
    const rows = this.db.prepare(`SELECT m.* FROM memories m ${clause} ORDER BY m.pinned DESC, m.learned_at DESC, m.id DESC LIMIT ? OFFSET ?`)
      .all(...args, query.limit, query.offset) as Row[]
    return { items: rows.map(toMemory), total }
  }

  /**
   * Ids of every memory that passes the filters. With a search text, best
   * keyword match (BM25) first; otherwise in page order.
   * @param filter - list filters.
   * @returns matching ids.
   */
  listIds(filter: ListFilter): number[] {
    const { search, ...rest } = filter
    const match = search === undefined || search.trim() === '' ? undefined : ftsQuery(search)
    if (search !== undefined && search.trim() !== '' && match === undefined) return []
    const sql = this.filterSql(rest)
    if (sql === undefined) return []
    const rows = match === undefined
      ? this.db.prepare(`SELECT m.id AS id FROM memories m ${sql.clause} ORDER BY m.pinned DESC, m.learned_at DESC, m.id DESC`).all(...sql.args) as Row[]
      : this.db.prepare(`SELECT m.id AS id FROM memory_fts f JOIN memories m ON m.id = f.rowid
          WHERE memory_fts MATCH ?${sql.clause === '' ? '' : ` AND ${sql.clause.slice('WHERE '.length)}`}
          ORDER BY bm25(memory_fts), m.id DESC`).all(match, ...sql.args) as Row[]
    return rows.map(row => Number(row.id))
  }

  /** WHERE clause of the list filters; `undefined` when nothing can match. */
  private filterSql(query: ListFilter): { clause: string; args: SQLInputValue[] } | undefined {
    const where: string[] = []
    const args: SQLInputValue[] = []
    if (query.kind !== undefined) { where.push('m.kind = ?'); args.push(query.kind) }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      where.push(`m.status IN (${query.statuses.map(() => '?').join(',')})`)
      args.push(...query.statuses)
    }
    if (query.sensitive !== undefined) { where.push('m.sensitive = ?'); args.push(query.sensitive ? 1 : 0) }
    if (query.pinned !== undefined) { where.push('m.pinned = ?'); args.push(query.pinned ? 1 : 0) }
    if (query.scopes !== undefined) {
      where.push(`m.scope IN (${query.scopes.map(() => '?').join(',')})`)
      args.push(...query.scopes)
    }
    if (query.ids !== undefined) {
      if (query.ids.length === 0) return undefined
      where.push(`m.id IN (${query.ids.map(() => '?').join(',')})`)
      args.push(...query.ids)
    }
    if (query.person !== undefined) {
      where.push('m.id IN (SELECT mp.memory_id FROM memory_people mp JOIN people p ON p.id = mp.person_id WHERE p.name = ?)')
      args.push(query.person)
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const match = ftsQuery(query.search)
      if (match === undefined) return undefined
      where.push('m.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?)')
      args.push(match)
    }
    return { clause: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`, args }
  }

  /**
   * Memory counts per status.
   * @returns counts keyed by status.
   */
  countByStatus(): Record<MemoryStatus, number> {
    const counts: Record<MemoryStatus, number> = { active: 0, faded: 0, archived: 0, superseded: 0, deleted: 0 }
    for (const row of this.db.prepare('SELECT status, count(*) AS n FROM memories GROUP BY status').all() as Row[]) {
      counts[row.status as MemoryStatus] = Number(row.n)
    }
    return counts
  }

  /**
   * Move to the trash.
   * @param id - memory id.
   * @param now - deletion instant.
   */
  softDelete(id: number, now: Date): void {
    this.db.prepare("UPDATE memories SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now.toISOString(), now.toISOString(), id)
  }

  /**
   * Restore from the trash or archive to active.
   * @param id - memory id.
   * @param now - restore instant; also resets decay.
   */
  restore(id: number, now: Date): void {
    const at = now.toISOString()
    this.db.prepare("UPDATE memories SET status = 'active', deleted_at = NULL, reinforced_at = ?, updated_at = ? WHERE id = ?").run(at, at, id)
  }

  /**
   * Physically delete a memory with its vector, FTS row, links, and logs.
   * @param id - memory id.
   */
  purge(id: number): void {
    this.db.prepare('UPDATE memories SET supersedes = NULL WHERE supersedes = ?').run(id)
    this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(id)
    this.db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(id)
    this.db.prepare('DELETE FROM recall_log WHERE memory_id = ?').run(id)
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  /**
   * Ids of trashed memories deleted before an instant.
   * @param before - cutoff.
   * @returns ids to purge.
   */
  trashedBefore(before: Date): number[] {
    return (this.db.prepare("SELECT id FROM memories WHERE status = 'deleted' AND deleted_at < ?").all(before.toISOString()) as Row[])
      .map(row => Number(row.id))
  }

  /**
   * Memories in given states, for lifecycle sweeps and vector loading.
   * @param statuses - accepted states.
   * @returns the memories.
   */
  byStatus(statuses: readonly MemoryStatus[]): Memory[] {
    return (this.db.prepare(`SELECT * FROM memories WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses) as Row[]).map(toMemory)
  }

  /**
   * Proactive-mention candidates: dated follow-ups, open promises, and (when
   * `reminisce`) a bounded sample of older important events.
   * @param scopes - visible scopes.
   * @param fromDate - earliest follow-up date, `YYYY-MM-DD`.
   * @param toDate - latest follow-up date, `YYYY-MM-DD`.
   * @param reminisceBefore - ISO instant; older events qualify, or `null` to skip them.
   * @returns the candidates, at most a few hundred.
   */
  proactivePool(scopes: readonly string[], fromDate: string, toDate: string, reminisceBefore: string | null): Memory[] {
    const inScopes = scopes.map(() => '?').join(',')
    const base = `status IN ('active','faded') AND sensitive = 0 AND mention_blocked = 0 AND scope IN (${inScopes})`
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${base} AND follow_up_at BETWEEN ? AND ?
      UNION SELECT * FROM memories WHERE ${base} AND kind = 'promise' AND follow_up_at IS NULL
      LIMIT 200`).all(...scopes, fromDate, toDate, ...scopes) as Row[]
    if (reminisceBefore !== null) {
      rows.push(...this.db.prepare(`SELECT * FROM memories WHERE ${base} AND kind IN ('event','shared') AND importance >= 2
        AND follow_up_at IS NULL AND learned_at < ? ORDER BY importance DESC, strength DESC LIMIT 100`).all(...scopes, reminisceBefore) as Row[])
    }
    return rows.map(toMemory)
  }

  /**
   * Memories eligible for the resident system-prompt section.
   * @param scopes - visible scopes.
   * @param limit - row cap.
   * @returns pinned memories first, then high-importance profile memories, oldest first.
   */
  residentPool(scopes: readonly string[], limit: number): Memory[] {
    return (this.db.prepare(`SELECT * FROM memories WHERE status IN ('active','faded') AND sensitive = 0 AND mention_blocked = 0
      AND scope IN (${scopes.map(() => '?').join(',')}) AND (pinned = 1 OR (kind = 'profile' AND importance >= 3))
      ORDER BY pinned DESC, id LIMIT ?`).all(...scopes, limit) as Row[]).map(toMemory)
  }

  /**
   * Store a vector for a memory.
   * @param id - memory id.
   * @param fingerprint - embedding fingerprint.
   * @param vector - the vector.
   */
  putVector(id: number, fingerprint: string, vector: Float32Array): void {
    this.db.prepare(`INSERT INTO memory_vectors (memory_id, fingerprint, dim, vector) VALUES (?, ?, ?, ?)
      ON CONFLICT (memory_id) DO UPDATE SET fingerprint = excluded.fingerprint, dim = excluded.dim, vector = excluded.vector`)
      .run(id, fingerprint, vector.length, vectorToBlob(vector))
  }

  /**
   * Visit every stored vector of a fingerprint for memories in given states.
   * @param fingerprint - embedding fingerprint.
   * @param statuses - accepted memory states.
   * @param visit - called per row.
   */
  eachVector(fingerprint: string, statuses: readonly MemoryStatus[], visit: (id: number, vector: Float32Array) => void): void {
    const statement = this.db.prepare(`SELECT v.memory_id AS id, v.vector AS vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
      WHERE v.fingerprint = ? AND m.status IN (${statuses.map(() => '?').join(',')})`)
    for (const row of statement.iterate(fingerprint, ...statuses) as Iterable<Row>) {
      visit(Number(row.id), blobToVector(row.vector as Uint8Array))
    }
  }

  /**
   * Read one stored vector.
   * @param id - memory id.
   * @param fingerprint - required fingerprint.
   * @returns the vector, or `undefined` when missing or stale.
   */
  vectorOf(id: number, fingerprint: string): Float32Array | undefined {
    const row = this.db.prepare('SELECT vector FROM memory_vectors WHERE memory_id = ? AND fingerprint = ?').get(id, fingerprint) as Row | undefined
    return row === undefined ? undefined : blobToVector(row.vector as Uint8Array)
  }

  /**
   * Memories lacking a vector of the current fingerprint.
   * @param fingerprint - current embedding fingerprint.
   * @param limit - batch size.
   * @returns id and content pairs, oldest first.
   */
  missingVectors(fingerprint: string, limit: number): { id: number; content: string }[] {
    return (this.db.prepare(`SELECT m.id AS id, m.content AS content FROM memories m
      LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.fingerprint = ?
      WHERE v.memory_id IS NULL AND m.status NOT IN ('deleted') ORDER BY m.id LIMIT ?`).all(fingerprint, limit) as Row[])
      .map(row => ({ id: Number(row.id), content: String(row.content) }))
  }

  /**
   * Count memories with and without a current vector.
   * @param fingerprint - current embedding fingerprint.
   * @returns done and total counts over non-deleted memories.
   */
  vectorProgress(fingerprint: string): { done: number; total: number } {
    const row = this.db.prepare(`SELECT count(*) AS total, count(v.memory_id) AS done FROM memories m
      LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.fingerprint = ? WHERE m.status != 'deleted'`).get(fingerprint) as Row
    return { done: Number(row.done), total: Number(row.total) }
  }

  /**
   * Record content the user asked to forget.
   * @param summary - the forgotten content.
   * @param factKey - its fact key, when any.
   * @param fingerprint - embedding fingerprint of `vector`.
   * @param vector - its embedding, when available.
   * @param now - write instant.
   */
  addSuppression(summary: string, factKey: string | null, fingerprint: string | null, vector: Float32Array | null, now: Date): void {
    this.db.prepare('INSERT INTO suppressions (summary, fact_key, fingerprint, vector, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(summary, factKey, fingerprint, vector === null ? null : vectorToBlob(vector), now.toISOString())
  }

  /**
   * All suppressions.
   * @returns the list.
   */
  suppressions(): Suppression[] {
    return (this.db.prepare('SELECT * FROM suppressions').all() as Row[]).map(row => ({
      id: Number(row.id),
      summary: String(row.summary),
      factKey: row.fact_key === null ? null : String(row.fact_key),
      fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
      vector: row.vector === null ? null : blobToVector(row.vector as Uint8Array),
    }))
  }

  /**
   * Remove a suppression.
   * @param id - suppression id.
   */
  removeSuppression(id: number): void {
    this.db.prepare('DELETE FROM suppressions WHERE id = ?').run(id)
  }

  /**
   * Queue a turn for extraction; a repeated (session, turn) pair is ignored.
   * @param sessionId - session id.
   * @param turn - turn number.
   * @param payload - serialized turn text.
   * @param now - enqueue instant.
   */
  enqueue(sessionId: string, turn: number, payload: string, now: Date): void {
    const at = now.toISOString()
    this.db.prepare('INSERT OR IGNORE INTO extract_queue (session_id, turn, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, turn, payload, at, at)
  }

  /**
   * Queued items of one session due by an instant, oldest first.
   * @param now - the current instant.
   * @returns per-session groups in queue order.
   */
  dueQueue(now: Date): Map<string, QueueItem[]> {
    const rows = this.db.prepare('SELECT * FROM extract_queue WHERE next_attempt_at <= ? ORDER BY id').all(now.toISOString()) as Row[]
    const groups = new Map<string, QueueItem[]>()
    for (const row of rows) {
      const item = { id: Number(row.id), sessionId: String(row.session_id), turn: Number(row.turn), payload: String(row.payload), attempts: Number(row.attempts) }
      const list = groups.get(item.sessionId) ?? []
      list.push(item)
      groups.set(item.sessionId, list)
    }
    return groups
  }

  /**
   * Remove finished queue items.
   * @param ids - queue ids.
   */
  dequeue(ids: readonly number[]): void {
    for (const id of ids) this.db.prepare('DELETE FROM extract_queue WHERE id = ?').run(id)
  }

  /**
   * Postpone failed queue items.
   * @param ids - queue ids.
   * @param next - next attempt instant.
   */
  retryLater(ids: readonly number[], next: Date): void {
    for (const id of ids) this.db.prepare('UPDATE extract_queue SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?').run(next.toISOString(), id)
  }

  /**
   * Number of queued turns.
   * @returns the count.
   */
  queueLength(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM extract_queue').get() as Row).n)
  }

  /**
   * Read a meta value.
   * @param key - meta key.
   * @returns the value, or `undefined`.
   */
  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row === undefined ? undefined : String(row.value)
  }

  /**
   * Write a meta value.
   * @param key - meta key.
   * @param value - the value.
   */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /**
   * Append recall decisions.
   * @param entries - one row per considered memory.
   */
  logRecall(entries: readonly RecallLogEntry[]): void {
    const statement = this.db.prepare('INSERT INTO recall_log (session_id, turn, memory_id, score, reason, filtered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const e of entries) statement.run(e.sessionId, e.turn, e.memoryId, e.score, e.reason, e.filtered, e.createdAt)
  }

  /**
   * Recall history of one memory, newest first.
   * @param memoryId - memory id.
   * @param limit - row cap.
   * @returns the entries.
   */
  recallsOf(memoryId: number, limit: number): RecallLogEntry[] {
    return (this.db.prepare('SELECT * FROM recall_log WHERE memory_id = ? ORDER BY id DESC LIMIT ?').all(memoryId, limit) as Row[]).map(row => ({
      sessionId: String(row.session_id), turn: Number(row.turn), memoryId: Number(row.memory_id), score: Number(row.score),
      reason: String(row.reason), filtered: row.filtered === null ? null : String(row.filtered), createdAt: String(row.created_at),
    }))
  }

  /**
   * Drop recall rows older than an instant.
   * @param before - cutoff.
   * @returns deleted row count.
   */
  pruneRecallLog(before: Date): number {
    return Number(this.db.prepare('DELETE FROM recall_log WHERE created_at < ?').run(before.toISOString()).changes)
  }

  /**
   * Record a proactive mention.
   * @param memoryId - mentioned memory.
   * @param sessionId - session.
   * @param scope - session scope.
   * @param now - mention instant.
   */
  logProactive(memoryId: number, sessionId: string, scope: string, now: Date): void {
    this.db.prepare('INSERT INTO proactive_log (memory_id, session_id, scope, mentioned_at) VALUES (?, ?, ?, ?)').run(memoryId, sessionId, scope, now.toISOString())
  }

  /**
   * Set whether the user took up the latest unresolved mention in a session.
   * @param sessionId - session.
   * @param responded - whether the user engaged.
   * @returns the memory id resolved, when any.
   */
  resolveProactive(sessionId: string, responded: boolean): number | undefined {
    const row = this.db.prepare('SELECT id, memory_id FROM proactive_log WHERE session_id = ? AND responded IS NULL ORDER BY id DESC LIMIT 1').get(sessionId) as Row | undefined
    if (row === undefined) return undefined
    this.db.prepare('UPDATE proactive_log SET responded = ? WHERE id = ?').run(responded ? 1 : 0, row.id as number)
    return Number(row.memory_id)
  }

  /**
   * Proactive mentions of one memory, newest first.
   * @param memoryId - memory id.
   * @returns the entries.
   */
  mentionsOf(memoryId: number): ProactiveEntry[] {
    return (this.db.prepare('SELECT * FROM proactive_log WHERE memory_id = ? ORDER BY id DESC').all(memoryId) as Row[]).map(toProactive)
  }

  /**
   * The latest mention in a session, when any.
   * @param sessionId - session.
   * @returns the entry.
   */
  latestMention(sessionId: string): ProactiveEntry | undefined {
    const row = this.db.prepare('SELECT * FROM proactive_log WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as Row | undefined
    return row === undefined ? undefined : toProactive(row)
  }

  /**
   * Upsert a person by name.
   * @param name - display name.
   * @param now - write instant.
   * @returns the person id.
   */
  ensurePerson(name: string, now: Date): number {
    const at = now.toISOString()
    this.db.prepare('INSERT INTO people (name, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING').run(name, at, at)
    return Number((this.db.prepare('SELECT id FROM people WHERE name = ?').get(name) as Row).id)
  }

  /**
   * Edit a person's relation, note, or aliases.
   * @param id - person id.
   * @param patch - changed fields.
   * @param now - edit instant.
   */
  updatePerson(id: number, patch: { relation?: string | null; note?: string | null; aliases?: readonly string[] }, now: Date): void {
    if (patch.relation !== undefined) this.db.prepare('UPDATE people SET relation = ? WHERE id = ?').run(patch.relation, id)
    if (patch.note !== undefined) this.db.prepare('UPDATE people SET note = ? WHERE id = ?').run(patch.note, id)
    if (patch.aliases !== undefined) this.db.prepare('UPDATE people SET aliases = ? WHERE id = ?').run(JSON.stringify(patch.aliases), id)
    this.db.prepare('UPDATE people SET updated_at = ? WHERE id = ?').run(now.toISOString(), id)
  }

  /**
   * The relationship graph, most-mentioned first.
   * @returns people with their non-deleted memory counts.
   */
  people(): Person[] {
    return (this.db.prepare(`SELECT p.*, (SELECT count(*) FROM memory_people mp JOIN memories m ON m.id = mp.memory_id
      WHERE mp.person_id = p.id AND m.status != 'deleted') AS n FROM people p ORDER BY n DESC, p.name`).all() as Row[]).map(row => ({
      id: Number(row.id), name: String(row.name), aliases: JSON.parse(String(row.aliases)) as string[],
      relation: row.relation === null ? null : String(row.relation), note: row.note === null ? null : String(row.note),
      memoryCount: Number(row.n),
    }))
  }

  private linkPeople(id: number, people: readonly string[], at: string): void {
    for (const name of people) {
      const personId = this.ensurePerson(name, new Date(at))
      this.db.prepare('INSERT OR IGNORE INTO memory_people (memory_id, person_id) VALUES (?, ?)').run(id, personId)
    }
  }
}

const indexText = (content: string, people: readonly string[]): string => [content, ...people].join(' ')

const toProactive = (row: Row): ProactiveEntry => ({
  id: Number(row.id), memoryId: Number(row.memory_id), sessionId: String(row.session_id), scope: String(row.scope),
  mentionedAt: String(row.mentioned_at), responded: row.responded === null ? null : row.responded === 1,
})
