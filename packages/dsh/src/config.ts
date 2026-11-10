/** Plugin Config and its resolution into concrete values. */

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_LOCAL_MODEL, type DownloadSource, LOCAL_MODELS, type LocalModel, modelBytes } from '@her-os/memory-local-embed'

/** Where new memories are written and which memories a session sees. */
export type ScopeMode = 'global' | 'preset' | 'workspace'

/** How often Her may bring something up unprompted. */
export type ProactiveSetting = 'off' | 'low' | 'normal'

/** Where vectors come from: a model on this machine, an OpenAI-compatible endpoint, or nowhere (keywords only). */
export type EmbeddingProvider = 'local' | 'remote' | 'off'

/** Semantic search settings. */
export interface EmbeddingConfig {
  provider: EmbeddingProvider
  /** Model id from the local catalog. */
  localModel: string
  /** Mirror preference for the local model and runtime downloads. */
  downloadSource: DownloadSource
  /** Unload the local model after this many idle minutes; 0 keeps it loaded. */
  unloadAfterMinutes: number
  /** Remote endpoint; an empty base URL disables the remote provider. */
  baseURL: string
  apiKey: string
  model: string
  /** Requested vector dimension; 0 keeps the model default. */
  dimensions: number
  /** Time limit of the per-turn query embedding. */
  timeoutMs: number
}

/** Values the plugin receives from cordis.yml or the settings page. */
export interface Config {
  /** Database file path; empty selects `$DSH_HOME/her-memory/memory.db`. */
  dbPath?: string | undefined
  /** Milliseconds a write waits for another DSH process holding the database lock. */
  busyTimeoutMs: number
  /** Stop recall, extraction, and proactive mention; tools and the management page keep working. */
  paused: boolean
  scope: ScopeMode
  proactive: ProactiveSetting
  /** Memories injected per turn at most. */
  recallCount: number
  /** Character budget of the per-turn recall block. */
  injectBudget: number
  /** Extraction calls per day at most. */
  dailyExtractLimit: number
  /** `provider:model` used for extraction; empty follows the session's model. */
  extractModel: string
  embedding: EmbeddingConfig
}

const STARS = ['', '★', '★★', '★★★'] as const

/**
 * One-line description of a local model for the settings page.
 * @param model - catalog entry.
 * @returns name, download size, quality, speed, memory, languages.
 */
export function modelLabel(model: LocalModel): string {
  const size = Math.round(modelBytes(model) / 1e6)
  const languages = model.languages === 'zh' ? '只适合中文' : '中英等多语言'
  const recommended = model.id === DEFAULT_LOCAL_MODEL ? '（推荐）' : ''
  return `${model.name}${recommended} · 下载约 ${size} MB · 效果 ${STARS[model.quality]} · 速度 ${STARS[model.speed]} · 内存约 ${model.memoryMB} MB · ${languages}`
}

/** Lowest and highest accepted embedding time limit. */
export const EMBEDDING_TIMEOUT_RANGE = [500, 10_000] as const

