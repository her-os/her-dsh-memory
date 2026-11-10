/**
 * Local stand-in for the Anthropic Messages endpoint DSH's DeepSeek provider
 * calls. Every request is recorded; a test-supplied function picks each reply.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_PROMPTS } from '@her-os/memory-core'

/** One recorded model request. */
export interface ModelRequest {
  /** System prompt flattened to text. */
  readonly system: string
  /** Text of every message, in order, one string per message. */
  readonly messages: readonly { role: string; text: string }[]
  /** Text of the last user message. */
  readonly lastUser: string
  /** Names of the tools offered. */
  readonly tools: readonly string[]
  /** True when this is the memory plugin's extraction call. */
  readonly extraction: boolean
  /** The parsed body as sent. */
  readonly body: Record<string, unknown>
}

/** What the mock answers with. */
export type Reply =
  | { readonly text: string }
  | { readonly tool: { readonly name: string; readonly input: Record<string, unknown> } }
  | { readonly status: number }

/** A running mock. */
export interface MockModel {
  /** Base URL to put in `DEEPSEEK_BASE_URL`. */
  readonly baseURL: string
  readonly requests: ModelRequest[]
  /** Replace the reply policy. */
  respond(policy: (request: ModelRequest) => Reply): void
  close(): Promise<void>
}

/** Plain chat answer used when a test sets no policy. */
export const DEFAULT_ANSWER = '好的，我听着呢。'

const EXTRACT_MARK = DEFAULT_PROMPTS.extractSystem.slice(0, 20)

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: Record<string, unknown>) => {
    if (block.type === 'text') return String(block.text)
    if (block.type === 'tool_result') return `[tool_result] ${textOf(block.content)}`
    if (block.type === 'tool_use') return `[tool_use ${String(block.name)}] ${JSON.stringify(block.input)}`
    return ''
  }).join('\n')
}

const recordOf = (body: Record<string, unknown>): ModelRequest => {
  const system = textOf(body.system)
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((m: Record<string, unknown>) => ({ role: String(m.role), text: textOf(m.content) }))
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.text ?? ''
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((t: Record<string, unknown>) => String(t.name))
  return { system, messages, lastUser, tools, extraction: system.includes(EXTRACT_MARK), body }
}

function stream(res: ServerResponse, n: number, reply: Exclude<Reply, { status: number }>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (event: string, data: Record<string, unknown>): void => { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`) }
  send('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  if ('text' in reply) {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } })
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: reply.tool.name, input: {} } })
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) } })
  }
  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 5 } })
  send('message_stop', {})
  res.end()
}

/**
 * Start the mock on a free local port.
 * @returns the running mock.
 */
export async function startMockModel(): Promise<MockModel> {
  const requests: ModelRequest[] = []
  let policy: (request: ModelRequest) => Reply = () => ({ text: DEFAULT_ANSWER })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      let body: Record<string, unknown> | undefined
      try { body = raw === '' ? undefined : JSON.parse(raw) as Record<string, unknown> } catch { body = undefined }
      if (req.url?.includes('/messages') !== true || body === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      const request = recordOf(body)
      requests.push(request)
      let reply: Reply
      try { reply = policy(request) } catch (error) { reply = { status: 500 }; console.error(error) }
      if ('status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'mock failure' } }))
        return
      }
      if (body.stream === true) { stream(res, requests.length, reply); return }
      const content = 'text' in reply ? [{ type: 'text', text: reply.text }] : [{ type: 'tool_use', id: `toolu_${requests.length}`, name: reply.tool.name, input: reply.tool.input }]
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'mock', content,
        stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
      }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/anthropic`,
    requests,
    respond(next) { policy = next },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

/**
 * The extraction JSON the plugin expects.
 * @param memories - memory entries in the prompt's output format.
 * @returns the reply text.
 */
export const extractionReply = (memories: Record<string, unknown>[]): Reply => ({ text: JSON.stringify({ memories, proactive: [] }) })
