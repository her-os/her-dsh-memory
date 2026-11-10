/**
 * The plugin inside a real DSH headless profile: learning from turns,
 * recalling across sessions, the model tools, and the failure paths.
 */

import { DEFAULT_PROMPTS } from '@her-os/memory-core'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { DshHome } from '../src/dsh.ts'
import { DEFAULT_ANSWER, extractionReply, type MockModel, type ModelRequest, startMockModel } from '../src/mock-model.ts'

const CAT = '我家的猫叫年糕，是只橘猫'
const INTERVIEW = '下周三我有个面试，有点紧张'
const LEARNED = [
  { action: 'add', kind: 'preference', content: '用户养了一只叫年糕的橘猫', evidence: CAT, importance: 2 },
  { action: 'add', kind: 'promise', content: '用户下周三有一场面试', occurred: '下周三', follow_up: '下周三', evidence: '下周三我有个面试', importance: 3 },
]

interface MemoryRow { id: number; content: string; kind: string; status: string; sensitive: number; follow_up_at: string | null; source_session: string | null }

let mock: MockModel
let home: DshHome

const since = (start: number): ModelRequest[] => mock.requests.slice(start)
const memories = (): MemoryRow[] => home.query<MemoryRow>('SELECT id, content, kind, status, sensitive, follow_up_at, source_session FROM memories ORDER BY id')
const meta = (key: string): string | undefined => home.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)[0]?.value

beforeAll(async () => {
  mock = await startMockModel()
  home = new DshHome(mock.baseURL)
  await home.addPlugin('headless', inject('tarball'))
  // Semantic search has its own test (local-embed.e2e.ts); this one stays offline.
  home.configurePlugin('headless', { embedding: { provider: 'off' } })
})

afterAll(async () => {
  await mock?.close()
  home?.dispose()
})

