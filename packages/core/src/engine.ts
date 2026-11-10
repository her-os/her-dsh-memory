/**
 * The memory engine: one object per database that owns the vector index, the
 * extraction queue worker, background vector backfill, and every read and
 * write path. Hosts implement {@link MemoryPorts} and call the engine; the
 * engine never imports host packages.
 */

import type { DatabaseSync } from 'node:sqlite'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { type Embedder, embedWithin } from './embed.ts'
import { buildExtractInput, type Candidate, checkCandidate, isSkippableTurn, jaccard, parseExtraction, PROBLEM_TEXT, type TurnPayload } from './extract.ts'
import { currentStrength, decayedStatus, isDecayExempt, MAX_STRENGTH, REINFORCE_STEP } from './lifecycle.ts'
import { FOLLOW_UP_WINDOW_DAYS, type Offer, pickOffer, type ProactiveLevel, REMINISCE_MIN_AGE_DAYS, shouldOffer } from './proactive.ts'
import type { PromptPack } from './prompts.ts'
import { renderLine, renderProactiveBlock, renderRecallBlock, type Scored, selectRecall } from './recall.ts'
import { type ListQuery, MemoryRepo, type RecallLogEntry } from './repo.ts'
import { escapeForPrompt, looksLikeSecret, tokenize } from './text.ts'
import { addDays, calendarDay, type Clock, formatDate, resolveDate, weekdayOf } from './time.ts'
import type { Logger, Memory, MemoryKind, MemoryPatch, MemoryStatus } from './types.ts'
import { cosine, reciprocalRankFusion, VectorIndex } from './vector.ts'

/** Model completion port. */
export interface LlmPort {
  /**
   * One completion.
   * @param request - system and user text; `json` asks for a JSON object.
   * @returns the model text.
   */
  complete(request: { system: string; user: string; json?: boolean; signal?: AbortSignal; sessionId?: string }): Promise<string>
}

/** Tunables read on every use, so settings changes apply immediately. */
export interface EngineSettings {
  readonly paused: boolean
  readonly recallCount: number
  readonly injectBudget: number
  readonly embeddingTimeoutMs: number
  readonly proactive: ProactiveLevel
  readonly dailyExtractLimit: number
}

/** Host-supplied dependencies. */
export interface MemoryPorts {
  readonly db: DatabaseSync
  readonly llm: LlmPort
  readonly clock: Clock
  readonly prompts: PromptPack
  readonly logger: Logger
  readonly settings: () => EngineSettings
  /** Whether a session is producing a reply now; background work pauses meanwhile. */
  readonly busy?: () => boolean
}

/** Candidates scanned per retrieval path. */
export const RETRIEVAL_DEPTH = 30

/** Recall time budget, excluding the query embedding request; over budget the next turn skips vectors. Matches the 50k-memory target. */
export const RECALL_BUDGET_MS = 100

/** Embedding batch size for writes and backfill. */
export const EMBED_BATCH = 32

/** Time limit of one backfill batch. */
export const EMBED_BATCH_TIMEOUT_MS = 10_000

/** Backfill attempts before a batch waits for the next trigger. */
export const EMBED_MAX_ATTEMPTS = 5

/** Turns of one session merged into one extraction. */
export const EXTRACT_BATCH_TURNS = 3

/** Quiet time after which a session's queued turns are extracted. */
export const EXTRACT_IDLE_MS = 5 * 60_000

/** Retries of a failed extraction before the turns are dropped. */
export const EXTRACT_MAX_ATTEMPTS = 3

/** Existing memories shown to the extractor. */
export const EXTRACT_RELATED = 15

/** Token overlap at which a new memory duplicates an existing one. */
export const DUPLICATE_OVERLAP = 0.8

/** Token overlap at which a new memory matches a suppression. */
export const SUPPRESS_OVERLAP = 0.6

/** Vector similarity at which a new memory matches a suppression. */
export const SUPPRESS_SIMILARITY = 0.85

/** Days the recall log and the trash are kept. */
export const RETENTION_DAYS = 30

/** Idle time before consolidation runs. */
export const CONSOLIDATE_IDLE_MS = 30 * 60_000

const RECALL_STATUSES: readonly MemoryStatus[] = ['active', 'faded']
const SEARCH_STATUSES: readonly MemoryStatus[] = ['active', 'faded', 'archived', 'superseded']
const DAY_NAMES = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']

/** What a session's recall needs to know. */
export interface RecallRequest {
  readonly sessionId: string
  readonly turn: number
  readonly userText: string
  /** Scope new memories go to. */
  readonly scope: string
  /** Scopes visible to this session. */
  readonly scopes: readonly string[]
  /** Memories already injected in this session. */
  readonly injected: ReadonlySet<number>
  readonly firstTurn: boolean
  readonly offeredThisSession: boolean
  readonly signal?: AbortSignal
}

