import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openMemoryDatabase, SCHEMA_VERSION, schemaVersion, SchemaTooNewError, TABLES } from '../src/index.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'her-memory-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const names = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts_%'").all() as { name: string }[])
    .map(row => row.name)

describe('openMemoryDatabase', () => {
  it('creates every table, the directory and an owner-only file', () => {
    const path = join(dir, 'nested', 'memory.db')
    const db = openMemoryDatabase({ path, busyTimeoutMs: 1000 })
    expect(names(db).sort()).toEqual([...TABLES].sort())
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION)
    db.close()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700)
  })

  it('reopens an existing database without migrating again', () => {
    const path = join(dir, 'memory.db')
    const first = openMemoryDatabase({ path, busyTimeoutMs: 1000 })
    first.prepare("INSERT INTO meta (key, value) VALUES ('probe', '1')").run()
    first.close()
    const second = openMemoryDatabase({ path, busyTimeoutMs: 1000 })
    expect(second.prepare("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({ value: '1' })
    second.close()
  })

  it('refuses a database written by a newer schema', () => {
    const path = join(dir, 'memory.db')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
    expect(() => openMemoryDatabase({ path, busyTimeoutMs: 1000 })).toThrow(SchemaTooNewError)
  })

  it('indexes segmented text with FTS5', () => {
    const db = openMemoryDatabase({ path: ':memory:', busyTimeoutMs: 1000 })
    db.prepare('INSERT INTO memory_fts (rowid, tokens) VALUES (?, ?)').run(1, '周末 去 爬山')
    expect(db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all('爬山')).toEqual([{ rowid: 1 }])
    db.close()
  })
})
