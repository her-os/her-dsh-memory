/**
 * The plugin's settings as the memory page reads and writes them, through the
 * DSH config form of the `her-memory` entry. Writing a field reloads the Host
 * plugin with the new value.
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** Patch row id of this plugin, which is also its settings namespace. */
export const ENTRY_ID = 'her-memory'

/**
 * Settings fields the page edits. Mirrors the Host `Config`, which the browser
 * bundle cannot import; the secret `apiKey` never arrives here.
 */
export interface SettingsValue {
  paused: boolean
  scope: 'global' | 'preset' | 'workspace'
  proactive: 'off' | 'low' | 'normal'
  recallCount: number
  injectBudget: number
  dailyExtractLimit: number
  extractBatchTurns: number
  extractIdleMinutes: number
  extractBeforeRecall: boolean
  extractModel: string
  embedding: {
    provider: 'local' | 'remote' | 'off'
    localModel: string
    downloadSource: 'auto' | 'huggingface' | 'modelscope'
    unloadAfterMinutes: number
    baseURL: string
    model: string
    dimensions: number
    timeoutMs: number
  }
}

/** A value a settings write accepts. */
export type SettingValue = Extract<SettingsPathOpView, { op: 'set' }>['value']

/** Settings handle the page receives. */
export type SettingsForm = ConfigForm<SettingsValue>

/** Current settings and a writer of one field. */
export interface Settings {
  readonly snapshot: ConfigFormSnapshot<SettingsValue>
  /**
   * Write one field.
   * @param path - field path, e.g. `['embedding', 'localModel']`.
   * @param value - new value.
   * @returns whether the Host accepted it; `false` when the revision moved or the write was refused.
   */
  set(path: readonly string[], value: SettingValue): Promise<boolean>
}

/**
 * Subscribe to the settings form.
 * @param form - the config form of {@link ENTRY_ID}.
 * @returns the snapshot and a writer.
 */
export function useSettings(form: SettingsForm): Settings {
  const [subscribe, read] = useMemo(() => [form.subscribe.bind(form), form.getSnapshot.bind(form)] as const, [form])
  const snapshot = useSyncExternalStore(subscribe, read)
  const set = useCallback(
    // No pinned revision: DSH queues writes in order behind the latest known one, so a second edit made
    // before the first one's reload lands is not refused as stale.
    (path: readonly string[], value: SettingValue): Promise<boolean> => form.mutate([{ op: 'set', path: [...path], value }]),
    [form],
  )
  return { snapshot, set }
}
