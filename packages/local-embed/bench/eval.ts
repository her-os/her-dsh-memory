/**
 * Effect and load test of one local model, run as its own process so memory
 * numbers are not mixed between models.
 *
 * Usage:
 *   node packages/local-embed/bench/eval.ts --root <cache-root> --model <id|keyword>
 *     [--set <set.json>] [--source auto] [--stress <memories>] [--out <results.jsonl>]
 *
 * `--model keyword` measures recall without vectors. The set is
 * `{ memories: string[], queries: { q, expect: number[] }[] }`; the default is
 * the public sample next to this file. Real evaluation sets stay outside the repo.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DEFAULT_PROMPTS, type Embedder, MemoryEngine, openMemoryDatabase, silentLogger } from '@her-os/memory-core'
import { type DownloadSource, LocalEmbedder, localModel } from '../src/index.ts'

interface EvalSet { name?: string; memories: string[]; queries: { q: string; expect: number[] }[] }

const { values: args } = parseArgs({
  options: {
    root: { type: 'string' },
    model: { type: 'string' },
    set: { type: 'string', default: join(import.meta.dirname, 'sample-set.json') },
    source: { type: 'string', default: 'auto' },
    stress: { type: 'string', default: '0' },
    out: { type: 'string' },
  },
})
if (args.root === undefined || args.model === undefined) throw new Error('usage: eval.ts --root <cache-root> --model <id|keyword> [--set file] [--stress n] [--out file]')
const set = JSON.parse(readFileSync(args.set, 'utf8')) as EvalSet
const stress = Number(args.stress)

const mb = (bytes: number): number => Math.round(bytes / 1e6)
const rss = (): number => mb(process.memoryUsage().rss)
/** Peak resident set so far, MB (`maxRSS` is in KiB). */
const peak = (): number => Math.round(process.resourceUsage().maxRSS * 1024 / 1e6)
const pct = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10
}
const round = (n: number, digits = 3): number => Math.round(n * 10 ** digits) / 10 ** digits

const result: Record<string, unknown> = { model: args.model, set: set.name ?? args.set, memories: set.memories.length, queries: set.queries.length, rssStartMB: rss() }

