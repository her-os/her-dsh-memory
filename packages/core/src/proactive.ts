/**
 * Proactive mention: who may be brought up unprompted, and when. At most one
 * candidate per session; sensitive, mention-blocked, recently mentioned, and
 * repeatedly ignored memories never qualify.
 */

import { currentStrength } from './lifecycle.ts'
import type { ProactiveEntry } from './repo.ts'
import { type CalendarDate, diffDays, parseDate } from './time.ts'
import type { Memory } from './types.ts'

/** Proactive level setting. */
export type ProactiveLevel = 'off' | 'low' | 'normal'

/** Gap since the scope's last turn that counts as a fresh start. */
export const FRESH_START_HOURS = 6

/** Days a mentioned memory rests before it may be mentioned again. */
export const MENTION_COOLDOWN_DAYS = 7

/** Ignored mentions after which a memory is never offered again. */
export const MAX_IGNORED = 2

/** Days after a follow-up date during which it may still be brought up. */
export const FOLLOW_UP_WINDOW_DAYS = 7

/** Age range, in days, of an open promise without a date that may be asked about. */
export const OPEN_PROMISE_AGE_DAYS: readonly [number, number] = [3, 30]

/** Minimum age, in days, of an old event offered for reminiscing on the normal level. */
export const REMINISCE_MIN_AGE_DAYS = 30

/**
 * Whether this turn may carry a proactive mention.
 * @param level - setting.
 * @param firstTurn - whether this is the session's first turn.
 * @param lastTurnAt - ISO instant of the scope's previous turn, when any.
 * @param alreadyOffered - whether the session already had its one offer.
 * @param now - the current instant.
 * @returns `true` when a candidate should be picked.
 */
export function shouldOffer(level: ProactiveLevel, firstTurn: boolean, lastTurnAt: string | undefined, alreadyOffered: boolean, now: Date): boolean {
  if (level === 'off' || alreadyOffered) return false
  if (firstTurn) return true
  if (lastTurnAt === undefined) return true
  return now.getTime() - Date.parse(lastTurnAt) > FRESH_START_HOURS * 3_600_000
}

/** Why a memory qualifies. */
export type OfferReason = 'follow_up_due' | 'open_promise' | 'reminisce'

/** One eligible memory. */
export interface Offer {
  readonly memory: Memory
  readonly reason: OfferReason
  readonly priority: number
}

/**
 * Pick the proactive candidate.
 * @param memories - active and faded memories of the visible scopes.
 * @param mentions - proactive history per memory id.
 * @param level - setting.
 * @param today - the user's calendar day.
 * @param now - the current instant.
 * @returns the best offer, or `undefined`.
 */
export function pickOffer(memories: readonly Memory[], mentions: (id: number) => readonly ProactiveEntry[], level: ProactiveLevel, today: CalendarDate, now: Date): Offer | undefined {
  if (level === 'off') return undefined
  const offers: Offer[] = []
  for (const memory of memories) {
    if (memory.sensitive || memory.mentionBlocked || (memory.status !== 'active' && memory.status !== 'faded')) continue
    const history = mentions(memory.id)
    if (history.filter(entry => entry.responded === false).length >= MAX_IGNORED) continue
    const last = history[0]
    if (last !== undefined && now.getTime() - Date.parse(last.mentionedAt) < MENTION_COOLDOWN_DAYS * 86_400_000) continue
    const follow = memory.followUpAt === null ? undefined : parseDate(memory.followUpAt)
    const learnedAgeDays = (now.getTime() - Date.parse(memory.learnedAt)) / 86_400_000
    if (follow !== undefined) {
      const overdue = diffDays(follow, today)
      if (overdue >= 0 && overdue <= FOLLOW_UP_WINDOW_DAYS) offers.push({ memory, reason: 'follow_up_due', priority: 3 - overdue / 10 })
      continue
    }
    if (memory.kind === 'promise') {
      if (learnedAgeDays >= OPEN_PROMISE_AGE_DAYS[0] && learnedAgeDays <= OPEN_PROMISE_AGE_DAYS[1]) offers.push({ memory, reason: 'open_promise', priority: 2 - learnedAgeDays / 100 })
      continue
    }
    if (level === 'normal' && (memory.kind === 'event' || memory.kind === 'shared') && memory.importance >= 2 && learnedAgeDays >= REMINISCE_MIN_AGE_DAYS) {
      offers.push({ memory, reason: 'reminisce', priority: Math.min(1, currentStrength(memory, now)) })
    }
  }
  offers.sort((a, b) => b.priority - a.priority)
  return offers[0]
}