/** Schemastery declaration of {@link Config}. */
export const Config: z<Config> = z.object({
  dbPath: z.string().description('记忆库文件路径。留空时用 $DSH_HOME/her-memory/memory.db。'),
  busyTimeoutMs: z.natural().min(100).max(60000).default(5000)
    .description('另一个 DSH 进程正在写库时，本进程最多等待的毫秒数。'),
  paused: z.boolean().default(false)
    .description('暂停记忆：不再回忆、不再记新的、不主动提起。已有记忆保留，管理页照常可用。'),
  scope: z.union([
    z.const('global').description('所有会话共用一份记忆'),
    z.const('preset').description('按 Agent 预设分开，另加全局记忆'),
    z.const('workspace').description('按工作目录分开，另加全局记忆'),
  ]).default('global').description('记忆范围。'),
  proactive: z.union([
    z.const('off').description('从不主动提起'),
    z.const('low').description('只在到了跟进日或有未兑现的约定时提一次'),
    z.const('normal').description('另外偶尔聊起一个月前的共同经历'),
  ]).default('low').description('主动提起的频率。每个会话最多一次。'),
  recallCount: z.natural().min(1).max(20).default(5).description('每轮最多带入的记忆条数。'),
  injectBudget: z.natural().min(200).max(4000).default(800).description('每轮带入记忆的字数上限。'),
  dailyExtractLimit: z.natural().max(5000).default(200).description('每天最多做多少次记忆整理（每次整理调用一次模型）。'),
  extractModel: z.string().default('')
    .description('整理记忆用的模型，格式 provider:model。留空时用会话当前的模型。'),
  embedding: z.object({
    provider: z.union([
      z.const('local').description('本机模型：第一次使用时在后台下载，之后离线可用'),
      z.const('remote').description('云端服务：OpenAI 兼容的 embeddings 接口'),
      z.const('off').description('关闭：只用关键词检索'),
    ]).default('local').description('语义检索用什么生成向量。能找到意思相近、字面不同的记忆，例如「主子不吃饭」想起「养了只橘猫」。'),
    localModel: z.union(LOCAL_MODELS.map(model => z.const(model.id).description(modelLabel(model)))).default(DEFAULT_LOCAL_MODEL)
      .description('本机模型。越大效果越好，但下载更久、占内存更多。切换后会在后台重新计算全部向量。'),
    downloadSource: z.union([
      z.const('auto').description('自动：先试 Hugging Face，连不上再用国内镜像'),
      z.const('huggingface').description('只用 Hugging Face 和 npm 官方源'),
      z.const('modelscope').description('只用国内镜像（ModelScope 和 npmmirror）'),
    ]).default('auto').description('本机模型的下载源。'),
    unloadAfterMinutes: z.natural().max(1440).default(0)
      .description('本机模型闲置多少分钟后释放内存，0 表示一直保留。释放后下一次回忆要重新加载，那一轮可能只用关键词。'),
    baseURL: z.string().default('').description('云端服务：OpenAI 兼容的 embeddings 地址，例如 https://api.example.com/v1。'),
    apiKey: z.string().role('secret').default('').description('云端服务的 API Key。'),
    model: z.string().default('').description('云端服务的模型名。'),
    dimensions: z.natural().max(8192).default(0).description('云端服务的向量维度。0 表示用模型默认值。改动后会在后台重算全部向量。'),
    timeoutMs: z.natural().min(EMBEDDING_TIMEOUT_RANGE[0]).max(EMBEDDING_TIMEOUT_RANGE[1]).default(1500)
      .description('每轮回忆等待 embedding 的毫秒数，超时这一轮只用关键词检索。调大能提高召回，但服务慢时每条回复都会多等这么久，聊天会明显变慢。'),
  }).description('语义检索'),
})

/** Concrete settings derived from {@link Config}. */
export interface ResolvedConfig {
  dbPath: string
  busyTimeoutMs: number
  /** Cache of local models and the inference runtime, shared by every profile. */
  embeddingRoot: string
}

/**
 * Fill defaults that depend on the environment.
 * @param config - the validated plugin Config.
 * @param env - environment that supplies `DSH_HOME`.
 * @returns the database path and lock wait to use.
 */
export function resolveConfig(config: Pick<Config, 'dbPath' | 'busyTimeoutMs'>, env: Record<string, string | undefined> = process.env): ResolvedConfig {
  const configured = config.dbPath?.trim()
  const home = join(resolveDshHome(undefined, env), 'her-memory')
  return {
    dbPath: configured ? configured : join(home, 'memory.db'),
    busyTimeoutMs: config.busyTimeoutMs,
    embeddingRoot: join(home, 'embedding'),
  }
}

/**
 * Split `provider:model` at the first colon.
 * @param text - the setting.
 * @returns the route, or `undefined` when empty or malformed.
 */
export function parseModelRoute(text: string): { provider: string; model: string } | undefined {
  const trimmed = text.trim()
  const colon = trimmed.indexOf(':')
  if (colon <= 0 || colon === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, colon), model: trimmed.slice(colon + 1) }
}

/** Write scope and visible scopes of one session. */
export interface SessionScope {
  readonly scope: string
  readonly scopes: readonly string[]
}

/**
 * Scope of a session under a scope mode.
 * @param mode - setting.
 * @param header - the session's preset and working directory.
 * @returns where it writes and what it sees; global memories are always visible.
 */
export function scopeOf(mode: ScopeMode, header: { agentPreset?: string | undefined; cwd?: string | undefined }): SessionScope {
  if (mode === 'preset') {
    const scope = `preset:${header.agentPreset ?? 'default'}`
    return { scope, scopes: ['global', scope] }
  }
  if (mode === 'workspace' && header.cwd !== undefined && header.cwd !== '') {
    const scope = `workspace:${header.cwd}`
    return { scope, scopes: ['global', scope] }
  }
  return { scope: 'global', scopes: ['global'] }
}
