/**
 * SQLite schema of the memory database. Versions are monotonic and recorded in
 * `PRAGMA user_version`; each entry of {@link MIGRATIONS} moves the database
 * from version `index` to `index + 1` inside one transaction.
 */

/** Schema version this build reads and writes. */
export const SCHEMA_VERSION = 1

/** Memory categories from the product plan. */
export const MEMORY_KINDS = ['profile', 'event', 'promise', 'person', 'preference', 'shared'] as const

/** Memory lifecycle states from the product plan. */
export const MEMORY_STATUSES = ['active', 'faded', 'archived', 'superseded', 'deleted'] as const

const sqlList = (values: readonly string[]): string => values.map(value => `'${value}'`).join(', ')

const V1 = `
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${sqlList(MEMORY_KINDS)})),
  fact_key TEXT,
  occurred_at TEXT,
  learned_at TEXT NOT NULL,
  follow_up_at TEXT,
  importance INTEGER NOT NULL DEFAULT 2 CHECK (importance BETWEEN 1 AND 3),
  emotion TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${sqlList(MEMORY_STATUSES)})),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  mention_blocked INTEGER NOT NULL DEFAULT 0 CHECK (mention_blocked IN (0, 1)),
  source_session TEXT,
  source_turn INTEGER,
  scope TEXT NOT NULL DEFAULT 'global',
  strength REAL NOT NULL DEFAULT 1,
  reinforced_at TEXT,
  supersedes INTEGER REFERENCES memories(id),
  superseded_by INTEGER REFERENCES memories(id),
  needs_confirm INTEGER NOT NULL DEFAULT 0 CHECK (needs_confirm IN (0, 1)),
  people TEXT NOT NULL DEFAULT '[]',
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memories_scope_status ON memories(scope, status);
CREATE INDEX memories_fact_key ON memories(fact_key) WHERE fact_key IS NOT NULL;
CREATE INDEX memories_follow_up ON memories(follow_up_at) WHERE follow_up_at IS NOT NULL;

CREATE TABLE memory_vectors (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL
);

-- rowid equals memories.id; tokens are Intl.Segmenter words joined by spaces.
CREATE VIRTUAL TABLE memory_fts USING fts5(tokens, tokenize = 'unicode61');

CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',
  relation TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_people (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, person_id)
);

CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  fact_key TEXT,
  fingerprint TEXT,
  vector BLOB,
  created_at TEXT NOT NULL
);

CREATE TABLE proactive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  mentioned_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  responded INTEGER CHECK (responded IN (0, 1))
);
CREATE INDEX proactive_log_memory ON proactive_log(memory_id, mentioned_at);

CREATE TABLE recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  memory_id INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  filtered TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX recall_log_created ON recall_log(created_at);

CREATE TABLE extract_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, turn)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Ordered migrations; `MIGRATIONS[n]` upgrades version `n` to `n + 1`. */
export const MIGRATIONS: readonly string[] = [V1]

/** Tables every current database contains, in creation order. */
export const TABLES = [
  'memories',
  'memory_vectors',
  'memory_fts',
  'people',
  'memory_people',
  'suppressions',
  'proactive_log',
  'recall_log',
  'extract_queue',
  'meta',
] as const
