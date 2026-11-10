/**
 * Calendar arithmetic for memories. The model only ever gives relative
 * expressions ("下周三"); this module turns them into `YYYY-MM-DD` dates in the
 * user's time zone, where a day starts at `dayStartHour` (04:00 by default), and
 * renders stored dates back as relative labels for the injection block.
 */

/** Wall-clock source and calendar conventions. */
export interface Clock {
  /** Current instant. */
  now(): Date
  /** IANA time zone of the user. */
  readonly timeZone: string
  /** Hour at which a new day starts; earlier hours count as the previous day. */
  readonly dayStartHour: number
}

/** A calendar day without time zone. */
export interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/**
 * Build a clock over the system time.
 * @param timeZone - IANA zone; defaults to the process zone.
 * @param dayStartHour - hour a day starts; defaults to 4.
 * @returns the clock.
 */
export function systemClock(timeZone?: string, dayStartHour = 4): Clock {
  return {
    now: () => new Date(),
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayStartHour,
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * The user's calendar day at an instant, honoring the day-start hour.
 * @param instant - the moment.
 * @param clock - zone and day-start conventions.
 * @returns the calendar day.
 */
export function calendarDay(instant: Date, clock: Pick<Clock, 'timeZone' | 'dayStartHour'>): CalendarDate {
  let format = formatters.get(clock.timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: clock.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(clock.timeZone, format)
  }
  const shifted = new Date(instant.getTime() - clock.dayStartHour * 3_600_000)
  const parts = Object.fromEntries(format.formatToParts(shifted).map(part => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) }
}

const toUtc = (date: CalendarDate): number => Date.UTC(date.year, date.month - 1, date.day)
const fromUtc = (ms: number): CalendarDate => {
  const d = new Date(ms)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/**
 * Add days to a calendar date.
 * @param date - the start.
 * @param days - signed day count.
 * @returns the shifted date.
 */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromUtc(toUtc(date) + days * 86_400_000)
}

/**
 * Add months, clamping the day to the target month's length.
 * @param date - the start.
 * @param months - signed month count.
 * @returns the shifted date.
 */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const index = date.year * 12 + (date.month - 1) + months
  const year = Math.floor(index / 12)
  const month = index - year * 12 + 1
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) }
}

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * Signed whole days from `from` to `to`.
 * @param from - the earlier day.
 * @param to - the later day.
 * @returns `to - from` in days.
 */
export function diffDays(from: CalendarDate, to: CalendarDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000)
}

/**
 * Format as `YYYY-MM-DD`.
 * @param date - the day.
 * @returns the ISO date.
 */
export function formatDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

/**
 * Parse `YYYY-MM-DD`.
 * @param text - an ISO date, optionally followed by a time.
 * @returns the day, or `undefined` when the text is not an ISO date.
 */
export function parseDate(text: string): CalendarDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match === null) return undefined
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  return isValid(date) ? date : undefined
}

const isValid = (date: CalendarDate): boolean =>
  date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= daysInMonth(date.year, date.month)

const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/**
 * Parse an Arabic or Chinese numeral up to 99.
 * @param text - `12`, `十二`, `二十`, `廿一`.
 * @returns the value, or `undefined`.
 */
export function parseNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text)
  const normalized = text.replace(/^廿/, '二十')
  const match = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(normalized)
  if (match === null || normalized === '') return undefined
  const [, tens, ten, ones] = match
  if (ten === undefined) return tens === undefined ? undefined : DIGITS[tens]
  return (tens === undefined ? 1 : DIGITS[tens]!) * 10 + (ones === undefined ? 0 : DIGITS[ones]!)
}

const NUM = '(\\d{1,2}|[零〇一二两三四五六七八九十廿]{1,3})'
const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 }
const DAY_WORDS: Record<string, number> = {
  今天: 0, 今日: 0, 今晚: 0, 今早: 0, 今天晚上: 0, 今天早上: 0,
  明天: 1, 明日: 1, 明早: 1, 明晚: 1, 明天晚上: 1, 明天早上: 1,
  后天: 2, 大后天: 3,
  昨天: -1, 昨日: -1, 昨晚: -1, 昨天晚上: -1, 前天: -2, 大前天: -3,
}

/** Which way an ambiguous date without a year should lean. */
export type DateLean = 'future' | 'past' | 'nearest'

/**
 * Resolve a date expression relative to today.
 * @param expression - an ISO date, `M月D日`, `下周三`, `3天后`, `下个月5号`, `去年9月`, and similar.
 * @param today - the user's current calendar day.
 * @param lean - year choice for `M月D日` without a year.
 * @returns the `YYYY-MM-DD` date, or `undefined` when the expression is not a recognized date.
 */
export function resolveDate(expression: string, today: CalendarDate, lean: DateLean = 'nearest'): string | undefined {
  const text = expression.replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '')
  if (text === '') return undefined
  const resolved = resolveCalendar(text, today, lean)
  return resolved !== undefined && isValid(resolved) ? formatDate(resolved) : undefined
}

