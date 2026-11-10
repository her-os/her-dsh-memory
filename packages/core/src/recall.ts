/**
 * Per-turn recall: filtering, the sensitive and echo rules, re-ranking, the
 * character budget, and the injection block text.
 */

import { currentStrength, freshness } from './lifecycle.ts'
import type { PromptPack } from './prompts.ts'
import { escapeForPrompt, tokenize } from './text.ts'
import { type CalendarDate, calendarDay, type Clock, parseDate, relativeLabel } from './time.ts'
import type { Memory } from './types.ts'

/** Vector similarity at which a sensitive memory counts as raised by the user. */
export const SENSITIVE_RAISE_SIMILARITY = 0.6

/** Vector similarity at which the user is restating a memory. */
export const ECHO_SIMILARITY = 0.9

/** Token coverage at which the user is restating a memory, when no vectors exist. */
export const ECHO_TOKEN_COVERAGE = 0.8

/** Why a candidate was left out of the block. */
export type FilterReason = 'status' | 'scope' | 'mention_blocked' | 'already_injected' | 'pinned_resident' | 'sensitive_not_raised' | 'rank' | 'budget'

/** One considered memory with its signals. */
export interface Scored {
  readonly memory: Memory
  /** Fused rank score times freshness, importance, and strength. */
  readonly score: number
  readonly keywordHit: boolean
  /** Cosine similarity with the query, when vectors exist. */
  readonly similarity: number | undefined
  readonly echo: boolean
  readonly filtered: FilterReason | null
}

/** Inputs of {@link selectRecall}. */
export interface SelectInput {
  readonly fused: ReadonlyMap<number, number>
  readonly memories: ReadonlyMap<number, Memory>
  readonly keywordIds: ReadonlySet<number>
  readonly similarity: (id: number) => number | undefined
  readonly userText: string
  readonly scopes: readonly string[]
  readonly injected: ReadonlySet<number>
  readonly count: number
  readonly budget: number
  readonly now: Date
  readonly render: (memory: Memory, echo: boolean) => string
}

const importanceFactor = (importance: number): number => 0.8 + 0.2 * (importance - 1)

/**
 * Score, filter, and cut the fused candidates.
 * @param input - candidates and turn context.
 * @returns every considered memory, chosen ones (`filtered === null`) first in score order.
 */
export function selectRecall(input: SelectInput): Scored[] {
  const userTokens = new Set(tokenize(input.userText))
  const all: Scored[] = []
  for (const [id, fusedScore] of input.fused) {
    const memory = input.memories.get(id)
    if (memory === undefined) continue
    const similarity = input.similarity(id)
    const keywordHit = input.keywordIds.has(id)
    const tokens = tokenize(memory.content)
    const coverage = tokens.length === 0 ? 0 : tokens.filter(token => userTokens.has(token)).length / tokens.length
    const echo = similarity === undefined ? coverage >= ECHO_TOKEN_COVERAGE : similarity >= ECHO_SIMILARITY
    const strength = Math.min(1.5, Math.max(0.3, currentStrength(memory, input.now)))
    const score = fusedScore * freshness(memory.learnedAt, input.now) * importanceFactor(memory.importance) * strength
    let filtered: FilterReason | null = null
    if (memory.status !== 'active' && memory.status !== 'faded') filtered = 'status'
    else if (!input.scopes.includes(memory.scope)) filtered = 'scope'
    else if (memory.mentionBlocked) filtered = 'mention_blocked'
    else if (input.injected.has(id)) filtered = 'already_injected'
    else if (memory.pinned) filtered = 'pinned_resident'
    else if (memory.sensitive && !keywordHit && (similarity ?? 0) < SENSITIVE_RAISE_SIMILARITY) filtered = 'sensitive_not_raised'
    all.push({ memory, score, keywordHit, similarity, echo, filtered })
  }
  all.sort((a, b) => b.score - a.score)
  let chosen = 0
  let used = 0
  return all.map(item => {
    if (item.filtered !== null) return item
    if (chosen >= input.count) return { ...item, filtered: 'rank' as const }
    const length = input.render(item.memory, item.echo).length
    if (used + length > input.budget) return { ...item, filtered: 'budget' as const }
    chosen++
    used += length
    return item
  }).sort((a, b) => Number(a.filtered !== null) - Number(b.filtered !== null))
}

/**
 * Render one memory line of the block.
 * @param memory - the memory.
 * @param options - echo flag, predecessor, prompts, today.
 * @returns the line, starting with `- `.
 */
export function renderLine(memory: Memory, options: { echo: boolean; previous?: Memory | undefined; prompts: PromptPack; today: CalendarDate; clock: Clock }): string {
  const tags: string[] = []
  const occurred = memory.occurredAt === null ? undefined : parseDate(memory.occurredAt)
  if (occurred !== undefined) tags.push(relativeLabel(occurred, options.today))
  else tags.push(`${relativeLabel(calendarDay(new Date(memory.learnedAt), options.clock), options.today)}得知`)
  if (memory.sensitive) tags.push(options.prompts.sensitiveTag)
  if (options.echo) tags.push(options.prompts.echoTag)
  if (memory.needsConfirm) tags.push(options.prompts.confirmTag)
  let text = escapeForPrompt(memory.content)
  const follow = memory.followUpAt === null ? undefined : parseDate(memory.followUpAt)
  if (follow !== undefined) text += `（跟进日：${follow.month} 月 ${follow.day} 日，${relativeLabel(follow, options.today)}）`
  if (options.previous !== undefined) {
    const since = calendarDay(new Date(memory.learnedAt), options.clock)
    text += `（${since.year}-${String(since.month).padStart(2, '0')}-${String(since.day).padStart(2, '0')} 起；之前：${escapeForPrompt(options.previous.content)}）`
  }
  return `- [${tags.join('；')}] ${text}`
}

/**
 * Wrap lines into the recall block.
 * @param lines - rendered memory lines.
 * @param prompts - prompt pack.
 * @returns the block, or an empty string when there are no lines.
 */
export function renderRecallBlock(lines: readonly string[], prompts: PromptPack): string {
  if (lines.length === 0) return ''
  return `<memory-recall>\n${prompts.recallHeader}\n${lines.join('\n')}\n</memory-recall>`
}

/**
 * Wrap a proactive candidate into its block.
 * @param line - the rendered memory line.
 * @param prompts - prompt pack.
 * @returns the block.
 */
export function renderProactiveBlock(line: string, prompts: PromptPack): string {
  return `<memory-followup>\n${prompts.proactiveHeader}\n${line}\n</memory-followup>`
}
