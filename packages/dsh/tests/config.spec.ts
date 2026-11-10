import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config as ConfigSchema, type Config as Settings, type ConfigInput, parseModelRoute, readConfig, resolveConfig, scopeOf } from '../src/config.ts'

/** Validate settings and read their values, as the plugin does. */
const Config = (input: ConfigInput): Settings => readConfig(ConfigSchema(input))

describe('resolveConfig', () => {
  it('places the database under DSH_HOME by default', () => {
    const config = Config({})
    expect(resolveConfig(config, { DSH_HOME: '/tmp/dsh-home' })).toEqual({
      dbPath: join('/tmp/dsh-home', 'her-memory', 'memory.db'),
      busyTimeoutMs: 5000,
      embeddingRoot: join('/tmp/dsh-home', 'her-memory', 'embedding'),
    })
  })

  it('downloads the default local model from any mirror by default', () => {
    const config = Config({})
    expect(config.embedding).toMatchObject({ provider: 'local', localModel: 'embeddinggemma-q4', downloadSource: 'auto', unloadAfterMinutes: 0 })
  })

  it('uses an explicit path as given', () => {
    const config = Config({ dbPath: '/data/her.db', busyTimeoutMs: 800 })
    expect(resolveConfig(config, {})).toMatchObject({ dbPath: '/data/her.db', busyTimeoutMs: 800 })
  })

  it('rejects a lock wait below 100ms', () => {
    expect(() => Config({ busyTimeoutMs: 10 })).toThrow()
  })
})

describe('Config defaults', () => {
  it('fills the memory settings', () => {
    const config = Config({})
    expect(config).toMatchObject({
      paused: false, scope: 'global', proactive: 'low', recallCount: 5, injectBudget: 800,
      dailyExtractLimit: 200, extractModel: '', extractBatchTurns: 3, extractIdleMinutes: 5, extractBeforeRecall: true,
      embedding: { baseURL: '', apiKey: '', model: '', dimensions: 0, timeoutMs: 1500 },
    })
  })

  it('bounds the embedding time limit to 500–10000 ms', () => {
    expect(() => Config({ embedding: { timeoutMs: 400 } })).toThrow()
    expect(() => Config({ embedding: { timeoutMs: 10_001 } })).toThrow()
    expect(Config({ embedding: { timeoutMs: 10_000 } }).embedding.timeoutMs).toBe(10_000)
  })

  it('rejects unknown scope and proactive values', () => {
    expect(() => Config({ scope: 'team' } as unknown as ConfigInput)).toThrow()
    expect(() => Config({ proactive: 'high' } as unknown as ConfigInput)).toThrow()
  })
})

describe('parseModelRoute', () => {
  it('splits at the first colon', () => {
    expect(parseModelRoute(' deepseek:deepseek-v4:flash ')).toEqual({ provider: 'deepseek', model: 'deepseek-v4:flash' })
  })

  it('ignores empty and malformed values', () => {
    expect(parseModelRoute('')).toBeUndefined()
    expect(parseModelRoute('deepseek')).toBeUndefined()
    expect(parseModelRoute(':model')).toBeUndefined()
    expect(parseModelRoute('provider:')).toBeUndefined()
  })
})

describe('scopeOf', () => {
  it('keeps everything global by default', () => {
    expect(scopeOf('global', { agentPreset: 'her', cwd: '/w' })).toEqual({ scope: 'global', scopes: ['global'] })
  })

  it('separates presets and still sees global memories', () => {
    expect(scopeOf('preset', { agentPreset: 'her' })).toEqual({ scope: 'preset:her', scopes: ['global', 'preset:her'] })
    expect(scopeOf('preset', {})).toEqual({ scope: 'preset:default', scopes: ['global', 'preset:default'] })
  })

  it('separates workspaces and falls back to global without a directory', () => {
    expect(scopeOf('workspace', { cwd: '/w' })).toEqual({ scope: 'workspace:/w', scopes: ['global', 'workspace:/w'] })
    expect(scopeOf('workspace', {})).toEqual({ scope: 'global', scopes: ['global'] })
  })
})

describe('settings exposed to the page', () => {
  it('marks every field the page edits as live, and keeps deployment fields fixed', () => {
    const live = ConfigSchema({})
    const isLive = (value: unknown): boolean => typeof (value as { get?: unknown } | undefined)?.get === 'function'
    for (const key of ['paused', 'scope', 'proactive', 'recallCount', 'injectBudget', 'dailyExtractLimit', 'extractBatchTurns', 'extractIdleMinutes', 'extractBeforeRecall', 'extractModel'] as const) expect(isLive(live[key]), key).toBe(true)
    for (const value of Object.values(live.embedding)) expect(isLive(value)).toBe(true)
    expect(isLive(live.busyTimeoutMs)).toBe(false)
  })
})
