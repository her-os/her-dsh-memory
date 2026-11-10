/** Plugin Config and its resolution into concrete values. */

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Values the plugin receives from cordis.yml or the settings page. */
export interface Config {
  /** Database file path; empty selects `$DSH_HOME/her-memory/memory.db`. */
  dbPath?: string | undefined
  /** Milliseconds a write waits for another DSH process holding the database lock. */
  busyTimeoutMs: number
}

/** Schemastery declaration of {@link Config}. */
export const Config: z<Config> = z.object({
  dbPath: z.string().description('记忆库文件路径。留空时用 $DSH_HOME/her-memory/memory.db。'),
  busyTimeoutMs: z.natural().min(100).max(60000).default(5000)
    .description('另一个 DSH 进程正在写库时，本进程最多等待的毫秒数。'),
})

/** Concrete settings derived from {@link Config}. */
export interface ResolvedConfig {
  dbPath: string
  busyTimeoutMs: number
}

/**
 * Fill defaults that depend on the environment.
 * @param config - the validated plugin Config.
 * @param env - environment that supplies `DSH_HOME`.
 * @returns the database path and lock wait to use.
 */
export function resolveConfig(config: Config, env: Record<string, string | undefined> = process.env): ResolvedConfig {
  const configured = config.dbPath?.trim()
  return {
    dbPath: configured ? configured : join(resolveDshHome(undefined, env), 'her-memory', 'memory.db'),
    busyTimeoutMs: config.busyTimeoutMs,
  }
}
