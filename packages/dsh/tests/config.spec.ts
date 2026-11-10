import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('places the database under DSH_HOME by default', () => {
    const config = Config({} as Config)
    expect(resolveConfig(config, { DSH_HOME: '/tmp/dsh-home' })).toEqual({
      dbPath: join('/tmp/dsh-home', 'her-memory', 'memory.db'),
      busyTimeoutMs: 5000,
    })
  })

  it('uses an explicit path as given', () => {
    const config = Config({ dbPath: '/data/her.db', busyTimeoutMs: 800 })
    expect(resolveConfig(config, {})).toEqual({ dbPath: '/data/her.db', busyTimeoutMs: 800 })
  })

  it('rejects a lock wait below 100ms', () => {
    expect(() => Config({ busyTimeoutMs: 10 } as Config)).toThrow()
  })
})
