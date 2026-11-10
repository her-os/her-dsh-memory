/** Browser half of the Her memory plugin: contributes the memory page to this bundle's page in Plugins. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
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

/** Package name the Plugins page keys this bundle's page by. */
export const BUNDLE = '@her-os/dsh-memory'

/** Client services the registration uses. */
export const inject = ['slots', 'locale']

/**
 * Register dictionaries and the memory page on this bundle's Plugins page.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'her-memory: dictionaries')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE,
    locale: NS,
  }, MemoryTab))
}
