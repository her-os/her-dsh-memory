/** Pure editing helpers of the memory page, kept apart from React so tests can load them. */

import type { Kind, MemoryItem, MemoryPatch } from './api.ts'

/** Editable values of one memory as the form holds them. */
export interface Draft {
  content: string
  kind: Kind
  people: string
  occurredAt: string
  followUpAt: string
  importance: number
}

/**
 * Split a comma list typed by the user.
 * @param text - comma, Chinese comma or 、 separated names.
 * @returns trimmed non-empty parts.
 */
export const splitList = (text: string): string[] => text.split(/[,，、]/u).map(part => part.trim()).filter(part => part !== '')

/**
 * Form values of a stored memory.
 * @param memory - stored memory.
 * @returns the draft.
 */
export const draftOf = (memory: MemoryItem): Draft => ({
  content: memory.content,
  kind: memory.kind,
  people: memory.people.join('，'),
  occurredAt: memory.occurredAt ?? '',
  followUpAt: memory.followUpAt ?? '',
  importance: memory.importance,
})

const DATE = /^\d{4}-\d{2}-\d{2}$/u
const dateOrNull = (text: string): string | null => DATE.test(text.trim()) ? text.trim() : null

/**
 * Fields of the draft that differ from the stored memory, content excluded.
 * @param memory - stored memory.
 * @param draft - edited values.
 * @returns the patch, empty when nothing besides content changed.
 */
export function draftPatch(memory: MemoryItem, draft: Draft): MemoryPatch {
  const people = splitList(draft.people)
  const occurredAt = dateOrNull(draft.occurredAt)
  const followUpAt = dateOrNull(draft.followUpAt)
  return {
    ...(draft.kind === memory.kind ? {} : { kind: draft.kind }),
    ...(people.join('\n') === memory.people.join('\n') ? {} : { people }),
    ...(occurredAt === memory.occurredAt ? {} : { occurredAt }),
    ...(followUpAt === memory.followUpAt ? {} : { followUpAt }),
    ...(draft.importance === memory.importance ? {} : { importance: draft.importance }),
  }
}
