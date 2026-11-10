import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { type Clock, DEFAULT_PROMPTS, type EngineSettings, type Embedder, type LlmPort, MemoryEngine, openMemoryDatabase, silentLogger } from '../src/index.ts'

/** A clock fixed at an instant that tests can move. */
export interface TestClock extends Clock { set(iso: string): void; advanceDays(days: number): void }

export const testClock = (iso: string): TestClock => {
  let current = new Date(iso)
  return {
    now: () => new Date(current),
    timeZone: 'Asia/Shanghai',
    dayStartHour: 4,
    set: next => { current = new Date(next) },
    advanceDays: days => { current = new Date(current.getTime() + days * 86_400_000) },
  }
}

/** Embedder over a character-bigram bag hashed into 64 dimensions. */
export const fakeEmbedder = (fingerprint = 'fake|bigram|64'): Embedder & { calls: number } => {
  const embedder = {
    calls: 0,
    fingerprint: () => fingerprint,
    async embed(texts: readonly string[]) {
      embedder.calls++
      return texts.map(text => {
        const v = new Float32Array(64)
        const chars = [...text.replace(/\s/g, '')]
        for (let i = 0; i < chars.length - 1; i++) {
          let h = 0
          for (const c of chars[i]! + chars[i + 1]!) h = (h * 31 + c.codePointAt(0)!) >>> 0
          v[h % 64]! += 1
        }
        return v
      })
    },
  }
  return embedder
}

/** LLM port answering from a queue of canned replies. */
export const scriptedLlm = (...replies: string[]): LlmPort & { requests: { system: string; user: string }[] } => {
  const port = {
    requests: [] as { system: string; user: string }[],
    async complete(request: { system: string; user: string }) {
      port.requests.push({ system: request.system, user: request.user })
      return replies.shift() ?? '{"memories":[],"proactive":[]}'
    },
  }
  return port
}

export const defaultSettings: EngineSettings = {
  paused: false, recallCount: 5, injectBudget: 800, embeddingTimeoutMs: 1500, proactive: 'low', dailyExtractLimit: 200,
  extractBatchTurns: 3, extractIdleMs: 300_000, extractBeforeRecall: true,
}

export interface Harness { engine: MemoryEngine; db: DatabaseSync; clock: TestClock; settings: EngineSettings; dispose(): void }

export const makeEngine = (options: { llm?: LlmPort; clock?: TestClock; settings?: Partial<EngineSettings> } = {}): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'her-memory-engine-'))
  const db = openMemoryDatabase({ path: join(dir, 'memory.db'), busyTimeoutMs: 1000 })
  const clock = options.clock ?? testClock('2026-11-10T10:00:00+08:00')
  const harness: Harness = {
    db, clock, settings: { ...defaultSettings, ...options.settings },
    engine: undefined as unknown as MemoryEngine,
    dispose() { harness.engine.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
  harness.engine = new MemoryEngine({
    db, llm: options.llm ?? scriptedLlm(), clock, prompts: DEFAULT_PROMPTS, logger: silentLogger, settings: () => harness.settings,
  })
  return harness
}

export const extraction = (memories: Record<string, unknown>[], proactive: Record<string, unknown>[] = []): string =>
  JSON.stringify({ memories, proactive })
