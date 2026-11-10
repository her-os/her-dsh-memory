/** Memory management page inside the Plugins settings section. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props assembled by the Settings slot renderer. */
export type MemoryTabProps = PropsRuntime<'settings.plugins.tab'> & PropsLocale<'herMemory'>

/**
 * Render the memory page.
 * @param props - slot runtime props and the namespace translator.
 * @returns the page content.
 */
export function MemoryTab({ t }: MemoryTabProps) {
  return <div style={{ padding: 16 }}>{t('empty')}</div>
}
