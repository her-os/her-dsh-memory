/** Model-facing memory tools. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Memory, MemoryEngine } from '@her-os/memory-core'
import type { SessionScope } from './config.ts'

/** What the tools need from the plugin. */
export interface ToolHost {
  readonly engine: MemoryEngine
  /** Scope of the calling agent's session. */
  scopeOf(agent: Agent | undefined): SessionScope
  paused(): boolean
}

const line = (memory: Memory): string => {
  const flags = [memory.status === 'active' ? '' : memory.status, memory.pinned ? 'pinned' : '', memory.sensitive ? 'sensitive' : ''].filter(Boolean)
  return `#${memory.id} ${memory.content}${flags.length === 0 ? '' : ` (${flags.join(', ')})`}`
}

const MEMORY_OBJECT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    content: { type: 'string' },
    status: { type: 'string' },
  },
} as const

const view = (memory: Memory): { id: number; content: string; status: string } => ({ id: memory.id, content: memory.content, status: memory.status })

/**
 * Build the four memory tools.
 * @param host - engine and session scope lookup.
 * @returns the tool definitions.
 */
export function memoryTools(host: ToolHost): ToolDefinition[] {
  const visible = async (id: number, agent: Agent | undefined): Promise<Memory> => {
    const memory = host.engine.repo.get(id)
    if (memory === undefined || memory.status === 'deleted' || !host.scopeOf(agent).scopes.includes(memory.scope)) throw new Error(`memory #${id} does not exist`)
    return memory
  }
  return [
    defineTool({
      name: 'memory_search',
      description: 'Search long-term memories about the user, including archived and outdated ones. Use when the user asks whether you remember something, or when the automatically recalled memories are not enough. Results show the memory ids that memory_correct and memory_forget take.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for, in the user\'s words.' },
        limit: { type: 'integer', description: 'Maximum results; default 8.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { results: { type: 'array', items: MEMORY_OBJECT } } },
        render: (_args, value) => [{ type: 'text', text: (value.results ?? []).length === 0 ? 'No matching memories.' : (value.results ?? []).map(m => `#${m.id} ${m.content}${m.status === 'active' ? '' : ` (${m.status})`}`).join('\n') }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const hits = await host.engine.search(args.query, host.scopeOf(exec.agent).scopes, Math.min(20, Math.max(1, args.limit ?? 8)))
        return { results: hits.map(hit => view(hit.memory)) }
      },
    }),
    defineTool({
      name: 'memory_save',
      description: 'Save something the user explicitly asked you to remember. Write one fact in the third person ("用户…"), keeping the user\'s hedges such as "可能" or "打算". Do not save on your own initiative; ordinary conversation is remembered automatically.',
      parameters: {
        content: { type: 'string', required: true, description: 'The fact to keep, one sentence.' },
        kind: {
          type: 'string',
          enum: ['profile', 'preference', 'person', 'promise', 'event', 'shared'],
          description: 'profile: who the user is (home, job, family, pets); preference: likes, dislikes, how they want to be treated; person: someone in their life; promise: a plan or something to follow up; event: something that happened to them; shared: something the user and you did or agreed together. Default profile.',
        },
        sensitive: { type: 'boolean', description: 'Health, money, relationships, or other private matters.' },
        follow_up: { type: 'string', description: 'When to ask about it again, as the user said it, e.g. "下周三".' },
      },
      output: {
        schema: MEMORY_OBJECT,
        render: (_args, value) => [{ type: 'text', text: `Saved as #${value.id}.` }],
      },
      async execute(args, exec) {
        if (host.paused()) throw new Error('memory is paused by the user; nothing was saved')
        const memory = await host.engine.save({
          content: args.content, scope: host.scopeOf(exec.agent).scope, sensitive: args.sensitive ?? false, ...args.kind === undefined ? {} : { kind: args.kind },
          followUp: args.follow_up ?? null, sessionId: exec.agent?.session.id ?? null,
        })
        return view(memory)
      },
    }),
    defineTool({
      name: 'memory_correct',
      description: 'Replace a memory that the user says is wrong or out of date. The old version is kept as history.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Memory id from memory_search.' },
        content: { type: 'string', required: true, description: 'The corrected fact, third person.' },
      },
      output: {
        schema: MEMORY_OBJECT,
        render: (args, value) => [{ type: 'text', text: `#${args.id} corrected; current version is #${value.id}.` }],
      },
      async execute(args, exec) {
        await visible(args.id, exec.agent)
        return view(await host.engine.correct(args.id, args.content))
      },
    }),
    defineTool({
      name: 'memory_forget',
      description: 'Forget a memory because the user asked you to. It will not be recalled or learned again.',
      parameters: {
        id: { type: 'integer', required: true, description: 'Memory id from memory_search.' },
      },
      output: {
        schema: MEMORY_OBJECT,
        render: (args) => [{ type: 'text', text: `#${args.id} forgotten.` }],
      },
      async execute(args, exec) {
        await visible(args.id, exec.agent)
        return view(await host.engine.forget(args.id))
      },
    }),
  ]
}

/** Exposed for the command reply. */
export { line as memoryLine }
