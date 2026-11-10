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
 * Function words, pronouns, and fillers left out of keyword queries; they
 * match most memories and only cost time. "用户" is here because every memory
 * is written in the third person about the user.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '咱们', '自己', '用户', '的', '了', '着', '过', '是', '在', '有', '和', '与', '或',
  '就', '也', '都', '还', '又', '很', '太', '挺', '最', '更', '把', '被', '给', '让', '从', '向', '对', '跟', '这', '那', '这个', '那个', '这些',
  '那些', '什么', '怎么', '怎么样', '为什么', '哪', '哪里', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '哈', '啦', '么', '一下', '一个', '一些',
  '没', '没有', '不', '要', '会', '能', '可以', '想', '说', '看', '觉得', '知道', '现在', '今天', '最近', '然后', '但是', '因为', '所以', '如果',
  'the', 'a', 'an', 'is', 'are', 'i', 'you', 'to', 'of', 'and', 'it', 'my', 'me',
])

/**
 * An FTS5 MATCH expression that matches any token of the query; every token is
 * quoted, so FTS5 operators in user text have no effect.
 * @param text - the user message or search text.
 * @returns the expression, or `undefined` when the text has no word tokens.
 */
export function ftsQuery(text: string): string | undefined {
  const all = [...new Set(tokenize(text))]
  const meaningful = all.filter(token => !STOPWORDS.has(token))
  const unique = meaningful.length > 0 ? meaningful : all
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
