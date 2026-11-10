import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROMPTS, MemoryEngine, openMemoryDatabase, silentLogger } from '@her-os/memory-core'
import { LocalEmbedder, localModel, modelDir, type LocalStatus } from '@her-os/memory-local-embed'
import { afterEach, describe, expect, it } from 'vitest'
import { localStatusLine } from '../src/commands.ts'
import { MemoryOps, OpError } from '../src/ops.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'her-memory-local-ops-'))
  const db = openMemoryDatabase({ path: join(dir, 'memory.db'), busyTimeoutMs: 1000 })
  const engine = new MemoryEngine({
    db, prompts: DEFAULT_PROMPTS, logger: silentLogger,
    clock: { now: () => new Date('2026-11-10T02:00:00Z'), timeZone: 'Asia/Shanghai', dayStartHour: 4 },
    llm: { complete: async () => '{"memories":[],"proactive":[]}' },
    settings: () => ({ paused: false, recallCount: 5, injectBudget: 800, embeddingTimeoutMs: 1500, proactive: 'low', dailyExtractLimit: 200, extractBatchTurns: 3, extractIdleMs: 300_000, extractBeforeRecall: true }),
  })
  const root = join(dir, 'embedding')
  // A fetch that never answers, so nothing leaves the machine.
  const local = new LocalEmbedder({ model: localModel('bge-small-zh')!, root, source: 'auto', fetchImpl: (() => new Promise(() => {})) as typeof fetch })
  const ops = new MemoryOps({ engine, embedding: { provider: 'local', embedder: local, local, root }, paused: () => false, setPaused: () => {} })
  cleanups.push(() => { void local.dispose(); engine.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { ops, root }
}

const call = (ops: MemoryOps, op: string, payload: Record<string, unknown> = {}): Promise<unknown> => ops.run(op, payload)

describe('local model ops', () => {
  it('lists the catalog with the selected and downloaded models', async () => {
    const { ops, root } = setup()
    mkdirSync(modelDir(root, 'multilingual-e5-small'), { recursive: true })
    writeFileSync(join(modelDir(root, 'multilingual-e5-small'), '.complete'), '{}')
    const catalog = await call(ops, 'localModels') as { models: { id: string; selected: boolean; downloaded: boolean; downloadMB: number }[] }
    expect(catalog.models.map(m => m.id)).toContain('embeddinggemma-q4')
    expect(catalog.models.find(m => m.id === 'bge-small-zh')).toMatchObject({ selected: true, downloaded: false })
    expect(catalog.models.find(m => m.id === 'multilingual-e5-small')).toMatchObject({ selected: false, downloaded: true })
    expect(catalog.models.every(m => m.downloadMB > 0)).toBe(true)
  })

  it('deletes an unused model and refuses the one in use', async () => {
    const { ops, root } = setup()
    mkdirSync(modelDir(root, 'bge-m3'), { recursive: true })
    writeFileSync(join(modelDir(root, 'bge-m3'), '.complete'), '{}')
    await call(ops, 'deleteLocalModel', { id: 'bge-m3' })
    const catalog = await call(ops, 'localModels') as { models: { id: string; downloaded: boolean }[] }
    expect(catalog.models.find(m => m.id === 'bge-m3')?.downloaded).toBe(false)
    await expect(ops.run('deleteLocalModel', { id: 'bge-small-zh' })).rejects.toThrow(OpError)
    await expect(ops.run('deleteLocalModel', { id: '../x' })).rejects.toThrow(OpError)
  })

  it('reports the local state in the overview', async () => {
    const { ops } = setup()
    const overview = await call(ops, 'overview') as { embedding: { provider: string; local: { model: string; downloaded: boolean } } }
    expect(overview.embedding.provider).toBe('local')
    expect(overview.embedding.local).toMatchObject({ model: 'bge-small-zh', downloaded: false })
  })
})

describe('localStatusLine', () => {
  const base: LocalStatus = { model: 'bge-small-zh', state: 'idle', received: 0, total: 0, downloaded: false, error: null }
  it('describes each state', () => {
    expect(localStatusLine({ ...base, state: 'downloading', received: 50e6, total: 100e6 })).toContain('50 MB/100 MB')
    expect(localStatusLine({ ...base, state: 'error', error: 'boom' })).toContain('boom')
    expect(localStatusLine({ ...base, downloaded: true })).toContain('已下载')
    expect(localStatusLine({ ...base, state: 'unsupported' })).toContain('不支持')
  })
})
