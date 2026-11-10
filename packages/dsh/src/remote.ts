/**
 * The `herMemory` Remote service: the management page's only path into the
 * Host. One JSON-in, JSON-out method keeps the wire contract stable while the
 * page grows; {@link MemoryOps} validates every argument.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryOps, OpError } from './ops.ts'

declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface RemoteErrorDetailsMap {
    /** The payload was not a JSON object. */
    'her-memory/invalid-payload': { readonly op: string }
    /** The operation or its arguments were refused. */
    'her-memory/invalid-request': { readonly op: string }
    /** The operation failed in the Host. */
    'her-memory/failed': { readonly op: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    herMemory: HerMemoryRemote
  }
}

/** Remote facade over {@link MemoryOps}. */
export class HerMemoryRemote extends TypertRemoteService {
  private readonly ops: MemoryOps

  /**
   * @param ctx - owning context.
   * @param config - carries the operation dispatcher.
   * @param config.ops - the dispatcher.
   */
  constructor(ctx: Context, config: { ops: MemoryOps }) {
    super(ctx, 'herMemory')
    this.ops = config.ops
  }

  /**
   * Run one management operation.
   * @param op - operation name, e.g. `list` or `patch`.
   * @param payload - JSON text of the operation's arguments.
   * @returns JSON text of the result.
   */
  @Remote('call')
  async call(op: string, payload: string): Promise<string> {
    let args: unknown
    try {
      args = payload === '' ? {} : JSON.parse(payload)
    } catch {
      throw new RemoteError('her-memory/invalid-payload', 'payload is not JSON', { op })
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new RemoteError('her-memory/invalid-payload', 'payload must be a JSON object', { op })
    try {
      return JSON.stringify(await this.ops.run(op, args as Record<string, unknown>)) ?? 'null'
    } catch (error) {
      if (error instanceof OpError) throw new RemoteError('her-memory/invalid-request', error.message, { op })
      throw new RemoteError('her-memory/failed', error instanceof Error ? error.message : String(error), { op })
    }
  }
}