describe('her-memory in DSH headless', () => {
  let learnedSession = ''

  it('learns from three turns of one session', async () => {
    mock.respond(request => request.extraction ? extractionReply(LEARNED) : { text: DEFAULT_ANSWER })
    const start = mock.requests.length
    const first = await home.headless(CAT)
    learnedSession = first.sessionId
    expect(first.final).toBe(DEFAULT_ANSWER)
    await home.headless(INTERVIEW, first.sessionId)
    await home.headless('今天就先聊到这吧', first.sessionId)

    const extraction = since(start).filter(request => request.extraction)
    expect(extraction).toHaveLength(1)
    expect(extraction[0]!.lastUser).toContain(`用户：${CAT}`)
    expect(extraction[0]!.lastUser).toContain(`用户：${INTERVIEW}`)
    expect(extraction[0]!.lastUser).toContain(`助手：${DEFAULT_ANSWER}`)

    const rows = memories()
    expect(rows.map(row => row.content)).toEqual(['用户养了一只叫年糕的橘猫', '用户下周三有一场面试'])
    expect(rows.every(row => row.source_session === first.sessionId)).toBe(true)
    const followUp = rows[1]!.follow_up_at
    expect(followUp).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
    expect(new Date(`${followUp}T00:00:00Z`).getUTCDay()).toBe(3)
    expect(home.query('SELECT 1 FROM extract_queue')).toHaveLength(0)
    expect(meta('last_extract_error') ?? '').toBe('')
  })

  it('carries the memory rules in the system prompt', () => {
    const chat = mock.requests.filter(request => !request.extraction)
    expect(chat.length).toBeGreaterThan(0)
    expect(chat.at(-1)!.system).toContain(DEFAULT_PROMPTS.residentRules.slice(0, 30))
    expect(chat.at(-1)!.tools).toEqual(expect.arrayContaining(['memory_search', 'memory_save', 'memory_correct', 'memory_forget']))
  })

  it('recalls a related memory in a new session, before the user message', async () => {
    const start = mock.requests.length
    const turn = await home.headless('年糕最近老挑食怎么办')
    expect(turn.sessionId).not.toBe(learnedSession)
    const chat = since(start).find(request => !request.extraction && request.lastUser.includes('年糕最近老挑食怎么办'))
    expect(chat).toBeDefined()
    expect(chat!.lastUser).toMatch(/<memory-recall>[\s\S]*用户养了一只叫年糕的橘猫[\s\S]*<\/memory-recall>[\s\S]*年糕最近老挑食怎么办/u)
    expect(chat!.lastUser).not.toContain('用户下周三有一场面试')
    const cat = memories().find(row => row.content.includes('年糕'))!
    const log = home.query<{ memory_id: number; session_id: string }>('SELECT memory_id, session_id FROM recall_log WHERE session_id = ?', turn.sessionId)
    expect(log.map(row => row.memory_id)).toContain(cat.id)
  })

  it('injects nothing when no memory is related', async () => {
    const start = mock.requests.length
    await home.headless('帮我写一首关于春天的诗')
    const chat = since(start).find(request => !request.extraction && request.lastUser.includes('春天'))
    expect(chat).toBeDefined()
    expect(chat!.lastUser).not.toContain('<memory-recall>')
  })

  it('saves through memory_save when the user asks to be remembered', async () => {
    mock.respond((request) => {
      if (request.extraction) return extractionReply([])
      const asked = request.lastUser.includes('记住我对花生过敏')
      const answered = request.messages.some(message => message.text.includes('[tool_result]'))
      if (asked && !answered && request.tools.includes('memory_save')) return { tool: { name: 'memory_save', input: { content: '用户对花生过敏', sensitive: true } } }
      return { text: DEFAULT_ANSWER }
    })
    const start = mock.requests.length
    await home.headless('请记住我对花生过敏')
    const followUp = since(start).find(request => request.messages.some(message => message.text.includes('[tool_result]')))
    expect(followUp?.messages.at(-1)?.text).toMatch(/Saved as #\d+/u)
    const saved = memories().find(row => row.content === '用户对花生过敏')
    expect(saved).toMatchObject({ status: 'active', sensitive: 1 })
  })

  it('extracts a short session on the next run, dropping memories whose evidence is not in the conversation', async () => {
    mock.respond(request => request.extraction
      ? extractionReply([{ action: 'add', kind: 'profile', content: '用户住在北京', evidence: '我住在北京', importance: 2 }])
      : { text: DEFAULT_ANSWER })
    // One turn, then exit: DSH disposes the model adapters before plugins, so the turn stays queued.
    await home.headless('我最近搬去杭州了')
    const queued = (): unknown[] => home.query("SELECT 1 FROM extract_queue WHERE payload LIKE '%杭州%'")
    expect(queued()).toHaveLength(1)
    const start = mock.requests.length
    // The next run's first turn picks up what an earlier process left behind.
    await home.headless('今天天气不错')
    const extraction = since(start).filter(request => request.extraction && request.messages.some(message => message.text.includes('我最近搬去杭州了')))
    expect(extraction).toHaveLength(2)
    expect(extraction[1]!.lastUser).toContain('evidence 不是对话里的原话')
    expect(memories().some(row => row.content.includes('北京'))).toBe(false)
    expect(queued()).toHaveLength(0)
  })

  it('records a failed extraction and keeps the turns queued', async () => {
    mock.respond(request => request.extraction ? { status: 400 } : { text: DEFAULT_ANSWER })
    const first = await home.headless('我最近在学吉他')
    await home.headless('每天练半小时', first.sessionId)
    await home.headless('手指有点疼', first.sessionId)
    const error = JSON.parse(meta('last_extract_error') ?? '{}') as { at?: string; message?: string }
    expect(error.message).toBeTruthy()
    expect(Date.parse(error.at ?? '')).not.toBeNaN()
    const queued = home.query<{ attempts: number }>('SELECT attempts FROM extract_queue WHERE session_id = ?', first.sessionId)
    expect(queued).toHaveLength(3)
    expect(queued.every(row => row.attempts === 1)).toBe(true)
  })
})
