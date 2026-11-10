/**
 * Per-session bookkeeping between DSH events and the engine: which memories a
 * session already saw, whether it had its proactive offer, and the text of the
 * turn in progress. Kept free of Cordis so tests can drive it directly.
 */

import type { MemoryEngine, TurnPayload } from '@her-os/memory-core'
import type { SessionScope } from './config.ts'
import type { ModelRoute } from './llm.ts'

/** What a session needs from the plugin over its lifetime. */
export interface SessionState {
  readonly sessionId: string
  readonly scope: SessionScope
  readonly injected: Set<number>
  offered: boolean
  recalls: number
  lastRecallTurn: number | undefined
  route: ModelRoute | undefined
  /** Offer of the current turn, reported with the turn for extraction. */
  pendingOffer: { memoryId: number; content: string } | undefined
  turn: TurnBuffer | undefined
}

/** Text of one turn as it streams in. */
interface TurnBuffer {
  readonly turn: number
  user: string[]
  assistant: string[]
  images: number
  files: string[]
}

/** One content block as the plugin reads it. */
export interface Block {
  readonly type: string
  readonly text?: string
  readonly attachment?: unknown
}

/** Result of one recall for injection. */
export interface Injection {
  readonly text: string
  readonly elapsedMs: number
}

/** Longest assistant text kept per turn for extraction. */
export const ASSISTANT_KEEP_CHARS = 4000

const textOf = (blocks: readonly Block[]): string => blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')

const fileName = (block: Block): string => {
  const attachment = block.attachment as { name?: unknown; filename?: unknown } | undefined
  const name = attachment?.name ?? attachment?.filename
  return typeof name === 'string' && name !== '' ? name : 'file'
}

/** Session table plus the event-to-engine glue. */
export class MemoryRuntime {
  private readonly sessions = new Map<string, SessionState>()
  private readonly running = new Set<string>()
  private readonly engine: MemoryEngine
  private readonly paused: () => boolean

  /**
   * @param engine - the memory engine.
   * @param paused - whether memory is switched off now.
   */
  constructor(engine: MemoryEngine, paused: () => boolean) {
    this.engine = engine
    this.paused = paused
  }

  /** Whether any session is producing a reply. */
  busy(): boolean {
    return this.running.size > 0
  }

