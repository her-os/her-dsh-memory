/**
 * Browser half of the Her memory plugin: mounts the `herMemory` Remote, then
 * contributes the memory page to this bundle's page in Plugins.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createMemoryApi } from './client/api.ts'
import { MemoryTab } from './client/MemoryTab.tsx'
import { en, zh, type MemoryLocaleKey } from './client/locales.ts'
import { TYPERT_REMOTE } from './typert/remote-client.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Her memory page copy. */
    herMemory: MemoryLocaleKey
  }
}

/** Client face of the hand-written Remote (see src/typert/remote-info.ts). */
interface HerMemoryRemoteClient {
  call(op: string, payload: string): Promise<RemoteResult<string>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    herMemory: HerMemoryRemoteClient
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'herMemory'

/** Package name the Plugins page keys this bundle's page by. */
export const BUNDLE = '@her-os/dsh-memory'

/** Client services the registration uses. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the Remote, then register dictionaries and the memory page for the same lifetime.
 * @param ctx - the client plugin context.
 * @returns disposer removing the page before the Remote.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  const body = ctx.inject(['remote.herMemory'], register)
  try { await body } catch (error) { await body.dispose(); await unmount(); throw error }
  return async () => { await body.dispose(); await unmount() }
}

function register(ctx: ClientContext): void {
  const api = createMemoryApi((op, payload) => ctx.remote.herMemory.call(op, payload))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'her-memory: dictionaries')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE,
    locale: NS,
    inject: () => ({ api }),
  }, MemoryTab))
}
