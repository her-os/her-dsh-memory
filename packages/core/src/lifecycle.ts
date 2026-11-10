/**
 * Strength decay. Strength is computed on read: the stored base strength
 * halves every half-life since the memory was learned or last reinforced.
 * Pinned and high-importance memories do not decay. State transitions
 * (active → faded → archived) run in batches during idle consolidation.
 */

import type { Memory, MemoryKind } from './types.ts'

/** Half-life in days per category. */
export const HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number>> = {
  profile: 365,
  person: 365,
  preference: 180,
  shared: 120,
  promise: 90,
  event: 45,
}

/** Half-life for memories that mainly record a mood. */
export const EMOTION_HALF_LIFE_DAYS = 14

/** Below this a memory is faded: still recalled, ranked lower. */
export const FADE_THRESHOLD = 0.3

/** Below this a memory is archived: not recalled, still searchable by tools. */
export const ARCHIVE_THRESHOLD = 0.08

/** Base-strength gain each time the user brings a memory up again; capped at {@link MAX_STRENGTH}. */
export const REINFORCE_STEP = 0.5

/** Upper bound of base strength. */
export const MAX_STRENGTH = 3

type DecayFields = Pick<Memory, 'kind' | 'emotion' | 'importance' | 'pinned' | 'strength' | 'learnedAt' | 'reinforcedAt'>

/**
 * Whether a memory is exempt from decay.
 * @param memory - the memory.
 * @returns `true` for pinned or importance-3 memories.
 */
export function isDecayExempt(memory: Pick<Memory, 'pinned' | 'importance'>): boolean {
  return memory.pinned || memory.importance >= 3
}

/**
 * Half-life of one memory.
 * @param memory - the memory.
 * @returns days.
 */
export function halfLifeDays(memory: Pick<Memory, 'kind' | 'emotion'>): number {
  const base = HALF_LIFE_DAYS[memory.kind]
  return memory.emotion !== null && memory.emotion !== '' && memory.kind === 'event' ? Math.min(base, EMOTION_HALF_LIFE_DAYS) : base
}

/**
 * Current strength.
 * @param memory - the memory.
 * @param now - the current instant.
 * @returns the decayed strength; exempt memories return their base strength.
 */
export function currentStrength(memory: DecayFields, now: Date): number {
  if (isDecayExempt(memory)) return memory.strength
  const since = Date.parse(memory.reinforcedAt ?? memory.learnedAt)
  const ageDays = Math.max(0, (now.getTime() - since) / 86_400_000)
  return memory.strength * 0.5 ** (ageDays / halfLifeDays(memory))
}

/**
 * The lifecycle state a strength maps to.
 * @param memory - the memory.
 * @param now - the current instant.
 * @returns `active`, `faded`, or `archived`.
 */
export function decayedStatus(memory: DecayFields, now: Date): 'active' | 'faded' | 'archived' {
  const strength = currentStrength(memory, now)
  if (strength < ARCHIVE_THRESHOLD) return 'archived'
  if (strength < FADE_THRESHOLD) return 'faded'
  return 'active'
}

/**
 * Freshness factor for ranking: 1 for a memory learned now, approaching 0.5 for very old ones.
 * @param learnedAt - ISO instant learned.
 * @param now - the current instant.
 * @returns the factor in (0.5, 1].
 */
export function freshness(learnedAt: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(learnedAt)) / 86_400_000)
  return 0.5 + 0.5 * 0.5 ** (ageDays / 180)
}
