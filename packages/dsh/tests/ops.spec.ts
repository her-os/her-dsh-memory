import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROMPTS, MemoryEngine, openMemoryDatabase, silentLogger } from '@her-os/memory-core'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryApi, type MemoryItem } from '../src/client/api.ts'
import { draftPatch } from '../src/client/draft.ts'
import { MemoryOps, OpError } from '../src/ops.ts'

interface Harness { engine: MemoryEngine; clock: { now(): Date }; dispose(): void }

const makeEngine = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'her-memory-ops-'))
  const db = openMemoryDatabase({ path: join(dir, 'memory.db'), busyTimeoutMs: 1000 })
  const clock = { now: () => new Date('2026-11-10T02:00:00Z'), timeZone: 'Asia/Shanghai', dayStartHour: 4 }
  const engine = new MemoryEngine({
    db, clock, prompts: DEFAULT_PROMPTS, logger: silentLogger,
    llm: { complete: async () => '{"memories":[],"proactive":[]}' },
    settings: () => ({ paused: false, recallCount: 5, injectBudget: 800, embeddingTimeoutMs: 1500, proactive: 'low', dailyExtractLimit: 200, extractBatchTurns: 3, extractIdleMs: 300_000, extractBeforeRecall: true }),
  })
  return { engine, clock, dispose() { engine.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

let h: Harness | undefined
afterEach(() => { h?.dispose(); h = undefined })

const setup = () => {
  h = makeEngine()
  let paused = false
  const ops = new MemoryOps({
    engine: h.engine,
    embedding: { provider: 'off', embedder: null, local: undefined, root: join(tmpdir(), 'her-memory-ops-embedding') },
    paused: () => paused,
    setPaused: (next) => { paused = next },
  })
  const add = (content: string, extra: Record<string, unknown> = {}) =>
    h!.engine.repo.insert({ content, scope: 'global', kind: 'preference', importance: 2, ...extra }, h!.clock.now())
  return { ops, add }
}

describe('MemoryOps', () => {
  it('reports the overview and toggles pause', async () => {
    const { ops, add } = setup()
    add('用户喜欢猫')
    expect(await ops.run('overview', {})).toMatchObject({ paused: false, counts: { active: 1 }, queue: 0, extractError: null, embedding: { configured: false } })
    expect(await ops.run('setPaused', { paused: true })).toEqual({ paused: true })
    expect(await ops.run('overview', {})).toMatchObject({ paused: true })
  })

  it('lists with filters and clamps the page size', async () => {
    const { ops, add } = setup()
    add('用户喜欢猫', { pinned: true })
    add('用户喜欢狗')
    const pinned = await ops.run('list', { statuses: ['active'], pinned: true, limit: 9999 }) as { total: number; items: { content: string }[] }
    expect(pinned.total).toBe(1)
    expect(pinned.items[0]!.content).toBe('用户喜欢猫')
    const searched = await ops.run('list', { search: '狗' }) as { total: number }
    expect(searched.total).toBe(1)
  })

  it('patches only whitelisted fields and refuses lifecycle statuses', async () => {
    const { ops, add } = setup()
    const memory = add('用户喜欢猫')
    const patched = await ops.run('patch', { id: memory.id, patch: { pinned: true, importance: 7, sourceSession: 'x' } }) as { pinned: boolean; importance: number; sourceSession: string | null }
    expect(patched.pinned).toBe(true)
    expect(patched.importance).toBe(3)
    expect(patched.sourceSession).toBeNull()
    await expect(ops.run('patch', { id: memory.id, patch: { status: 'deleted' } })).rejects.toBeInstanceOf(OpError)
    await expect(ops.run('patch', { id: memory.id, patch: {} })).rejects.toThrow('patch is empty')
  })

  it('corrects into a new version and keeps history', async () => {
    const { ops, add } = setup()
    const memory = add('用户住在北京')
    const next = await ops.run('correct', { id: memory.id, content: '用户住在上海' }) as { id: number }
    const detail = await ops.run('detail', { id: next.id }) as { memory: { content: string }; history: { id: number }[] }
    expect(detail.memory.content).toBe('用户住在上海')
    expect(detail.history.map(old => old.id)).toContain(memory.id)
  })

  it('moves through trash and empties it', async () => {
    const { ops, add } = setup()
    const a = add('用户喜欢猫')
    const b = add('用户喜欢狗')
    await ops.run('remove', { id: a.id })
    await ops.run('remove', { id: b.id })
    await ops.run('restore', { id: a.id })
    expect((await ops.run('list', { statuses: ['deleted'] }) as { total: number }).total).toBe(1)
    expect(await ops.run('emptyTrash', {})).toEqual({ purged: 1 })
    await expect(ops.run('detail', { id: b.id })).rejects.toThrow('memory not found')
  })

  it('forgets into a suppression that can be lifted', async () => {
    const { ops, add } = setup()
    const memory = add('用户的前任叫小王')
    await ops.run('forget', { id: memory.id })
    const suppressions = await ops.run('suppressions', {}) as { id: number; summary: string }[]
    expect(suppressions).toHaveLength(1)
    await ops.run('removeSuppression', { id: suppressions[0]!.id })
    expect(await ops.run('suppressions', {})).toEqual([])
  })

  it('refuses unknown ops, bad ids and unconfigured embedding tests', async () => {
    const { ops } = setup()
    await expect(ops.run('drop', {})).rejects.toThrow('unknown op drop')
    await expect(ops.run('detail', { id: '1' })).rejects.toThrow('id must be an integer')
    await expect(ops.run('testEmbedding', {})).rejects.toThrow('embedding is not configured')
    await expect(ops.run('list', { kind: 'secret' })).rejects.toThrow('unknown kind')
  })
})

describe('createMemoryApi', () => {
  it('sends JSON and parses the reply', async () => {
    const calls: [string, string][] = []
    const api = createMemoryApi(async (op, payload) => {
      calls.push([op, payload])
      return { ok: true, value: JSON.stringify({ total: 0, items: [] }) }
    })
    expect(await api.list({ statuses: ['active'] }, 0, 100)).toEqual({ total: 0, items: [] })
    expect(calls).toEqual([['list', '{"statuses":["active"],"offset":0,"limit":100}']])
  })

  it('throws the Remote error message', async () => {
    const api = createMemoryApi(async () => ({ ok: false, error: { code: 'her-memory/invalid-request', message: 'patch is empty' } }) as never)
    await expect(api.patch(1, {})).rejects.toThrow('patch is empty')
  })
})

describe('draftPatch', () => {
  const memory = {
    id: 1, content: '用户喜欢猫', kind: 'preference', people: ['小王'], occurredAt: null, followUpAt: null, importance: 2,
  } as unknown as MemoryItem

  it('is empty when nothing but content changed', () => {
    expect(draftPatch(memory, { content: '改了', kind: 'preference', people: '小王', occurredAt: '', followUpAt: '', importance: 2 })).toEqual({})
  })

  it('carries changed fields and accepts Chinese separators', () => {
    expect(draftPatch(memory, { content: '', kind: 'event', people: '小王，小李', occurredAt: '2026-11-01', followUpAt: 'bad', importance: 3 }))
      .toEqual({ kind: 'event', people: ['小王', '小李'], occurredAt: '2026-11-01', importance: 3 })
  })
})
