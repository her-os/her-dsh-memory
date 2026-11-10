/**
 * Host half of the Her memory plugin. Owns the memory database for the
 * process and connects the engine to DSH: recall before each turn's first
 * step, extraction after each turn, a resident system-prompt section, model
 * tools, slash commands, and the `herMemory` Remote for the management page.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { type ContextFormed, createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DEFAULT_PROMPTS, type Embedder, MemoryEngine, openAICompatibleEmbedder, openMemoryDatabase, systemClock } from '@her-os/memory-core'
import { memoryCommands } from './commands.ts'
import { Config, parseModelRoute, resolveConfig, scopeOf, type SessionScope } from './config.ts'
import { createLlmPort, type ModelRoute } from './llm.ts'
import { MemoryOps } from './ops.ts'
import { HerMemoryRemote } from './remote.ts'
import { type Block, MemoryRuntime } from './runtime.ts'
import { memoryTools } from './tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'her-memory': { kind: 'her-memory' } & ContextFormed
  }
}

export { Config }
export { HerMemoryRemote }

/** Plugin name shown in logs. */
export const name = 'her-memory'

/** Background pass interval: queued extraction and idle consolidation. */
export const MAINTENANCE_INTERVAL_MS = 60_000

/** Name and order of the resident system-prompt section. */
export const PROMPT_SECTION = { name: 'her-memory', order: 9500 } as const

const PAUSED_META = 'paused'

type HostContext = Context & {
  llm?: LlmRuntime
  tools?: ToolRuntime
  commands?: CommandRuntime
  agentDefaultModel?: AgentDefaultModelConfig
}

const agentRoute = (agent: Agent): ModelRoute | undefined => {
  const { provider, model } = agent.options
  return provider !== undefined && model !== undefined ? { provider, model } : undefined
}

/**
 * Build the embedder the settings describe.
 * @param config - plugin Config.
 * @returns the embedder, or `null` when no endpoint is configured.
 */
export function embedderOf(config: Config): Embedder | null {
  const { baseURL, apiKey, model, dimensions } = config.embedding
  if (baseURL.trim() === '' || model.trim() === '') return null
  return openAICompatibleEmbedder({
    baseURL: baseURL.trim(), model: model.trim(),
    ...(apiKey === '' ? {} : { apiKey }),
    ...(dimensions > 0 ? { dimensions } : {}),
  })
}

