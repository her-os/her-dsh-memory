import { describe, expect, it } from 'vitest'
import { calendarDay, formatDate, parseDate, relativeLabel, resolveDate } from '../src/index.ts'

const zone = { timeZone: 'Asia/Shanghai', dayStartHour: 4 }
const today = parseDate('2026-11-10')! // Tuesday

describe('calendarDay', () => {
  it('counts hours before 04:00 as the previous day', () => {
    expect(formatDate(calendarDay(new Date('2026-11-11T03:59:00+08:00'), zone))).toBe('2026-11-10')
    expect(formatDate(calendarDay(new Date('2026-11-11T04:00:00+08:00'), zone))).toBe('2026-11-11')
  })
  it('uses the user zone, not UTC', () => {
    expect(formatDate(calendarDay(new Date('2026-11-10T23:30:00Z'), zone))).toBe('2026-11-11')
  })
})

describe('resolveDate', () => {
  it.each([
    ['今天', '2026-11-10'], ['明天', '2026-11-11'], ['后天', '2026-11-12'], ['昨天', '2026-11-09'],
    ['3天后', '2026-11-13'], ['两周前', '2026-10-27'], ['下周三', '2026-11-18'], ['这周五', '2026-11-13'],
    ['上周一', '2026-11-02'], ['2026-12-01', '2026-12-01'], ['下个月5号', '2026-12-05'],
  ])('%s → %s', (expression, expected) => {
    expect(resolveDate(expression, today, 'nearest')).toBe(expected)
  })
  it('crosses the year for a future month-day', () => {
    expect(resolveDate('1月5日', parseDate('2026-12-20')!, 'future')).toBe('2027-01-05')
  })
  it('stays in the past year for a past month-day', () => {
    expect(resolveDate('12月25日', parseDate('2027-01-03')!, 'past')).toBe('2026-12-25')
  })
  it('returns undefined for vague text', () => {
    expect(resolveDate('最近', today)).toBeUndefined()
  })
})

describe('relativeLabel', () => {
  it('names near days and dates far ones', () => {
    expect(relativeLabel(parseDate('2026-11-11')!, today)).toBe('明天')
    expect(relativeLabel(parseDate('2026-11-08')!, today)).toBe('前天')
    expect(relativeLabel(parseDate('2025-03-01')!, today)).toContain('去年')
  })
})
