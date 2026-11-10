/** Opening and migrating the memory database file. */

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts'

/** Options for {@link openMemoryDatabase}. */
export interface OpenOptions {
  /** Database file path, or `:memory:`. */
  path: string
  /** Milliseconds a writer waits for another process's lock. */
  busyTimeoutMs: number
}

/** Raised when the database was written by a newer build than this one. */
export class SchemaTooNewError extends Error {
  /**
   * @param found - the database's `user_version`.
   */
  constructor(readonly found: number) {
    super(`memory database schema version ${found} is newer than supported version ${SCHEMA_VERSION}`)
    this.name = 'SchemaTooNewError'
  }
}

/**
 * Open the memory database, creating its directory (0700) and file (0600)
 * when missing, and apply pending migrations.
 * @param options - file path and lock wait.
 * @returns the open connection; the caller closes it.
 * @throws {SchemaTooNewError} when the file's schema is newer than {@link SCHEMA_VERSION}.
 */
export function openMemoryDatabase(options: OpenOptions): DatabaseSync {
  const inMemory = options.path === ':memory:'
  const created = !inMemory && !existsSync(options.path)
  if (created) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(options.path, { timeout: options.busyTimeoutMs })
  try {
    if (created) chmodSync(options.path, 0o600)
    db.exec('PRAGMA foreign_keys = ON')
    if (!inMemory) db.exec('PRAGMA journal_mode = WAL')
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * Read the schema version recorded in the file.
 * @param db - an open connection.
 * @returns the `user_version` pragma value.
 */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  return row?.user_version ?? 0
}

function migrate(db: DatabaseSync): void {
  const found = schemaVersion(db)
  if (found > SCHEMA_VERSION) throw new SchemaTooNewError(found)
  for (let version = found; version < SCHEMA_VERSION; version++) {
    const step = MIGRATIONS[version]
    if (step === undefined) throw new Error(`memory database has no migration from version ${version}`)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(step)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
