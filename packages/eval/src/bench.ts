/**
 * Synthetic-scale benchmark of the per-turn recall path.
 *
 * Usage: node src/bench.ts [count=10000] [dim=1024]
 *
 * Builds a temporary database of `count` memories with `dim`-dimension vectors,
 * then measures recall time (excluding the embedding request), the longest
 * event-loop stall, heap use, and file size.
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { DEFAULT_PROMPTS, type Embedder, MEMORY_KINDS, MemoryEngine, openMemoryDatabase, silentLogger, systemClock } from '@her-os/memory-core'

const count = Number(process.argv[2] ?? 10_000)
const dim = Number(process.argv[3] ?? 1024)
const SUBJECTS = ['猫', '咖啡', '面试', '上海', '吉他', '跑步', '妈妈', '同事老王', '项目', '搬家', '旅行', '考试', '健身', '读书', '电影', '加班']
const VERBS = ['喜欢', '讨厌', '在准备', '提到过', '计划去', '最近在学', '担心', '想买']

let seed = 42
const rand = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31 }
const randomVector = (): Float32Array => Float32Array.from({ length: dim }, () => rand() * 2 - 1)

const embedder: Embedder = { fingerprint: () => `bench|${dim}`, embed: async texts => texts.map(randomVector) }

const dir = mkdtempSync(join(tmpdir(), 'her-memory-bench-'))
const path = join(dir, 'memory.db')
const db = openMemoryDatabase({ path, busyTimeoutMs: 1000 })
const engine = new MemoryEngine({
  db, llm: { complete: async () => '{}' }, clock: systemClock('Asia/Shanghai'), prompts: DEFAULT_PROMPTS, logger: silentLogger,
  settings: () => ({ paused: false, recallCount: 5, injectBudget: 800, embeddingTimeoutMs: 1500, proactive: 'low', dailyExtractLimit: 200 }),
})

let started = performance.now()
const now = new Date()
engine.repo.transaction(() => {
  for (let i = 0; i < count; i++) {
    const subject = SUBJECTS[i % SUBJECTS.length]!
    const m = engine.repo.insert({
      content: `用户${VERBS[i % VERBS.length]}${subject}，第${i}条记录，${SUBJECTS[(i * 7) % SUBJECTS.length]}相关`,
      kind: MEMORY_KINDS[i % MEMORY_KINDS.length]!, importance: 1 + (i % 3), scope: 'global',
    }, new Date(now.getTime() - (i % 365) * 86_400_000))
    engine.repo.putVector(m.id, embedder.fingerprint(), randomVector())
  }
})
const buildMs = performance.now() - started
engine.setEmbedder(embedder)

const loop = monitorEventLoopDelay({ resolution: 1 })
started = performance.now()
await engine.recall({ sessionId: 'warm', turn: 0, userText: '预热', scope: 'global', scopes: ['global'], injected: new Set(), firstTurn: false, offeredThisSession: true })
const indexLoadMs = performance.now() - started

loop.enable()
const timings: number[] = []
const walls: number[] = []
let offers = 0
for (let i = 0; i < 200; i++) {
  const wallStart = performance.now()
  const r = await engine.recall({
    sessionId: 'bench', turn: i, userText: `我最近${VERBS[i % VERBS.length]}${SUBJECTS[i % SUBJECTS.length]}，你怎么看`,
    scope: 'global', scopes: ['global'], injected: new Set(), firstTurn: i % 10 === 0, offeredThisSession: i % 10 !== 0,
  })
  timings.push(r.elapsedMs)
  walls.push(performance.now() - wallStart)
  if (r.offer !== undefined) offers++
  await new Promise(resolve => setTimeout(resolve, 1))
}
loop.disable()
timings.sort((a, b) => a - b)
const pct = (p: number): string => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))]!.toFixed(1)
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const result = {
  memories: count, dim,
  buildSeconds: +(buildMs / 1000).toFixed(1),
  firstRecallWithIndexLoadMs: Math.round(indexLoadMs),
  recallP50Ms: +pct(0.5), recallP95Ms: +pct(0.95), recallMaxMs: +timings.at(-1)!.toFixed(1),
  wallMaxMs: +Math.max(...walls).toFixed(1),
  wallP95Ms: +walls.sort((a, b) => a - b)[Math.floor(walls.length * 0.95)]!.toFixed(1),
  offers,
  eventLoopMaxStallMs: +(loop.max / 1e6).toFixed(1),
  heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
  rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
  dbMB: +(statSync(path).size / 2 ** 20).toFixed(1),
}
console.log(JSON.stringify(result, null, 2))
engine.dispose()
db.close()
rmSync(dir, { recursive: true, force: true })
