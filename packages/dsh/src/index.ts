/** Host half of the Her memory plugin: owns the memory database for the process. */

import type { Context } from '@deepseek-ai/cordis'
import { openMemoryDatabase } from '@her-os/memory-core'
import { Config, resolveConfig } from './config.ts'

export { Config }

/** Plugin name shown in logs. */
export const name = 'her-memory'

/**
 * Open the memory database for the lifetime of this plugin instance.
 * @param ctx - the plugin context.
 * @param config - the validated plugin Config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.effect(() => {
    const db = openMemoryDatabase({ path: resolved.dbPath, busyTimeoutMs: resolved.busyTimeoutMs })
    ctx.logger.info('memory database ready at %s', resolved.dbPath)
    return () => { db.close() }
  }, 'her-memory: database')
}
