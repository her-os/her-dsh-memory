/** Memory management page on this bundle's page in Plugins. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props assembled by the Plugins page slot renderer. */
export type MemoryTabProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'herMemory'>

/**
 * Render the memory page.
 * @param props - slot runtime props and the namespace translator.
 * @returns the page content.
 */
export function MemoryTab({ t }: MemoryTabProps) {
  return <div style={{ padding: 16 }}>{t('empty')}</div>
}
