/** Extraction model calls through the DSH LLM runtime. */

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmPort } from '@her-os/memory-core'

/** Provider route of one call. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** Output cap of one extraction call. */
export const EXTRACT_MAX_TOKENS = 8000

/** A model call that ended other than by a normal stop. */
export class ExtractionCallError extends Error {
  override name = 'ExtractionCallError'
}

/**
 * Build the engine's model port.
 * @param runtime - current DSH LLM runtime, read on every call so a reloaded runtime is picked up.
 * @param route - picks the provider and model for a session, or `undefined` when none is known.
 * @returns the port.
 */
export function createLlmPort(runtime: () => LlmRuntime | undefined, route: (sessionId: string | undefined) => ModelRoute | undefined): LlmPort {
  return {
    async complete({ system, user, signal, sessionId }) {
      const llm = runtime()
      if (llm === undefined) throw new ExtractionCallError('the DSH LLM runtime is not available')
      const target = route(sessionId)
      if (target === undefined) throw new ExtractionCallError('no model is configured for memory extraction')
      const call = await llm.prepareCall({ provider: target.provider, model: target.model, maxTokens: EXTRACT_MAX_TOKENS }, signal)
      let text = ''
      let reason: string | undefined
      const stream = call.stream({
        ...call.config,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        ...(signal === undefined ? {} : { signal }),
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') reason = chunk.reason.kind
      }
      if (reason !== 'stop') throw new ExtractionCallError(`extraction call ended with ${reason ?? 'no finish'}`)
      return text
    },
  }
}
