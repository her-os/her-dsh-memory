/** Chinese-aware tokenizing for FTS5, prompt escaping, and extraction input cleanup. */

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/**
 * Split text into lower-cased word tokens; punctuation and whitespace are dropped.
 * @param text - any mix of Chinese, English, and digits.
 * @returns the word-like segments in order.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const part of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    if (part.isWordLike === true) tokens.push(part.segment)
  }
  return tokens
}

/**
 * The FTS5 column text for a memory: tokens joined by single spaces.
 * @param text - memory content.
 * @returns the indexed text.
 */
export function ftsText(text: string): string {
  return tokenize(text).join(' ')
}

/**
 * An FTS5 MATCH expression that matches any token of the query; every token is
 * quoted, so FTS5 operators in user text have no effect.
 * @param text - the user message or search text.
 * @returns the expression, or `undefined` when the text has no word tokens.
 */
export function ftsQuery(text: string): string | undefined {
  const unique = [...new Set(tokenize(text))]
  if (unique.length === 0) return undefined
  return unique.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * Escape memory text placed inside the injection block, so stored text cannot
 * close the block or pass itself off as markup.
 * @param text - untrusted memory content.
 * @returns the text with `&`, `<`, and `>` replaced by entities.
 */
export function escapeForPrompt(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Placeholder the extractor sees in place of an image. */
export const IMAGE_PLACEHOLDER = '[用户发了一张图片]'

const CODE_FENCE = /```[\s\S]*?(```|$)/g

/**
 * Prepare one message for extraction: code blocks become `[代码]`, and a long
 * message keeps only its head and tail.
 * @param text - message text.
 * @param maxChars - kept length; at least 200.
 * @returns the cleaned text.
 */
export function cleanForExtraction(text: string, maxChars: number): string {
  const cleaned = text.replace(CODE_FENCE, '[代码]').trim()
  if (cleaned.length <= maxChars) return cleaned
  const half = Math.floor((maxChars - 5) / 2)
  return `${cleaned.slice(0, half)}\n…\n${cleaned.slice(-half)}`
}

const GREETING = /^(你好|您好|嗨|哈喽|hi|hello|hey|早|早安|早上好|晚安|午安|在吗|在不在|谢谢|谢了|多谢|thanks|thank you|ok|okay|好的|好|嗯|嗯嗯|哦|噢|哈+|呵呵|拜拜|再见|bye)[!！~。.,，?？\s]*$/i
const ONLY_SYMBOLS = /^[\p{Extended_Pictographic}\p{P}\p{S}\s‍️]*$/u

/**
 * Whether a user message carries nothing worth extracting: greetings, emoji or
 * punctuation alone, or code alone.
 * @param text - the user message.
 * @returns `true` when extraction should skip the turn.
 */
export function isTrivialUserMessage(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (GREETING.test(trimmed)) return true
  if (ONLY_SYMBOLS.test(trimmed)) return true
  const withoutCode = trimmed.replace(CODE_FENCE, '').trim()
  return withoutCode === ''
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /(密码|口令|password|passwd|pwd|token|api[_ -]?key|secret)\s*(是|为|:|：|=)\s*\S{4,}/i,
  /\b[A-Fa-f0-9]{40,}\b/,
]

/**
 * Whether text looks like it contains a credential.
 * @param text - candidate memory content.
 * @returns `true` when any credential pattern matches.
 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text))
}
