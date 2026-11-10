/** Browser half of the Her memory plugin: contributes the Memory tab to Plugins settings. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { MemoryTab } from './MemoryTab.tsx'
import { en, zh, type MemoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Her memory page copy. */
    herMemory: MemoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'herMemory'

/** Client services the registration uses. */
export const inject = ['slots', 'locale']

/**
 * Register dictionaries and the Memory tab.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'her-memory: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'her-memory',
    order: 50,
    label: () => t('tab'),
    locale: NS,
  }, MemoryTab))
}
