/** Copy dictionaries for the memory settings tab. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '记忆',
  empty: '还没有记忆。和 Her 聊天后，记住的事会出现在这里。',
}

/** Dictionary keys of this namespace. */
export type MemoryLocaleKey = keyof typeof zh

/** English dictionary. */
export const en: Record<MemoryLocaleKey, string> = {
  tab: 'Memory',
  empty: 'No memories yet. Things Her remembers from your chats will appear here.',
}