// ── the embedder ──────────────────────────────────────────────
let local: LocalEmbedder | undefined
if (args.model !== 'keyword') {
  const model = localModel(args.model)
  if (model === undefined) throw new Error(`unknown model ${args.model}`)
  const download = new LocalEmbedder({ model, root: args.root, source: args.source as DownloadSource, logger: console })
  if (!download.downloaded) {
    const started = performance.now()
    await download.prepare()
    result.downloadMs = Math.round(performance.now() - started)
    await download.dispose()
    if (!download.downloaded) throw new Error(`download failed: ${download.status().error ?? ''}`)
  }
  const before = rss()
  local = new LocalEmbedder({ model, root: args.root, source: args.source as DownloadSource })
  const started = performance.now()
  await local.prepare()
  if (local.status().state !== 'ready') throw new Error(`load failed: ${local.status().error ?? ''}`)
  result.loadMs = Math.round(performance.now() - started)
  result.rssLoadedMB = rss()
  result.rssModelMB = rss() - before

  // Pure vector ranking.
  const started2 = performance.now()
  const docs: Float32Array[] = []
  for (let i = 0; i < set.memories.length; i += 16) docs.push(...await local.embed(set.memories.slice(i, i + 16), undefined, 'document'))
  result.docsPerSecond = Math.round(set.memories.length / ((performance.now() - started2) / 1000))
  const latencies: number[] = []
  let hit1 = 0, hit3 = 0, rr = 0
  const misses: string[] = []
  for (const { q, expect } of set.queries) {
    const t = performance.now()
    const [query] = await local.embed([q], undefined, 'query')
    latencies.push(performance.now() - t)
    const ranked = docs.map((doc, i) => [doc.reduce((sum, v, d) => sum + v * query![d]!, 0), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)
    const rank = Math.min(...expect.map(i => ranked.indexOf(i)))
    if (rank === 0) hit1++
    if (rank < 3) hit3++
    else misses.push(`${q} → ${set.memories[ranked[0]!]}`)
    rr += 1 / (rank + 1)
  }
  Object.assign(result, {
    vectorHit1: round(hit1 / set.queries.length), vectorHit3: round(hit3 / set.queries.length), vectorMRR: round(rr / set.queries.length),
    queryMsP50: pct(latencies, 0.5), queryMsP95: pct(latencies, 0.95), vectorMisses: misses,
  })
}

// ── the real recall path ──────────────────────────────────────
const SUBJECTS = ['同事', '朋友', '表姐', '室友', '邻居', '老同学', '舅舅', '领导', '客户', '健身教练']
const THINGS = ['喜欢喝乌龙茶', '下周去青岛出差', '在学游泳', '养了一条金毛', '最近换了新手机', '想去云南旅游', '周末在家打游戏', '刚生了宝宝', '在准备考研', '开了一家花店', '腿受伤了', '搬去了深圳', '迷上了露营', '开始学钢琴', '每天加班到十点']
const synthetic = (n: number): string[] => Array.from({ length: n }, (_, i) => `用户的${SUBJECTS[i % SUBJECTS.length]}${String.fromCharCode(0x4e00 + (i * 7919) % 2000)}${THINGS[(i * 31) % THINGS.length]}（第${i}条）`)

async function recallRun(extra: number): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'her-memory-eval-'))
  const db = openMemoryDatabase({ path: join(dir, 'memory.db'), busyTimeoutMs: 1000 })
  const now = new Date('2026-11-10T02:00:00Z')
  const engine = new MemoryEngine({
    db, prompts: DEFAULT_PROMPTS, logger: silentLogger,
    clock: { now: () => now, timeZone: 'Asia/Shanghai', dayStartHour: 4 },
    llm: { complete: async () => '{"memories":[],"proactive":[]}' },
    settings: () => ({ paused: false, recallCount: 5, injectBudget: 800, embeddingTimeoutMs: 1500, proactive: 'off', dailyExtractLimit: 200 }),
  })
  try {
    const ids: number[] = []
    engine.repo.transaction(() => {
      for (const content of set.memories) ids.push(engine.repo.insert({ content, scope: 'global', kind: 'preference', importance: 2 }, now).id)
      for (const content of synthetic(extra)) engine.repo.insert({ content, scope: 'global', kind: 'event', importance: 2 }, now)
    })
    const out: Record<string, unknown> = {}
    if (local !== undefined) {
      const started = performance.now()
      engine.setEmbedder(local as Embedder)
      await engine.backfill()
      const status = engine.embeddingStatus()
      if (status.done !== status.total) throw new Error(`backfill stopped at ${status.done}/${status.total}: ${status.lastError ?? ''}`)
      out.backfillMs = Math.round(performance.now() - started)
      out.backfillPerSecond = Math.round(status.total / ((performance.now() - started) / 1000))
    }
    let hits = 0
    const latencies: number[] = []
    let vectorTurns = 0
    for (const [n, { q, expect }] of set.queries.entries()) {
      const t = performance.now()
      const recall = await engine.recall({ sessionId: `eval-${n}`, turn: 1, userText: q, scope: 'global', scopes: ['global'], injected: new Set(), firstTurn: false, offeredThisSession: true })
      latencies.push(performance.now() - t)
      if (recall.usedVectors) vectorTurns++
      if (expect.some(i => recall.injectedIds.includes(ids[i]!))) hits++
    }
    Object.assign(out, { recallHit5: round(hits / set.queries.length), recallMsP50: pct(latencies, 0.5), recallMsP95: pct(latencies, 0.95), vectorTurns, dbMB: mb(statSync(join(dir, 'memory.db')).size) })
    return out
  } finally {
    engine.dispose()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

result.recall = await recallRun(0)
if (stress > 0) result.stress = { memories: stress + set.memories.length, ...await recallRun(stress) }
result.rssPeakMB = peak()
await local?.dispose()
console.log(JSON.stringify(result, null, 2))
if (args.out !== undefined) appendFileSync(args.out, `${JSON.stringify(result)}\n`)
