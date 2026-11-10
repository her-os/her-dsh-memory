/** Slash commands: `/memory` and `/remember`. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { MemoryEngine } from '@her-os/memory-core'
import type { SessionScope } from './config.ts'

/** What the commands need from the plugin. */
export interface CommandHost {
  readonly engine: MemoryEngine
  scopeOf(agent: Agent): SessionScope
  paused(): boolean
  setPaused(paused: boolean): void
}

const DEFINITION_ID = '@her-os/dsh-memory' as CommandDefinitionId

/**
 * Build the commands.
 * @param host - engine and switches.
 * @returns the command definitions.
 */
export function memoryCommands(host: CommandHost): CommandDefinition[] {
  return [
    {
      definitionId: DEFINITION_ID,
      name: 'memory',
      description: '查看记忆状态；/memory off 暂停记忆，/memory on 恢复',
      input: { hint: '[on|off]' },
      recordInput: false,
      handler(invocation) {
        const arg = invocation.rawInput.trim().toLowerCase()
        if (arg === 'off' || arg === 'on') {
          host.setPaused(arg === 'off')
          return { kind: 'success', text: arg === 'off' ? '记忆已暂停。已有的记忆还在，恢复用 /memory on。' : '记忆已恢复。' }
        }
        if (arg !== '') return { kind: 'error', text: '用法：/memory、/memory on 或 /memory off' }
        const counts = host.engine.repo.countByStatus()
        const embedding = host.engine.embeddingStatus()
        const scope = host.scopeOf(invocation.agent)
        const lines = [
          `记忆${host.paused() ? '已暂停' : '开启中'}，范围：${scope.scope}`,
          `在用 ${counts.active} 条，淡化 ${counts.faded} 条，归档 ${counts.archived} 条，回收站 ${counts.deleted} 条`,
          `待整理的对话：${host.engine.repo.queueLength()} 轮`,
          embedding.configured ? `语义检索：已向量化 ${embedding.done}/${embedding.total}${embedding.lastError === null ? '' : `，最近错误：${embedding.lastError}`}` : '语义检索：未配置，只用关键词',
          '在「插件 → Her 记忆」页面可以查看和管理全部记忆。',
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    },
    {
      definitionId: DEFINITION_ID,
      name: 'remember',
      description: '让 Her 记住一件事，例如 /remember 我对花生过敏',
      input: { hint: '要记住的事' },
      recordInput: true,
      async handler(invocation) {
        const text = invocation.rawInput.trim()
        if (text === '') return { kind: 'error', text: '用法：/remember 要记住的事' }
        const memory = await host.engine.save({ content: text, scope: host.scopeOf(invocation.agent).scope, sessionId: invocation.agent.session.id })
        return { kind: 'success', text: `记住了（#${memory.id}）。` }
      },
    },
  ]
}