/**
 * Start the memory engine for the lifetime of this plugin instance.
 * @param ctx - the plugin context.
 * @param config - the validated plugin Config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const db = openMemoryDatabase({ path: resolved.dbPath, busyTimeoutMs: resolved.busyTimeoutMs })
  let pausedAtRuntime = false
  const paused = (): boolean => config.paused || pausedAtRuntime
  let runtime: MemoryRuntime | undefined
  // Optional host services: held while their providers are up, so the plugin loads without them.
  let llmRuntime: LlmRuntime | undefined
  let defaultModel: AgentDefaultModelConfig | undefined
  const engine = new MemoryEngine({
    db,
    clock: systemClock(),
    prompts: DEFAULT_PROMPTS,
    logger: ctx.logger,
    llm: createLlmPort(() => llmRuntime, sessionId => parseModelRoute(config.extractModel) ?? runtime?.routeOf(sessionId) ?? defaultModel?.currentSelection()),
    settings: () => ({
      paused: paused(),
      recallCount: config.recallCount,
      injectBudget: config.injectBudget,
      embeddingTimeoutMs: config.embedding.timeoutMs,
      proactive: config.proactive,
      dailyExtractLimit: config.dailyExtractLimit,
    }),
    busy: () => runtime?.busy() ?? false,
  })
  pausedAtRuntime = engine.repo.meta(PAUSED_META) === '1'
  const setPaused = (next: boolean): void => {
    pausedAtRuntime = next
    engine.repo.setMeta(PAUSED_META, next ? '1' : '0')
  }
  runtime = new MemoryRuntime(engine, paused)
  const live = runtime
  ctx.effect(() => () => {
    engine.dispose()
    db.close()
  }, 'her-memory: database')
  ctx.logger.info('memory database ready at %s', resolved.dbPath)

  engine.setEmbedder(embedderOf(config))

  const scopes = new Map<string, SessionScope>()
  const scopeOfAgent = (agent: Agent | undefined): SessionScope => {
    if (agent === undefined) return { scope: 'global', scopes: ['global'] }
    return scopes.get(agent.session.id) ?? scopeOf(config.scope, agent.session.header)
  }
  const sections = new Map<string, () => void>()

  ctx.on('agent/created', ({ agent }) => {
    const header = agent.session.header
    if (header.origin === 'subagent') return undefined
    const scope = scopeOf(config.scope, header)
    scopes.set(agent.session.id, scope)
    live.open(agent.session.id, scope, agentRoute(agent))
    const prompt = (agent.ctx as Context & { systemPrompt?: SystemPrompt }).systemPrompt
    if (prompt !== undefined && !sections.has(agent.session.id)) {
      sections.set(agent.session.id, prompt.section({
        ...PROMPT_SECTION,
        interpolate: false,
        text: () => paused() ? '' : engine.residentSection(scope.scopes),
      }))
    }
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent.session.id
    sections.get(id)?.()
    sections.delete(id)
    scopes.delete(id)
    live.close(id)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    live.status(agent.session.id, status === 'running')
  })

  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const state = live.get(agent.session.id)
    if (state === undefined) return decision
    const route = agentRoute(agent)
    if (route !== undefined) state.route = route
    const blocks: Block[] = decision.messages.filter(message => message.source.kind === 'user').flatMap(message => message.content as Block[])
    try {
      const injection = await live.recall(agent.session.id, turn, blocks, signal)
      if (injection === undefined) return decision
      ctx.logger.debug('recall injected %d chars in %d ms', injection.text.length, Math.round(injection.elapsedMs))
      const recall = createUserMessage({ content: [{ type: 'text', text: injection.text }], source: { kind: 'her-memory', form: 'recall' } })
      return { ...decision, messages: [recall, ...decision.messages] }
    } catch (error) {
      if (!signal.aborted) ctx.logger.warn('recall failed: %s', error instanceof Error ? error.message : String(error))
      return decision
    }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    const id = session.id
    switch (event.type) {
      case 'turn/start': live.turnStart(id, event.data.turn); break
      case 'user/message': live.userMessage(id, event.data.source.kind, event.data.content as Block[]); break
      case 'assistant/message': live.assistantMessage(id, event.data.message.content as Block[]); break
      case 'turn/end': live.turnEnd(id, event.data.turn, new Date(event.time)); break
      default: break
    }
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (live.busy()) return
      void engine.pump().catch((error: unknown) => { ctx.logger.warn('extraction pass failed: %s', String(error)) })
      if (engine.consolidationDue()) {
        void engine.consolidate().then(
          result => { ctx.logger.info('memory consolidation: %d faded, %d archived, %d purged', result.faded, result.archived, result.purged) },
          (error: unknown) => { ctx.logger.warn('memory consolidation failed: %s', String(error)) },
        )
      }
    }, MAINTENANCE_INTERVAL_MS)
    timer.unref()
    return () => { clearInterval(timer) }
  }, 'her-memory: maintenance')

  ctx.inject(['llm'], (inner) => {
    llmRuntime = (inner as HostContext).llm
    inner.effect(() => () => { llmRuntime = undefined }, 'her-memory: llm runtime')
  })

  ctx.inject(['agentDefaultModel'], (inner) => {
    defaultModel = (inner as HostContext).agentDefaultModel
    inner.effect(() => () => { defaultModel = undefined }, 'her-memory: default model')
  })

  ctx.inject(['tools'], (inner) => {
    for (const tool of memoryTools({ engine, scopeOf: scopeOfAgent, paused })) inner.effect(() => (inner as HostContext).tools!.register(tool), `her-memory: tool ${tool.name}`)
  })

  ctx.inject(['commands'], (inner) => {
    for (const command of memoryCommands({ engine, scopeOf: scopeOfAgent, paused, setPaused })) inner.effect(() => (inner as HostContext).commands!.register(command), `her-memory: /${command.name}`)
  })

  const ops = new MemoryOps({ engine, embedderFromSettings: () => embedderOf(config), paused, setPaused })
  ctx.inject(['typert'], (inner) => {
    inner.plugin(HerMemoryRemote, { ops })
  })
}

