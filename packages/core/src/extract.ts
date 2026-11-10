/**
 * Extraction input building, model output parsing, and the rule-based accuracy
 * check. Nothing here writes to the database.
 */

import { MEMORY_KINDS } from './schema.ts'
import { cleanForExtraction, escapeForPrompt, IMAGE_PLACEHOLDER, isTrivialUserMessage, looksLikeSecret } from './text.ts'
import type { Memory, MemoryKind } from './types.ts'

/** One finished turn as queued for extraction. */
export interface TurnPayload {
  readonly turn: number
  /** ISO instant the turn ended. */
  readonly at: string
  readonly user: string
  readonly assistant: string
  /** Number of images the user attached. */
  readonly images?: number
  /** File names the user attached. */
  readonly files?: readonly string[]
  /** Memory offered for proactive mention this turn. */
  readonly proactive?: { readonly memoryId: number; readonly content: string }
  /** Scope the session wrote in. */
  readonly scope: string
}

/** One memory the model proposes. */
export interface Candidate {
  readonly action: 'add' | 'update' | 'same'
  readonly target: number | null
  readonly kind: MemoryKind
  readonly content: string
  readonly factKey: string | null
  readonly people: readonly string[]
  readonly occurred: string | null
  readonly followUp: string | null
  readonly importance: number
  readonly emotion: string | null
  readonly sensitive: boolean
  readonly uncertain: boolean
  readonly evidence: string
}

/** The model's verdict on one proactive mention. */
export interface ProactiveVerdict {
  readonly memoryId: number
  readonly mentioned: boolean
  readonly engaged: boolean | null
}

/** Parsed extraction output. */
export interface Extraction {
  readonly candidates: Candidate[]
  readonly proactive: ProactiveVerdict[]
}

/** Longest kept message length in extraction input. */
export const MAX_MESSAGE_CHARS = 1500

/**
 * Whether a turn carries nothing worth extracting.
 * @param turn - the queued turn.
 * @returns `true` for greetings, emoji, and code-only messages without images or files.
 */
export function isSkippableTurn(turn: TurnPayload): boolean {
  if ((turn.images ?? 0) > 0 || (turn.files?.length ?? 0) > 0 || turn.proactive !== undefined) return false
  return isTrivialUserMessage(turn.user)
}

/**
 * Render the user part of the extraction request.
 * @param turns - turns of one session, oldest first.
 * @param related - existing memories that may be the same facts.
 * @param pending - earlier proactive mentions still awaiting the user's reaction.
 * @param today - current date line, e.g. `2026-11-10 星期二`.
 * @returns the request text.
 */
export function buildExtractInput(turns: readonly TurnPayload[], related: readonly Memory[], pending: readonly { memoryId: number; content: string }[], today: string): string {
  const lines = [`今天是 ${today}。`, '', '已有记忆（id: 内容）：']
  if (related.length === 0) lines.push('（无）')
  for (const memory of related) {
    const key = memory.factKey === null ? '' : ` [${memory.factKey}]`
    lines.push(`${memory.id}: ${escapeForPrompt(memory.content)}${key}`)
  }
  const offered = [...pending, ...turns.flatMap(turn => turn.proactive === undefined ? [] : [turn.proactive])]
  if (offered.length > 0) {
    lines.push('', '待确认的主动提及（memory_id: 内容）：')
    for (const item of offered) lines.push(`${item.memoryId}: ${escapeForPrompt(item.content)}`)
  }
  lines.push('', '对话：')
  for (const turn of turns) {
    const attachments = [
      ...Array.from({ length: turn.images ?? 0 }, () => IMAGE_PLACEHOLDER),
      ...(turn.files ?? []).map(name => `[用户发了文件：${name}]`),
    ]
    const user = [cleanForExtraction(turn.user, MAX_MESSAGE_CHARS), ...attachments].filter(part => part !== '').join('\n')
    lines.push(`用户：${user}`)
    if (turn.assistant.trim() !== '') lines.push(`助手：${cleanForExtraction(turn.assistant, MAX_MESSAGE_CHARS)}`)
  }
  return lines.join('\n')
}

const asString = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' && value !== 'null' ? value.trim() : null

/**
 * Parse the model's JSON. Code fences and text around the object are tolerated;
 * malformed entries are dropped.
 * @param text - raw model output.
 * @returns the parsed extraction.
 * @throws {SyntaxError} when no JSON object can be read.
 */