/** Result of one recall. */
export interface RecallResult {
  /** Injection text, or empty when nothing applies. */
  readonly text: string
  readonly injectedIds: readonly number[]
  readonly offer: Offer | undefined
  readonly elapsedMs: number
  readonly usedVectors: boolean
  readonly considered: readonly Scored[]
}

/** Embedding status for the management page. */
export interface EmbeddingStatus {
  readonly configured: boolean
  readonly fingerprint: string | null
  readonly done: number
  readonly total: number
  readonly running: boolean
  readonly lastError: string | null
}

/** A `memory_save` or `/remember` request. */
export interface SaveRequest {
  readonly content: string
  readonly scope: string
  readonly kind?: MemoryKind
  readonly sensitive?: boolean
  readonly pinned?: boolean
  readonly followUp?: string | null
  readonly sessionId?: string | null
}

/** A memory with its history and logs for the detail view. */
export interface MemoryDetail {
  readonly memory: Memory
  readonly history: readonly Memory[]
  readonly successor: Memory | undefined
  readonly recalls: readonly RecallLogEntry[]
  readonly mentions: readonly { mentionedAt: string; sessionId: string; responded: boolean | null }[]
  readonly strength: number
}

/** Owner of one memory database. */
export class MemoryEngine {
  readonly repo: MemoryRepo
  private embedder: Embedder | null = null
  private index: VectorIndex | undefined
  private indexFingerprint: string | undefined
  private skipVectorsNextTurn = false
  private backfillRun: Promise<void> | undefined
  private backfillError: string | null = null
  private extracting: Promise<void> | undefined
  private readonly lastEnqueue = new Map<string, number>()
  private lastActivity = Date.now()
  private lastConsolidation = 0
  private residentCache: { version: number; scopes: string; text: string } | undefined
  private version = 0
  private disposed = false

  private readonly ports: MemoryPorts

  /**
   * @param ports - host dependencies.
   */
  constructor(ports: MemoryPorts) {
    this.ports = ports
    this.repo = new MemoryRepo(ports.db)
  }

  /** Increments on every write; caches compare against it. */
  get changeVersion(): number {
    return this.version
  }

  /** Stop background work; the caller closes the database. */
  dispose(): void {
    this.disposed = true
  }

  // ── embedding ───────────────────────────────────────────────

  /**
   * Replace the embedder; a fingerprint change rebuilds the index and starts backfill.
   * @param embedder - the new embedder, or `null` when unconfigured.
   */
  setEmbedder(embedder: Embedder | null): void {
    const before = this.embedder?.fingerprint()
    this.embedder = embedder
    if (embedder?.fingerprint() !== before) {
      this.index = undefined
      this.indexFingerprint = undefined
      this.backfillError = null
      if (embedder !== null) this.repo.setMeta('embedding_fingerprint', embedder.fingerprint())
    }
    void this.backfill()
  }

  /**
   * Embedding configuration and backfill progress.
   * @returns the status.
   */
  embeddingStatus(): EmbeddingStatus {
    const fingerprint = this.embedder?.fingerprint() ?? null
    const progress = fingerprint === null ? { done: 0, total: 0 } : this.repo.vectorProgress(fingerprint)
    return { configured: this.embedder !== null, fingerprint, ...progress, running: this.backfillRun !== undefined, lastError: this.backfillError }
  }

  /**
   * Embed every memory lacking a current vector, in batches that yield to the event loop and pause while a reply is running.
   * @returns when the queue is empty, the embedder changed, or a batch failed {@link EMBED_MAX_ATTEMPTS} times.
   */
  backfill(): Promise<void> {
    if (this.backfillRun !== undefined) return this.backfillRun
    if (this.embedder === null) return Promise.resolve()
    const run = this.runBackfill(this.embedder).finally(() => { if (this.backfillRun === run) this.backfillRun = undefined })
    this.backfillRun = run
    return run
  }

  private async runBackfill(embedder: Embedder): Promise<void> {
    const fingerprint = embedder.fingerprint()
    try {
      for (;;) {
        if (this.disposed || this.embedder !== embedder) return
        while (this.ports.busy?.() === true && !this.disposed) await sleep(500)
        const batch = this.repo.missingVectors(fingerprint, EMBED_BATCH)
        if (batch.length === 0) return
        let vectors: Float32Array[] | undefined
        for (let attempt = 0; attempt < EMBED_MAX_ATTEMPTS && vectors === undefined; attempt++) {
          try {
            vectors = await embedWithin(embedder, batch.map(item => item.content), EMBED_BATCH_TIMEOUT_MS)
          } catch (error) {
            this.backfillError = error instanceof Error ? error.message : String(error)
            this.ports.logger.warn('embedding batch failed (attempt %d): %s', attempt + 1, this.backfillError)
            await sleep(Math.min(30_000, 1000 * 2 ** attempt))
            if (this.disposed || this.embedder !== embedder) return
          }
        }
        if (vectors === undefined) return
        this.backfillError = null
        this.repo.transaction(() => batch.forEach((item, i) => this.repo.putVector(item.id, fingerprint, vectors[i]!)))
        if (this.index !== undefined && this.indexFingerprint === fingerprint) {
          const current = this.repo.getMany(batch.map(item => item.id))
          batch.forEach((item, i) => {
            const status = current.get(item.id)?.status
            if (status === 'active' || status === 'faded') this.index!.upsert(item.id, vectors[i]!)
          })
        }
        await yieldToLoop()
      }
    } catch (error) {
      this.backfillError = error instanceof Error ? error.message : String(error)
      this.ports.logger.warn('embedding backfill stopped: %s', this.backfillError)
    }
  }