function resolveCalendar(text: string, today: CalendarDate, lean: DateLean): CalendarDate | undefined {
  const iso = parseDate(text)
  if (iso !== undefined) return iso
  let m = /^(\d{4})[/.年](\d{1,2})[/.月](\d{1,2})[日号]?$/.exec(text)
  if (m !== null) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  if (text in DAY_WORDS) return addDays(today, DAY_WORDS[text]!)

  m = new RegExp(`^${NUM}(天|日|周|个?星期|个?礼拜|个月|年)(以?后|之后|后|以?前|之前|前)$`).exec(text)
  if (m !== null) {
    const n = parseNumber(m[1]!)
    if (n === undefined) return undefined
    const sign = m[3]!.endsWith('后') ? 1 : -1
    const unit = m[2]!
    if (unit === '天' || unit === '日') return addDays(today, sign * n)
    if (unit === '个月') return addMonths(today, sign * n)
    if (unit === '年') return addMonths(today, sign * 12 * n)
    return addDays(today, sign * 7 * n)
  }

  m = /^(下下|下|这|本|上|)(?:个)?(周|星期|礼拜)([一二三四五六日天末])$/.exec(text)
  if (m !== null) {
    const offset = { 下下: 14, 下: 7, 这: 0, 本: 0, 上: -7, '': 0 }[m[1]!]!
    const todayIndex = weekdayOf(today)
    const monday = addDays(today, 1 - todayIndex)
    const target = addDays(monday, offset + WEEKDAY[m[3]!]! - 1)
    if (m[1] === '' && lean === 'future' && diffDays(today, target) < 0) return addDays(target, 7)
    return target
  }

  m = new RegExp(`^(下个?月|这个?月|本月|上个?月)(?:${NUM}[日号])?$`).exec(text)
  if (m !== null) {
    const shift = m[1]!.startsWith('下') ? 1 : m[1]!.startsWith('上') ? -1 : 0
    const base = addMonths({ ...today, day: 1 }, shift)
    const day = m[2] === undefined ? 1 : parseNumber(m[2])
    return day === undefined ? undefined : { ...base, day }
  }

  m = new RegExp(`^(明年|今年|去年|前年|后年)(?:${NUM}月)?(?:${NUM}[日号])?$`).exec(text)
  if (m !== null) {
    const year = today.year + { 明年: 1, 今年: 0, 去年: -1, 前年: -2, 后年: 2 }[m[1]!]!
    const month = m[2] === undefined ? 1 : parseNumber(m[2])
    const day = m[3] === undefined ? 1 : parseNumber(m[3])
    return month === undefined || day === undefined ? undefined : { year, month, day }
  }

  m = new RegExp(`^${NUM}月(?:${NUM}[日号]?)?$`).exec(text)
  if (m !== null) {
    const month = parseNumber(m[1]!)
    const day = m[2] === undefined ? 1 : parseNumber(m[2])
    if (month === undefined || day === undefined) return undefined
    return pickYear({ year: today.year, month, day }, today, lean)
  }

  m = new RegExp(`^${NUM}[日号]$`).exec(text)
  if (m !== null) {
    const day = parseNumber(m[1]!)
    if (day === undefined) return undefined
    const sameMonth = { ...today, day }
    if (lean === 'future' && day < today.day) return { ...addMonths({ ...today, day: 1 }, 1), day }
    if (lean === 'past' && day > today.day) return { ...addMonths({ ...today, day: 1 }, -1), day }
    return sameMonth
  }
  return undefined
}

function pickYear(date: CalendarDate, today: CalendarDate, lean: DateLean): CalendarDate {
  const delta = diffDays(today, date)
  if (lean === 'future' && delta < 0) return { ...date, year: date.year + 1 }
  if (lean === 'past' && delta > 0) return { ...date, year: date.year - 1 }
  if (lean === 'nearest') {
    if (delta > 183) return { ...date, year: date.year - 1 }
    if (delta < -183) return { ...date, year: date.year + 1 }
  }
  return date
}

/**
 * ISO weekday, Monday = 1 … Sunday = 7.
 * @param date - the day.
 * @returns the weekday number.
 */
export function weekdayOf(date: CalendarDate): number {
  const day = new Date(toUtc(date)).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * Describe a stored date relative to today: `今天`, `后天`, `3 天前`,
 * `11 月 12 日`, `去年 9 月`, `2023 年 5 月`.
 * @param date - the stored day.
 * @param today - the user's current day.
 * @returns the label.
 */
export function relativeLabel(date: CalendarDate, today: CalendarDate): string {
  const delta = diffDays(today, date)
  const named: Record<number, string> = { 0: '今天', 1: '明天', 2: '后天', [-1]: '昨天', [-2]: '前天' }
  if (named[delta] !== undefined) return named[delta]
  if (delta < 0 && delta >= -30) return `${-delta} 天前`
  if (delta > 0 && delta <= 30) return `${delta} 天后`
  if (date.year === today.year) return `${date.month} 月 ${date.day} 日`
  if (date.year === today.year - 1) return `去年 ${date.month} 月`
  if (date.year === today.year + 1) return `明年 ${date.month} 月`
  return `${date.year} 年 ${date.month} 月`
}
