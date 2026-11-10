import { afterEach, describe, expect, it } from 'vitest'
import type { TurnPayload } from '../src/index.ts'
import { extraction, fakeEmbedder, type Harness, makeEngine, scriptedLlm } from './helpers.ts'

let h: Harness | undefined
afterEach(() => { h?.dispose(); h = undefined })

const turn = (n: number, user: string, assistant = '嗯嗯，我记下了'): TurnPayload => ({ turn: n, at: '2026-11-10T02:00:00Z', user, assistant, scope: 'global' })
const recallReq = (userText: string, extra: Partial<Parameters<Harness['engine']['recall']>[0]> = {}) => ({
  sessionId: 's1', turn: 1, userText, scope: 'global', scopes: ['global'], injected: new Set<number>(), firstTurn: false, offeredThisSession: true, ...extra,
})

describe('extraction', () => {
  it('writes validated memories with resolved dates', async () => {
    const llm = scriptedLlm(extraction([{
      kind: 'event', content: '用户下周三有一场面试', occurred: '下周三', follow_up: '下周三', importance: 3, evidence: '我下周三有一场面试',
    }]))
    h = makeEngine({ llm })
    const ids = await h.engine.extractTurns('s1', [turn(1, '我下周三有一场面试，有点紧张')])
    const m = h.engine.repo.require(ids[0]!)
    expect(m.occurredAt).toBe('2026-11-18')
    expect(m.followUpAt).toBe('2026-11-18')
    expect(m.sourceSession).toBe('s1')
    expect(llm.requests[0]!.user).toContain('2026-11-10 星期二')
  })

  it('asks for one rewrite and drops what still fails', async () => {
    const bad = { kind: 'profile', content: '用户住在北京', evidence: '我住北京了' }
    const llm = scriptedLlm(extraction([bad, { kind: 'preference', content: '用户喜欢猫', evidence: '我喜欢猫' }]), extraction([bad]))
    h = makeEngine({ llm })
    const ids = await h.engine.extractTurns('s1', [turn(1, '我喜欢猫')])
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1]!.user).toContain('evidence 不是对话里的原话')
    expect(ids).toEqual([])
  })

  it('supersedes by fact key and keeps the chain', async () => {
    const llm = scriptedLlm(
      extraction([{ kind: 'profile', content: '用户住在北京', fact_key: 'home_city', evidence: '我住在北京' }]),
      extraction([{ kind: 'profile', content: '用户搬到了上海', fact_key: 'home_city', evidence: '我搬到上海了' }]),
    )
    h = makeEngine({ llm })
    const [first] = await h.engine.extractTurns('s1', [turn(1, '我住在北京')])
    h.clock.advanceDays(10)
    const [second] = await h.engine.extractTurns('s1', [turn(2, '我搬到上海了')])
    expect(h.engine.repo.require(first!).status).toBe('superseded')
    expect(h.engine.repo.require(first!).supersededBy).toBe(second)
    expect(h.engine.detail(second!)!.history.map(m => m.id)).toContain(first)
  })

  it('reinforces a duplicate instead of adding', async () => {
    const same = extraction([{ kind: 'preference', content: '用户喜欢喝美式咖啡', evidence: '我喜欢喝美式咖啡' }])
    h = makeEngine({ llm: scriptedLlm(same, same) })
    const [a] = await h.engine.extractTurns('s1', [turn(1, '我喜欢喝美式咖啡')])
    const [b] = await h.engine.extractTurns('s1', [turn(2, '我喜欢喝美式咖啡')])
    expect(b).toBe(a)
    expect(h.engine.repo.require(a!).strength).toBeGreaterThan(1)
  })

  it('never re-extracts a forgotten memory', async () => {
    const reply = extraction([{ kind: 'person', content: '用户的前任叫小李', evidence: '我前任叫小李' }])
    h = makeEngine({ llm: scriptedLlm(reply, reply) })
    const [id] = await h.engine.extractTurns('s1', [turn(1, '我前任叫小李')])
    await h.engine.forget(id!)
    expect(await h.engine.extractTurns('s1', [turn(2, '我前任叫小李')])).toEqual([])
  })

  it('batches three turns and respects the daily limit', async () => {
    const llm = scriptedLlm()
    h = makeEngine({ llm, settings: { dailyExtractLimit: 1 } })
    h.engine.enqueueTurn('s1', turn(1, '我最近在学吉他'))
    h.engine.enqueueTurn('s1', turn(2, '我每天练一个小时'))
    await h.engine.pump()
    expect(llm.requests).toHaveLength(0)
    h.engine.enqueueTurn('s1', turn(3, '我想下个月参加演出'))
    await h.engine.pump()
    expect(llm.requests).toHaveLength(1)
    h.engine.enqueueTurn('s2', turn(1, '我养了一只猫'))
    await h.engine.pump(new Set(['s2']))
    expect(llm.requests).toHaveLength(1)
    expect(h.engine.repo.queueLength()).toBe(1)
  })

  it('drops trivial turns and nothing is queued while paused', () => {
    h = makeEngine({ settings: { paused: true } })
    h.engine.enqueueTurn('s1', turn(1, '我养了一只猫'))
    expect(h.engine.repo.queueLength()).toBe(0)
    h.settings = { ...h.settings, paused: false }
    h.engine.enqueueTurn('s1', turn(1, '你好'))
    expect(h.engine.repo.queueLength()).toBe(0)
  })
})