export function parseExtraction(text: string): Extraction {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new SyntaxError('extraction output has no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1)) as { memories?: unknown; proactive?: unknown }
  const candidates: Candidate[] = []
  for (const raw of Array.isArray(parsed.memories) ? parsed.memories as Record<string, unknown>[] : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const content = asString(raw.content)
    const kind = raw.kind as MemoryKind
    if (content === null || !MEMORY_KINDS.includes(kind)) continue
    const action = raw.action === 'update' || raw.action === 'same' ? raw.action : 'add'
    const target = typeof raw.target === 'number' && Number.isInteger(raw.target) ? raw.target : null
    candidates.push({
      action: action !== 'add' && target === null ? 'add' : action,
      target,
      kind,
      content,
      factKey: asString(raw.fact_key),
      people: Array.isArray(raw.people) ? (raw.people as unknown[]).flatMap(p => asString(p) ?? []).slice(0, 8) : [],
      occurred: asString(raw.occurred),
      followUp: asString(raw.follow_up),
      importance: typeof raw.importance === 'number' ? Math.min(3, Math.max(1, Math.round(raw.importance))) : 2,
      emotion: asString(raw.emotion),
      sensitive: raw.sensitive === true,
      uncertain: raw.uncertain === true,
      evidence: asString(raw.evidence) ?? '',
    })
  }
  const proactive: ProactiveVerdict[] = []
  for (const raw of Array.isArray(parsed.proactive) ? parsed.proactive as Record<string, unknown>[] : []) {
    if (typeof raw !== 'object' || raw === null || typeof raw.memory_id !== 'number') continue
    proactive.push({ memoryId: raw.memory_id, mentioned: raw.mentioned === true, engaged: typeof raw.engaged === 'boolean' ? raw.engaged : null })
  }
  return { candidates, proactive }
}

/** Qualifiers whose loss changes meaning. */
export const HEDGES = ['可能', '也许', '或许', '大概', '打算', '准备', '计划', '考虑', '想要', '想去', '想买', '想做', '想', '应该', '好像', '似乎', '不确定', '说不定', '估计', '希望'] as const

const INTENT = ['打算', '准备', '计划', '考虑', '想']
const DONE = ['已经', '已', '完成了', '做完了', '去过了', '买了']

const squash = (text: string): string => text.replace(/[\s，。！？、,.!?“”"'：:；;（）()]/g, '')

/** Why a candidate failed the accuracy check. */
export type Problem = 'empty_evidence' | 'evidence_not_found' | 'not_from_user' | 'hedge_lost' | 'intent_became_done' | 'first_person' | 'secret' | 'too_long'

/** Problem descriptions sent back to the model on rewrite. */
export const PROBLEM_TEXT: Readonly<Record<Problem, string>> = {
  empty_evidence: '缺少 evidence 原话',
  evidence_not_found: 'evidence 不是对话里的原话',
  not_from_user: '这是助手说的，不是用户说的事',
  hedge_lost: '原话里的“可能/打算/想”等不确定说法丢了',
  intent_became_done: '把“打算做”写成了“已经做”',
  first_person: '主语写成了“我/你”，应该用第三人称',
  secret: '疑似密码或密钥，不能记',
  too_long: '内容太长，一条只写一件事',
}

/**
 * Rule-based accuracy check of one candidate against the source turns.
 * @param candidate - the proposed memory.
 * @param turns - the turns it came from.
 * @returns the problems found; empty when it passes.
 */
export function checkCandidate(candidate: Candidate, turns: readonly TurnPayload[]): Problem[] {
  const problems: Problem[] = []
  if (looksLikeSecret(candidate.content)) problems.push('secret')
  if (candidate.content.length > 200) problems.push('too_long')
  if (/^(我|你)/.test(candidate.content)) problems.push('first_person')
  const evidence = squash(candidate.evidence)
  if (candidate.action === 'same') return problems
  if (evidence === '') {
    problems.push('empty_evidence')
    return problems
  }
  const userText = squash(turns.map(turn => turn.user).join('\n'))
  const assistantText = squash(turns.map(turn => turn.assistant).join('\n'))
  const inUser = userText.includes(evidence)
  const inAssistant = assistantText.includes(evidence)
  const hasImages = turns.some(turn => (turn.images ?? 0) > 0)
  if (!inUser && !inAssistant) problems.push('evidence_not_found')
  else if (!inUser && !hasImages && candidate.kind !== 'shared') problems.push('not_from_user')
  const hedgedSource = HEDGES.some(hedge => candidate.evidence.includes(hedge))
  const hedgedContent = HEDGES.some(hedge => candidate.content.includes(hedge))
  if (hedgedSource && !hedgedContent) problems.push('hedge_lost')
  if (INTENT.some(word => candidate.evidence.includes(word)) && !DONE.some(word => candidate.evidence.includes(word))
    && DONE.some(word => candidate.content.includes(word))) problems.push('intent_became_done')
  return problems
}

/**
 * Token-set overlap of two texts, for duplicate and suppression checks.
 * @param a - first token list.
 * @param b - second token list.
 * @returns Jaccard similarity in [0, 1].
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}