  /**
   * Start tracking a main session.
   * @param sessionId - session id.
   * @param scope - its write and visible scopes.
   * @param route - its model, when known.
   * @returns the state.
   */
  open(sessionId: string, scope: SessionScope, route: ModelRoute | undefined): SessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (route !== undefined) existing.route = route
      return existing
    }
    const state: SessionState = {
      sessionId, scope, injected: new Set(), offered: false, recalls: 0, lastRecallTurn: undefined,
      route, pendingOffer: undefined, turn: undefined,
    }
    this.sessions.set(sessionId, state)
    return state
  }

  /**
   * Stop tracking a session and extract what it left queued.
   * @param sessionId - session id.
   */
  close(sessionId: string): void {
    this.running.delete(sessionId)
    if (!this.sessions.delete(sessionId)) return
    void this.engine.pump(new Set([sessionId]))
  }

  /**
   * The tracked state.
   * @param sessionId - session id.
   * @returns the state, or `undefined` for untracked sessions.
   */
  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Known model route of a session.
   * @param sessionId - session id.
   * @returns the route, or `undefined`.
   */
  routeOf(sessionId: string | undefined): ModelRoute | undefined {
    if (sessionId !== undefined) {
      const route = this.sessions.get(sessionId)?.route
      if (route !== undefined) return route
    }
    for (const state of this.sessions.values()) if (state.route !== undefined) return state.route
    return undefined
  }

  /**
   * Record a running/idle flip.
   * @param sessionId - session id.
   * @param running - whether a reply is in progress.
   */
  status(sessionId: string, running: boolean): void {
    if (running) this.running.add(sessionId)
    else this.running.delete(sessionId)
  }

  /**
   * Recall for the first step of a turn.
   * @param sessionId - session id.
   * @param turn - turn number.
   * @param userBlocks - content of the user messages entering the step.
   * @param signal - turn cancellation.
   * @returns the block to inject, or `undefined` when nothing applies.
   */
  async recall(sessionId: string, turn: number, userBlocks: readonly Block[], signal?: AbortSignal): Promise<Injection | undefined> {
    const state = this.sessions.get(sessionId)
    if (state === undefined || this.paused() || state.lastRecallTurn === turn) return undefined
    const userText = textOf(userBlocks).trim()
    if (userText === '') return undefined
    state.lastRecallTurn = turn
    const result = await this.engine.recall({
      sessionId, turn, userText, scope: state.scope.scope, scopes: state.scope.scopes, injected: state.injected,
      firstTurn: state.recalls === 0, offeredThisSession: state.offered, ...(signal === undefined ? {} : { signal }),
    })
    state.recalls++
    for (const id of result.injectedIds) state.injected.add(id)
    if (result.offer !== undefined) {
      state.offered = true
      state.pendingOffer = { memoryId: result.offer.memory.id, content: result.offer.memory.content }
      this.engine.noteOffer(sessionId, state.scope.scope, result.offer.memory.id)
    }
    return result.text === '' ? undefined : { text: result.text, elapsedMs: result.elapsedMs }
  }

  /**
   * A turn opened.
   * @param sessionId - session id.
   * @param turn - turn number.
   */
  turnStart(sessionId: string, turn: number): void {
    const state = this.sessions.get(sessionId)
    if (state !== undefined) state.turn = { turn, user: [], assistant: [], images: 0, files: [] }
  }

  /**
   * A user message entered the session; only messages the user typed count.
   * @param sessionId - session id.
   * @param sourceKind - the message's source kind.
   * @param blocks - its content.
   */
  userMessage(sessionId: string, sourceKind: string, blocks: readonly Block[]): void {
    const buffer = this.sessions.get(sessionId)?.turn
    if (buffer === undefined || sourceKind !== 'user') return
    const text = textOf(blocks)
    if (text.trim() !== '') buffer.user.push(text)
    for (const block of blocks) {
      if (block.type === 'image') buffer.images++
      else if (block.type === 'file') buffer.files.push(fileName(block))
    }
  }

  /**
   * An assistant message was committed.
   * @param sessionId - session id.
   * @param blocks - its content.
   */
  assistantMessage(sessionId: string, blocks: readonly Block[]): void {
    const buffer = this.sessions.get(sessionId)?.turn
    if (buffer === undefined) return
    const text = textOf(blocks)
    if (text.trim() !== '') buffer.assistant.push(text)
  }

  /**
   * A turn closed: queue it for extraction.
   * @param sessionId - session id.
   * @param turn - turn number.
   * @param at - end instant.
   */
  turnEnd(sessionId: string, turn: number, at: Date): void {
    const state = this.sessions.get(sessionId)
    const buffer = state?.turn
    if (state === undefined || buffer === undefined || buffer.turn !== turn) return
    state.turn = undefined
    const offer = state.pendingOffer
    state.pendingOffer = undefined
    if (buffer.user.length === 0 && buffer.images === 0 && buffer.files.length === 0) return
    let assistant = buffer.assistant.join('\n')
    if (assistant.length > ASSISTANT_KEEP_CHARS) assistant = assistant.slice(-ASSISTANT_KEEP_CHARS)
    const payload: TurnPayload = {
      turn, at: at.toISOString(), user: buffer.user.join('\n'), assistant, scope: state.scope.scope,
      ...(buffer.images > 0 ? { images: buffer.images } : {}),
      ...(buffer.files.length > 0 ? { files: buffer.files } : {}),
      ...(offer === undefined ? {} : { proactive: offer }),
    }
    this.engine.enqueueTurn(sessionId, payload)
  }
}