  /**
   * Send one sample text to the embedding endpoint.
   * @param embedder - the embedder to test.
   * @returns the vector dimension and the elapsed time.
   */
  async testEmbedding(embedder: Embedder): Promise<{ dimension: number; ms: number }> {
    const started = performance.now()
    const [vector] = await embedWithin(embedder, ['用户下周三有一场面试。'], EMBED_BATCH_TIMEOUT_MS)
    return { dimension: vector?.length ?? 0, ms: Math.round(performance.now() - started) }
  }

  private vectorIndex(): VectorIndex | undefined {
    if (this.embedder === null) return undefined
    const fingerprint = this.embedder.fingerprint()
    if (this.index !== undefined && this.indexFingerprint === fingerprint) return this.index
    let index: VectorIndex | undefined
    this.repo.eachVector(fingerprint, RECALL_STATUSES, (id, vector) => {
      index ??= new VectorIndex(vector.length)
      if (vector.length === index.dim) index.upsert(id, vector)
    })
    if (index === undefined) return undefined
    this.index = index
    this.indexFingerprint = fingerprint
    return index
  }

  private async embedOne(text: string, ms: number, signal?: AbortSignal): Promise<Float32Array | undefined> {
    if (this.embedder === null) return undefined
    try {
      const [vector] = await embedWithin(this.embedder, [text], ms, signal)
      return vector
    } catch (error) {
      this.ports.logger.info('query embedding skipped: %s', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  private async embedNew(ids: readonly number[]): Promise<void> {
    if (this.embedder === null || ids.length === 0) return
    const embedder = this.embedder
    const memories = this.repo.getMany(ids)
    const items = ids.flatMap(id => { const m = memories.get(id); return m === undefined ? [] : [m] })
    try {
      const vectors = await embedWithin(embedder, items.map(m => m.content), EMBED_BATCH_TIMEOUT_MS)
      if (this.embedder !== embedder) return
      const fingerprint = embedder.fingerprint()
      this.repo.transaction(() => items.forEach((m, i) => this.repo.putVector(m.id, fingerprint, vectors[i]!)))
      items.forEach((m, i) => this.indexUpsert(m.id, vectors[i]!))
    } catch (error) {
      this.ports.logger.info('embedding new memories deferred to backfill: %s', error instanceof Error ? error.message : String(error))
    }
  }

  private indexUpsert(id: number, vector: Float32Array): void {
    if (this.index !== undefined && this.index.dim === vector.length) this.index.upsert(id, vector)
  }

  private indexSync(memory: Memory): void {
    if (this.index === undefined) return
    if (memory.status !== 'active' && memory.status !== 'faded') {
      this.index.remove(memory.id)
      return
    }
    if (!this.index.has(memory.id) && this.indexFingerprint !== undefined) {
      const vector = this.repo.vectorOf(memory.id, this.indexFingerprint)
      if (vector !== undefined) this.indexUpsert(memory.id, vector)
    }
  }

  // ── recall ──────────────────────────────────────────────────

  /**
   * Build the injection for one turn. Never throws for retrieval problems; a
   * missing or slow embedding degrades to keyword-only.
   * @param request - turn context.
   * @returns the injection and its bookkeeping.
   */
  async recall(request: RecallRequest): Promise<RecallResult> {
    this.lastActivity = Date.now()
    const settings = this.ports.settings()
    const empty: RecallResult = { text: '', injectedIds: [], offer: undefined, elapsedMs: 0, usedVectors: false, considered: [] }
    if (settings.paused) return empty
    const now = this.ports.clock.now()
    const lastTurnKey = `last_turn_at:${request.scope}`
    const lastTurnAt = this.repo.meta(lastTurnKey)
    this.repo.setMeta(lastTurnKey, now.toISOString())

    const wantVectors = !this.skipVectorsNextTurn
    this.skipVectorsNextTurn = false
    const query = wantVectors && request.userText.trim() !== '' ? await this.embedOne(request.userText, settings.embeddingTimeoutMs, request.signal) : undefined
    const started = performance.now()
    const keywordIds = this.repo.keywordSearch(request.userText, RETRIEVAL_DEPTH, RECALL_STATUSES, request.scopes)
    const index = query === undefined ? undefined : this.vectorIndex()
    const usable = index !== undefined && query !== undefined && query.length === index.dim
    let vectorHits: readonly { id: number; score: number }[] = []
    if (usable) {
      try {
        vectorHits = await index.searchAsync(query, RETRIEVAL_DEPTH)
      } catch (error) {
        this.ports.logger.warn('vector search failed; keywords only: %s', error instanceof Error ? error.message : String(error))
      }
    }
    const similarities = new Map(vectorHits.map(hit => [hit.id, hit.score]))
    const fused = reciprocalRankFusion([keywordIds, vectorHits.map(hit => hit.id)])
    const memories = this.repo.getMany([...fused.keys()])
    const today = calendarDay(now, this.ports.clock)
    const lineOf = (memory: Memory, echo: boolean): string => renderLine(memory, {
      echo, previous: memory.supersedes === null ? undefined : this.repo.get(memory.supersedes), prompts: this.ports.prompts, today, clock: this.ports.clock,
    })
    const considered = selectRecall({
      fused, memories, keywordIds: new Set(keywordIds),
      similarity: id => similarities.get(id) ?? (usable ? index.similarity(id, query) : undefined),
      userText: request.userText, scopes: request.scopes, injected: request.injected,
      count: settings.recallCount, budget: settings.injectBudget, now, render: lineOf,
    })
    const chosen = considered.filter(item => item.filtered === null)
    const parts = [renderRecallBlock(chosen.map(item => lineOf(item.memory, item.echo)), this.ports.prompts)]

    let offer: Offer | undefined
    if (shouldOffer(settings.proactive, request.firstTurn, lastTurnAt, request.offeredThisSession, now)) {
      const reminisceBefore = settings.proactive === 'normal' ? new Date(now.getTime() - REMINISCE_MIN_AGE_DAYS * 86_400_000).toISOString() : null
      const pool = this.repo.proactivePool(request.scopes, formatDate(addDays(today, -FOLLOW_UP_WINDOW_DAYS)), formatDate(today), reminisceBefore)
        .filter(m => !chosen.some(c => c.memory.id === m.id))
      offer = pickOffer(pool, id => this.repo.mentionsOf(id), settings.proactive, today, now)
      if (offer !== undefined) parts.push(renderProactiveBlock(lineOf(offer.memory, false), this.ports.prompts))
    }

    const elapsedMs = performance.now() - started
    if (usable && elapsedMs > RECALL_BUDGET_MS) {
      this.skipVectorsNextTurn = true
      this.ports.logger.warn('recall took %d ms over %d memories; next turn uses keywords only', Math.round(elapsedMs), index.size)
    }
    const at = now.toISOString()
    this.repo.logRecall(considered.map(item => ({
      sessionId: request.sessionId, turn: request.turn, memoryId: item.memory.id, score: item.score,
      reason: describeReason(item), filtered: item.filtered, createdAt: at,
    })))
    return {
      text: parts.filter(part => part !== '').join('\n\n'),
      injectedIds: chosen.map(item => item.memory.id),
      offer, elapsedMs, usedVectors: usable, considered,
    }
  }

  /**
   * Resident system-prompt section: usage rules plus pinned and high-importance profile memories.
   * @param scopes - visible scopes.
   * @param limit - character cap of the memory part.
   * @returns the section text; stable until a memory changes.
   */
  residentSection(scopes: readonly string[], limit = 400): string {
    const key = scopes.join('\n')
    if (this.residentCache?.version === this.version && this.residentCache.scopes === key) return this.residentCache.text
    const pool = this.repo.residentPool(scopes, 50)
    const lines: string[] = []
    let used = 0
    for (const memory of pool) {
      const line = `- ${escapeForPrompt(memory.content)}`
      if (used + line.length > limit) break
      lines.push(line)
      used += line.length
    }
    const profile = lines.length === 0 ? '' : `\n\n关于用户的基本情况（长期有效）：\n${lines.join('\n')}`
    const text = `${this.ports.prompts.residentRules}${profile}`
    this.residentCache = { version: this.version, scopes: key, text }
    return text
  }

  // ── extraction ──────────────────────────────────────────────

  /**
   * Queue a finished turn. Trivial turns are dropped here.
   * @param sessionId - session id.
   * @param payload - the turn.
   */
  enqueueTurn(sessionId: string, payload: TurnPayload): void {
    this.lastActivity = Date.now()
    if (this.ports.settings().paused || isSkippableTurn(payload)) return
    this.repo.enqueue(sessionId, payload.turn, JSON.stringify(payload), this.ports.clock.now())
    this.lastEnqueue.set(sessionId, Date.now())
    void this.pump()
  }

  /**
   * Extract every session that is due: {@link EXTRACT_BATCH_TURNS} queued
   * turns, {@link EXTRACT_IDLE_MS} of quiet, or listed in `flush`. One
   * extraction runs at a time.
   * @param flush - sessions to extract now regardless of size.
   * @returns when this pass finishes.
   */
  async pump(flush: ReadonlySet<string> = new Set()): Promise<void> {
    if (this.extracting !== undefined) {
      await this.extracting
      if (flush.size === 0) return
    }
    const run = this.runExtraction(flush)
    this.extracting = run
    try {
      await run
    } finally {
      if (this.extracting === run) this.extracting = undefined
    }
  }

  private async runExtraction(flush: ReadonlySet<string>): Promise<void> {
    const now = this.ports.clock.now()
    for (const [sessionId, items] of this.repo.dueQueue(now)) {
      if (this.disposed) return
      const quietMs = Date.now() - (this.lastEnqueue.get(sessionId) ?? 0)
      if (!flush.has(sessionId) && items.length < EXTRACT_BATCH_TURNS && quietMs < EXTRACT_IDLE_MS) continue
      if (!this.takeDailyQuota()) {
        this.ports.logger.warn('daily extraction limit reached; %d turns stay queued', items.length)
        return
      }
      try {
        const turns = items.map(item => JSON.parse(item.payload) as TurnPayload)
        await this.extractTurns(sessionId, turns)
        this.repo.dequeue(items.map(item => item.id))
      } catch (error) {
        const attempts = Math.max(...items.map(item => item.attempts)) + 1
        this.ports.logger.warn('extraction failed for %d turns (attempt %d): %s', items.length, attempts, error instanceof Error ? error.message : String(error))
        if (attempts >= EXTRACT_MAX_ATTEMPTS) this.repo.dequeue(items.map(item => item.id))
        else this.repo.retryLater(items.map(item => item.id), new Date(now.getTime() + 60_000 * 2 ** attempts))
      }
      await yieldToLoop()
    }
  }

  private takeDailyQuota(): boolean {
    const day = formatDate(calendarDay(this.ports.clock.now(), this.ports.clock))
    const key = `extract_count:${day}`
    const used = Number(this.repo.meta(key) ?? '0')
    if (used >= this.ports.settings().dailyExtractLimit) return false
    this.repo.setMeta(key, String(used + 1))
    return true
  }

  /**
   * Extract and write one batch of turns of one session.
   * @param sessionId - session id.
   * @param turns - turns, oldest first.
   * @returns ids of memories written or reinforced.
   */
  async extractTurns(sessionId: string, turns: readonly TurnPayload[]): Promise<number[]> {
    if (turns.length === 0) return []
    const scope = turns[turns.length - 1]!.scope
    const now = this.ports.clock.now()
    const today = calendarDay(now, this.ports.clock)
    const related = this.relatedFor(turns.map(turn => turn.user).join('\n'), [scope, 'global'])
    const latest = this.repo.latestMention(sessionId)
    const pending = latest !== undefined && latest.responded === null
      ? [{ memoryId: latest.memoryId, content: this.repo.get(latest.memoryId)?.content ?? '' }] : []
    const input = buildExtractInput(turns, related, pending, `${formatDate(today)} ${DAY_NAMES[weekdayOf(today)]}`)
    const raw = await this.ports.llm.complete({ system: this.ports.prompts.extractSystem, user: input, json: true, sessionId })
    let extraction = parseExtraction(raw)
    const failing = extraction.candidates.map(c => checkCandidate(c, turns))
    if (failing.some(problems => problems.length > 0)) {
      const report = extraction.candidates.flatMap((c, i) => failing[i]!.length === 0 ? [] : [`- ${JSON.stringify(c.content)}：${failing[i]!.map(p => PROBLEM_TEXT[p]).join('；')}`])
      const retry = await this.ports.llm.complete({
        system: this.ports.prompts.extractSystem,
        user: `${input}\n\n上一次的输出：\n${raw}\n\n${this.ports.prompts.rewriteSystem}\n${report.join('\n')}`,
        json: true, sessionId,
      })
      const rewritten = parseExtraction(retry)
      const kept = rewritten.candidates.filter(c => {
        const problems = checkCandidate(c, turns)
        if (problems.length > 0) this.ports.logger.info('dropped a candidate after rewrite: %s', problems.join(','))
        return problems.length === 0
      })
      extraction = { candidates: kept, proactive: extraction.proactive.length > 0 ? extraction.proactive : rewritten.proactive }
    }
    for (const verdict of extraction.proactive) this.applyProactiveVerdict(sessionId, scope, verdict.memoryId, verdict.mentioned, verdict.engaged, now)
    const relatedIds = new Set(related.map(m => m.id))
    const blocked = new Set<Candidate>()
    for (const candidate of extraction.candidates) if (await this.isSuppressedByVector(candidate.content)) blocked.add(candidate)
    if (blocked.size > 0) this.ports.logger.info('skipped %d candidates close to forgotten memories', blocked.size)
    const written = this.repo.transaction(() => extraction.candidates.filter(c => !blocked.has(c)).flatMap(candidate => {
      const id = this.writeCandidate(candidate, { sessionId, turn: turns[turns.length - 1]!.turn, scope, relatedIds, now })
      return id === undefined ? [] : [id]
    }))
    if (written.length > 0) this.version++
    this.ports.logger.info('extracted %d memories from %d turns', written.length, turns.length)
    await this.embedNew(written)
    return written
  }

  private applyProactiveVerdict(sessionId: string, scope: string, memoryId: number, mentioned: boolean, engaged: boolean | null, now: Date): void {
    const latest = this.repo.latestMention(sessionId)
    const isPending = latest !== undefined && latest.memoryId === memoryId && latest.responded === null
    if (!isPending && mentioned && this.repo.get(memoryId) !== undefined) this.repo.logProactive(memoryId, sessionId, scope, now)
    if (engaged !== null && (isPending || mentioned)) this.repo.resolveProactive(sessionId, engaged)
  }

  private relatedFor(text: string, scopes: readonly string[]): Memory[] {
    const ids = this.repo.keywordSearch(text, EXTRACT_RELATED, RECALL_STATUSES, scopes)
    const memories = this.repo.getMany(ids)
    return ids.flatMap(id => memories.get(id) ?? [])
  }

  private writeCandidate(candidate: Candidate, context: { sessionId: string; turn: number; scope: string; relatedIds: ReadonlySet<number>; now: Date }): number | undefined {
    if (looksLikeSecret(candidate.content)) return undefined
    if (this.isSuppressed(candidate.content, candidate.factKey)) {
      this.ports.logger.info('skipped a candidate matching a forgotten memory')
      return undefined
    }
    const target = candidate.target === null ? undefined : this.repo.get(candidate.target)
    const targetIsCurrent = target !== undefined && (target.status === 'active' || target.status === 'faded')
    if (candidate.action === 'same' && targetIsCurrent) return this.reinforce(target, context.now)
    const today = calendarDay(context.now, this.ports.clock)
    const fields = {
      content: candidate.content,
      kind: candidate.kind,
      factKey: candidate.factKey,
      people: candidate.people,
      occurredAt: candidate.occurred === null ? null : resolveDate(candidate.occurred, today, 'nearest') ?? null,
      followUpAt: candidate.followUp === null ? null : resolveDate(candidate.followUp, today, 'future') ?? null,
      importance: candidate.importance,
      emotion: candidate.emotion,
      sensitive: candidate.sensitive,
      needsConfirm: candidate.uncertain,
      sourceSession: context.sessionId,
      sourceTurn: context.turn,
      scope: context.scope,
    }
    if (candidate.action === 'update' && targetIsCurrent) {
      const created = this.repo.insert({ ...fields, factKey: fields.factKey ?? target.factKey, sensitive: fields.sensitive || target.sensitive, pinned: target.pinned, mentionBlocked: target.mentionBlocked }, context.now)
      this.repo.supersede(target.id, created.id, context.now)
      this.indexSync(this.repo.require(target.id))
      return created.id
    }
    const tokens = tokenize(candidate.content)
    if (candidate.factKey !== null) {
      const current = this.repo.currentByFactKey(candidate.factKey, [context.scope])
      const same = current.find(m => jaccard(tokenize(m.content), tokens) >= DUPLICATE_OVERLAP)
      if (same !== undefined) return this.reinforce(same, context.now)
      if (current.length > 0 && !candidate.uncertain) {
        const created = this.repo.insert(fields, context.now)
        for (const old of current) {
          this.repo.supersede(old.id, created.id, context.now)
          this.indexSync(this.repo.require(old.id))
        }
        return created.id
      }
    }
    const duplicate = this.repo.keywordSearch(candidate.content, 5, RECALL_STATUSES, [context.scope])
      .map(id => this.repo.get(id)!)
      .find(m => m.kind === candidate.kind && jaccard(tokenize(m.content), tokens) >= DUPLICATE_OVERLAP)
    if (duplicate !== undefined) return this.reinforce(duplicate, context.now)
    return this.repo.insert(fields, context.now).id
  }

  private reinforce(memory: Memory, now: Date): number {
    this.repo.update(memory.id, {
      strength: Math.min(MAX_STRENGTH, memory.strength + REINFORCE_STEP),
      reinforcedAt: now.toISOString(),
      status: 'active',
    }, now)
    this.indexSync(this.repo.require(memory.id))
    return memory.id
  }

  private isSuppressed(content: string, factKey: string | null): boolean {
    const suppressions = this.repo.suppressions()
    if (suppressions.length === 0) return false
    const tokens = tokenize(content)
    return suppressions.some(s => (factKey !== null && s.factKey === factKey) || jaccard(tokenize(s.summary), tokens) >= SUPPRESS_OVERLAP)
  }

  /**
   * Whether new text matches a forgotten memory by vector similarity.
   * @param content - candidate text.
   * @returns `true` when a suppression vector is close.
   */
  async isSuppressedByVector(content: string): Promise<boolean> {
    if (this.embedder === null) return false
    const fingerprint = this.embedder.fingerprint()
    const suppressions = this.repo.suppressions().filter(s => s.vector !== null && s.fingerprint === fingerprint)
    if (suppressions.length === 0) return false
    const vector = await this.embedOne(content, EMBED_BATCH_TIMEOUT_MS)
    return vector !== undefined && suppressions.some(s => s.vector!.length === vector.length && cosine(s.vector!, vector) >= SUPPRESS_SIMILARITY)
  }

  // ── tools and manual operations ─────────────────────────────

  /**
   * Search including archived and superseded memories.
   * @param text - query.
   * @param scopes - visible scopes.
   * @param limit - result cap.
   * @returns memories, best first, each with its predecessors.
   */
  async search(text: string, scopes: readonly string[], limit = 10): Promise<{ memory: Memory; history: Memory[] }[]> {
    const keywordIds = this.repo.keywordSearch(text, RETRIEVAL_DEPTH, SEARCH_STATUSES, scopes)
    const query = await this.embedOne(text, this.ports.settings().embeddingTimeoutMs)
    const index = query === undefined ? undefined : this.vectorIndex()
    const vectorIds = index !== undefined && query !== undefined && query.length === index.dim ? (await index.searchAsync(query, RETRIEVAL_DEPTH)).map(hit => hit.id) : []
    const fused = [...reciprocalRankFusion([keywordIds, vectorIds]).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    const memories = this.repo.getMany(fused)
    return fused.flatMap(id => {
      const memory = memories.get(id)
      if (memory === undefined || !scopes.includes(memory.scope) || memory.status === 'deleted') return []
      return [{ memory, history: this.repo.history(id) }]
    }).slice(0, limit)
  }

  /**
   * Save a memory the user explicitly asked to keep; pinned by default.
   * @param request - content and options.
   * @returns the stored memory.
   */
  async save(request: SaveRequest): Promise<Memory> {
    const now = this.ports.clock.now()
    const today = calendarDay(now, this.ports.clock)
    const memory = this.repo.transaction(() => this.repo.insert({
      content: request.content.trim(),
      kind: request.kind ?? 'shared',
      sensitive: request.sensitive ?? false,
      pinned: request.pinned ?? true,
      importance: 3,
      followUpAt: request.followUp === undefined || request.followUp === null ? null : resolveDate(request.followUp, today, 'future') ?? null,
      sourceSession: request.sessionId ?? null,
      scope: request.scope,
    }, now))
    this.version++
    await this.embedNew([memory.id])
    return memory
  }

  /**
   * Replace a memory's content; the old version stays in the supersede chain.
   * @param id - memory id.
   * @param content - corrected content.
   * @returns the new current memory.
   */
  async correct(id: number, content: string): Promise<Memory> {
    const now = this.ports.clock.now()
    const old = this.repo.require(id)
    const created = this.repo.transaction(() => {
      const next = this.repo.insert({
        content: content.trim(), kind: old.kind, factKey: old.factKey, people: old.people, occurredAt: old.occurredAt,
        followUpAt: old.followUpAt, importance: old.importance, emotion: old.emotion, sensitive: old.sensitive,
        pinned: old.pinned, mentionBlocked: old.mentionBlocked, sourceSession: old.sourceSession, sourceTurn: old.sourceTurn, scope: old.scope,
      }, now)
      this.repo.supersede(old.id, next.id, now)
      return next
    })
    this.indexSync(this.repo.require(old.id))
    this.version++
    await this.embedNew([created.id])
    return created
  }

  /**
   * Forget: archive the memory and record a suppression so it is never recalled or extracted again.
   * @param id - memory id.
   * @returns the archived memory.
   */
  async forget(id: number): Promise<Memory> {
    const now = this.ports.clock.now()
    const memory = this.repo.require(id)
    const fingerprint = this.embedder?.fingerprint() ?? null
    const vector = fingerprint === null ? undefined : this.repo.vectorOf(id, fingerprint)
    this.repo.transaction(() => {
      this.repo.update(id, { status: 'archived', mentionBlocked: true }, now)
      this.repo.addSuppression(memory.content, memory.factKey, vector === undefined ? null : fingerprint, vector ?? null, now)
    })
    const archived = this.repo.require(id)
    this.indexSync(archived)
    this.version++
    return archived
  }

  /**
   * Edit flags or fields from the management page.
   * @param id - memory id.
   * @param patch - changed fields; content changes re-embed.
   * @returns the updated memory.
   */
  async patch(id: number, patch: MemoryPatch): Promise<Memory> {
    const now = this.ports.clock.now()
    const updated = this.repo.transaction(() => this.repo.update(id, patch, now))
    this.indexSync(updated)
    this.version++
    if (patch.content !== undefined) await this.embedNew([id])
    return updated
  }

  /**
   * Move to the trash.
   * @param id - memory id.
   */
  remove(id: number): void {
    this.repo.softDelete(id, this.ports.clock.now())
    this.indexSync(this.repo.require(id))
    this.version++
  }

  /**
   * Restore from trash or archive.
   * @param id - memory id.
   */
  restore(id: number): void {
    this.repo.restore(id, this.ports.clock.now())
    this.indexSync(this.repo.require(id))
    this.version++
  }

  /**
   * Delete permanently with vector and index rows.
   * @param id - memory id.
   */
  purge(id: number): void {
    this.repo.transaction(() => this.repo.purge(id))
    this.index?.remove(id)
    this.version++
  }

  /**
   * One page for the management page.
   * @param query - filters and window.
   * @returns the page.
   */
  list(query: ListQuery): { items: Memory[]; total: number } {
    return this.repo.list(query)
  }

  /**
   * Everything the detail view shows.
   * @param id - memory id.
   * @returns the detail, or `undefined`.
   */
  detail(id: number): MemoryDetail | undefined {
    const memory = this.repo.get(id)
    if (memory === undefined) return undefined
    return {
      memory,
      history: this.repo.history(id),
      successor: memory.supersededBy === null ? undefined : this.repo.get(memory.supersededBy),
      recalls: this.repo.recallsOf(id, 50),
      mentions: this.repo.mentionsOf(id).map(m => ({ mentionedAt: m.mentionedAt, sessionId: m.sessionId, responded: m.responded })),
      strength: Math.round(currentStrength(memory, this.ports.clock.now()) * 100) / 100,
    }
  }

  /**
   * Record the turn's proactive offer as a pending mention.
   * @param sessionId - session id.
   * @param scope - session scope.
   * @param memoryId - offered memory.
   */
  noteOffer(sessionId: string, scope: string, memoryId: number): void {
    this.repo.logProactive(memoryId, sessionId, scope, this.ports.clock.now())
  }

  // ── lifecycle ───────────────────────────────────────────────

  /**
   * Whether consolidation is due: every session quiet for {@link CONSOLIDATE_IDLE_MS} and none ran in the last day.
   * @returns `true` when {@link consolidate} should run.
   */
  consolidationDue(): boolean {
    return Date.now() - this.lastActivity >= CONSOLIDATE_IDLE_MS && Date.now() - this.lastConsolidation >= 86_400_000
  }

  /**
   * Idle maintenance: state transitions, recall log and trash retention,
   * flushing the extraction queue, vector backfill, and incremental vacuum.
   * @returns counts of what changed.
   */
  async consolidate(): Promise<{ faded: number; archived: number; purged: number; prunedLogs: number }> {
    this.lastConsolidation = Date.now()
    const now = this.ports.clock.now()
    let faded = 0
    let archived = 0
    const changed: Memory[] = []
    this.repo.transaction(() => {
      for (const memory of this.repo.byStatus(RECALL_STATUSES)) {
        if (isDecayExempt(memory)) continue
        const next = decayedStatus(memory, now)
        if (next === memory.status) continue
        if (next === 'faded') faded++
        if (next === 'archived') archived++
        changed.push(this.repo.update(memory.id, { status: next }, now))
      }
    })
    for (const memory of changed) this.indexSync(memory)
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000)
    const prunedLogs = this.repo.pruneRecallLog(cutoff)
    const trash = this.repo.trashedBefore(cutoff)
    this.repo.transaction(() => trash.forEach(id => this.repo.purge(id)))
    for (const id of trash) this.index?.remove(id)
    if (changed.length > 0 || trash.length > 0) this.version++
    await this.pump(new Set(this.repo.dueQueue(now).keys()))
    void this.backfill()
    try {
      this.ports.db.exec('PRAGMA incremental_vacuum')
    } catch (error) {
      this.ports.logger.debug('incremental vacuum skipped: %s', error instanceof Error ? error.message : String(error))
    }
    return { faded, archived, purged: trash.length, prunedLogs }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms).unref?.())

const describeReason = (item: Scored): string => {
  const parts: string[] = []
  if (item.keywordHit) parts.push('关键词命中')
  if (item.similarity !== undefined) parts.push(`语义相似度 ${item.similarity.toFixed(2)}`)
  if (item.echo) parts.push('用户正在复述')
  if (item.memory.sensitive) parts.push('敏感')
  return parts.join('，')
}
