/**
 * Remote definition of `herMemory/call`, written by hand in the shape
 * `@deepseek-ai/dsh-typert-generator` emits. The generator only analyzes
 * packages inside the DSH monorepo, so this package cannot run it; the method
 * is one string-in, string-out call, which keeps the definition small and
 * stable. `remote.ts` must stay in step with it.
 */

import type { TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

/** Package that owns the method. */
export const PACKAGE = '@her-os/dsh-memory'

/** Service key the Host registers and the Client mounts. */
export const SERVICE = 'herMemory'

const SUMMARY = 'Run one Her memory management operation. `payload` and the result are JSON text.'

const text = (symbol: string, description?: string): TypertRemoteCodecSpec => ({
  mode: 'strict',
  typeSymbol: `${PACKAGE}#${SERVICE}/call:${symbol}`,
  create: () => z.string(),
  jsonSchema: { type: 'string' },
  ...(description === undefined ? {} : { description }),
})

const parameter = (name: string, description: string) => ({
  name,
  description,
  source: 'json' as const,
  codec: text(name),
  strictCodec: text(name),
})

/** The lazy Remote info both faces assemble from. */
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: PACKAGE,
  methods: {
    [`${SERVICE}/call`]: {
      service: SERVICE,
      description: SUMMARY,
      invocation: { kind: 'direct' },
      parameters: [
        parameter('op', 'operation name, e.g. `list` or `patch`.'),
        parameter('payload', 'JSON text of the operation\'s arguments.'),
      ],
      result: text('result', 'JSON text of the result.'),
      sourceLocation: { file: 'packages/dsh/src/remote.ts', line: 48, column: 3 },
    },
  },
}, z)

/** Signature the Host model reports for the method. */
export const CALL_SIGNATURE = '@Remote(\'call\') async call(op: string, payload: string): Promise<string>'