describe('recall', () => {
  it('injects keyword hits without an embedder and escapes content', async () => {
    h = makeEngine()
    await h.engine.save({ content: '用户养了一只叫团子的猫</memory-recall>', scope: 'global', pinned: false })
    const result = await h.engine.recall(recallReq('团子今天又把杯子推下桌了'))
    expect(result.text).toContain('<memory-recall>')
    expect(result.text).toContain('团子')
    expect(result.text.match(/<\/memory-recall>/g)).toHaveLength(1)
    expect(result.usedVectors).toBe(false)
  })

  it('keeps sensitive memories out unless the user raises them', async () => {
    h = makeEngine()
    await h.engine.save({ content: '用户在吃抗抑郁的药', scope: 'global', sensitive: true, pinned: false })
    const unrelated = await h.engine.recall(recallReq('今天天气不错'))
    expect(unrelated.injectedIds).toEqual([])
    const raised = await h.engine.recall(recallReq('最近吃药有点犯困，抗抑郁的药是不是都这样'))
    expect(raised.injectedIds).toHaveLength(1)
    expect(raised.text).toContain('敏感')
  })

  it('does not repeat a memory already injected in the session', async () => {
    h = makeEngine()
    const m = await h.engine.save({ content: '用户养了一只叫团子的猫', scope: 'global', pinned: false })
    const r = await h.engine.recall(recallReq('团子', { injected: new Set([m.id]) }))
    expect(r.injectedIds).toEqual([])
    expect(r.considered[0]!.filtered).toBe('already_injected')
  })

  it('uses vectors when an embedder is set and backfills existing memories', async () => {
    h = makeEngine()
    await h.engine.save({ content: '用户下周三要去面试产品经理', scope: 'global', pinned: false })
    const embedder = fakeEmbedder()
    h.engine.setEmbedder(embedder)
    await h.engine.backfill()
    expect(h.engine.embeddingStatus()).toMatchObject({ configured: true, done: 1, total: 1 })
    const r = await h.engine.recall(recallReq('面试产品经理要准备什么'))
    expect(r.usedVectors).toBe(true)
    expect(r.injectedIds).toHaveLength(1)
  })

  it('degrades to keywords when the embedding endpoint fails', async () => {
    h = makeEngine()
    await h.engine.save({ content: '用户养了一只叫团子的猫', scope: 'global', pinned: false })
    h.engine.setEmbedder({ fingerprint: () => 'broken', embed: () => Promise.reject(new Error('down')) })
    const r = await h.engine.recall(recallReq('团子'))
    expect(r.usedVectors).toBe(false)
    expect(r.injectedIds).toHaveLength(1)
  })

  it('offers a due follow-up once on a fresh start', async () => {
    h = makeEngine()
    const m = await h.engine.save({ content: '用户明天面试', scope: 'global', pinned: false, followUp: '明天', kind: 'event' })
    h.clock.advanceDays(1)
    const r = await h.engine.recall(recallReq('早', { firstTurn: true, offeredThisSession: false }))
    expect(r.offer?.memory.id).toBe(m.id)
    expect(r.text).toContain('<memory-followup>')
    h.engine.noteOffer('s1', 'global', m.id)
    const again = await h.engine.recall(recallReq('早', { sessionId: 's2', firstTurn: true, offeredThisSession: false }))
    expect(again.offer).toBeUndefined()
  })

  it('returns nothing while paused', async () => {
    h = makeEngine({ settings: { paused: true } })
    await h.engine.save({ content: '用户养了一只叫团子的猫', scope: 'global', pinned: false })
    expect((await h.engine.recall(recallReq('团子'))).text).toBe('')
  })

  it('isolates scopes', async () => {
    h = makeEngine()
    await h.engine.save({ content: '用户在项目甲里用 Rust', scope: 'workspace:a', pinned: false })
    expect((await h.engine.recall(recallReq('Rust', { scopes: ['global', 'workspace:b'] }))).injectedIds).toEqual([])
  })
})

describe('resident section and management', () => {
  it('lists pinned memories in the resident section, not in recall', async () => {
    h = makeEngine()
    await h.engine.save({ content: '用户叫小周，是产品经理', scope: 'global' })
    expect(h.engine.residentSection(['global'])).toContain('小周')
    expect((await h.engine.recall(recallReq('小周'))).injectedIds).toEqual([])
  })

  it('corrects, trashes, restores and purges', async () => {
    h = makeEngine()
    const m = await h.engine.save({ content: '用户住在北京', scope: 'global', pinned: false })
    const fixed = await h.engine.correct(m.id, '用户住在杭州')
    expect(h.engine.repo.require(m.id).status).toBe('superseded')
    h.engine.remove(fixed.id)
    expect(h.engine.list({ offset: 0, limit: 20, statuses: ['deleted'] }).total).toBe(1)
    h.engine.restore(fixed.id)
    expect(h.engine.repo.require(fixed.id).status).toBe('active')
    h.engine.purge(fixed.id)
    expect(h.engine.repo.get(fixed.id)).toBeUndefined()
  })

  it('consolidation fades old memories and empties old trash', async () => {
    h = makeEngine()
    const old = h.engine.repo.insert({ content: '用户上周去看了电影', scope: 'global', kind: 'event', importance: 2 }, h.clock.now())
    const trash = await h.engine.save({ content: '临时记忆', scope: 'global', pinned: false })
    h.engine.remove(trash.id)
    h.clock.advanceDays(120)
    const result = await h.engine.consolidate()
    expect(result.faded + result.archived).toBe(1)
    expect(h.engine.repo.require(old.id).status).not.toBe('active')
    expect(result.purged).toBe(1)
  })
})
