/**
 * Settings section of the memory page. DSH draws no schema form on a bundle
 * page that contributes its own content, so every user-facing setting is
 * edited here. Choices save at once; text and numbers save on Enter or blur.
 */

import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useId, useState } from 'react'
import type { SettingValue, Settings, SettingsValue } from './settings.ts'
import { S, type T } from './ui.tsx'

type Save = (path: readonly string[], value: SettingValue) => void

/**
 * The settings section, collapsed until opened.
 * @param props - settings, translator, the page's action state.
 * @returns the section.
 */
export function SettingsPanel({ settings, t, busy, save }: {
  settings: Settings
  t: T
  busy: boolean
  save: Save
}): ReactNode {
  const [open, setOpen] = useState(false)
  const { snapshot } = settings
  const value = snapshot.value
  const disabled = busy || !snapshot.writable
  return (
    <section style={S.card} data-testid="her-memory-settings">
      <div style={S.between}>
        <strong style={S.primary}>{t('settingsTitle')}</strong>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => { setOpen(current => !current) }}>{open ? t('settingsHide') : t('settingsShow')}</Button>
      </div>
      {!open
        ? null
        : snapshot.status === 'unavailable'
          ? <span style={S.caption}>{t('settingsUnavailable')}</span>
          : value === undefined
            ? <span style={S.caption}>{t('loading')}</span>
            : <SettingsFields value={value} t={t} disabled={disabled} save={save} readOnly={!snapshot.writable} />}
    </section>
  )
}

function SettingsFields({ value, t, disabled, save, readOnly }: {
  value: SettingsValue
  t: T
  disabled: boolean
  save: Save
  readOnly: boolean
}): ReactNode {
  const { embedding } = value
  return (
    <div style={S.page}>
      {readOnly ? <span style={S.caption}>{t('settingsReadOnly')}</span> : null}
      <h4 style={S.heading}>{t('settingsEmbedding')}</h4>
      <div style={S.group}>
      <SelectField
        label={t('setProvider')}
        hint={embedding.provider === 'local' ? `${t('setProviderHint')} ${t('setLocalModelHint')}` : t('setProviderHint')}
        value={embedding.provider}
        options={[['local', t('optLocal')], ['remote', t('optRemote')], ['off', t('optOff')]]}
        disabled={disabled}
        onSave={(next) => { save(['embedding', 'provider'], next) }}
      />
      {embedding.provider === 'local'
        ? (
            <>
              <span style={S.caption}>{t('setLocalModelHint')}</span>
              <SelectField
                label={t('setDownloadSource')}
                value={embedding.downloadSource}
                options={[['auto', t('optSourceAuto')], ['huggingface', t('optSourceHf')], ['modelscope', t('optSourceMs')]]}
                disabled={disabled}
                onSave={(next) => { save(['embedding', 'downloadSource'], next) }}
              />
              <NumberField label={t('setUnload')} hint={t('setUnloadHint')} value={embedding.unloadAfterMinutes} min={0} max={1440} disabled={disabled} t={t} onSave={(next) => { save(['embedding', 'unloadAfterMinutes'], next) }} />
            </>
          )
        : null}
      {embedding.provider === 'remote'
        ? (
            <>
              <TextField label={t('setBaseURL')} hint={t('setBaseURLHint')} value={embedding.baseURL} disabled={disabled} onSave={(next) => { save(['embedding', 'baseURL'], next) }} />
              <SecretField label={t('setApiKey')} hint={t('setApiKeyHint')} disabled={disabled} t={t} onSave={(next) => { save(['embedding', 'apiKey'], next) }} />
              <TextField label={t('setRemoteModel')} value={embedding.model} disabled={disabled} onSave={(next) => { save(['embedding', 'model'], next) }} />
              <NumberField label={t('setDimensions')} hint={t('setDimensionsHint')} value={embedding.dimensions} min={0} max={8192} disabled={disabled} t={t} onSave={(next) => { save(['embedding', 'dimensions'], next) }} />
            </>
          )
        : null}
      {embedding.provider === 'off'
        ? null
        : <NumberField label={t('setTimeout')} hint={t('setTimeoutHint')} value={embedding.timeoutMs} min={500} max={10_000} disabled={disabled} t={t} onSave={(next) => { save(['embedding', 'timeoutMs'], next) }} />}
      </div>
      <h4 style={S.heading}>{t('settingsMemory')}</h4>
      <div style={S.group}>
      <SelectField
        label={t('setScope')}
        value={value.scope}
        options={[['global', t('optScopeGlobal')], ['preset', t('optScopePreset')], ['workspace', t('optScopeWorkspace')]]}
        disabled={disabled}
        onSave={(next) => { save(['scope'], next) }}
      />
      <SelectField
        label={t('setProactive')}
        hint={t('setProactiveHint')}
        value={value.proactive}
        options={[['off', t('optProactiveOff')], ['low', t('optProactiveLow')], ['normal', t('optProactiveNormal')]]}
        disabled={disabled}
        onSave={(next) => { save(['proactive'], next) }}
      />
      <NumberField label={t('setRecallCount')} value={value.recallCount} min={1} max={20} disabled={disabled} t={t} onSave={(next) => { save(['recallCount'], next) }} />
      <NumberField label={t('setInjectBudget')} value={value.injectBudget} min={200} max={4000} disabled={disabled} t={t} onSave={(next) => { save(['injectBudget'], next) }} />
      <NumberField label={t('setBatchTurns')} hint={t('setBatchTurnsHint')} value={value.extractBatchTurns} min={1} max={20} disabled={disabled} t={t} onSave={(next) => { save(['extractBatchTurns'], next) }} />
      <NumberField label={t('setIdleMinutes')} hint={t('setIdleMinutesHint')} value={value.extractIdleMinutes} min={1} max={120} disabled={disabled} t={t} onSave={(next) => { save(['extractIdleMinutes'], next) }} />
      <SelectField
        label={t('setBeforeRecall')}
        hint={t('setBeforeRecallHint')}
        value={value.extractBeforeRecall ? 'on' : 'off'}
        options={[['on', t('optOn')], ['off', t('optOff')]]}
        disabled={disabled}
        onSave={(next) => { save(['extractBeforeRecall'], next === 'on') }}
      />
      <NumberField label={t('setDailyLimit')} hint={t('setDailyLimitHint')} value={value.dailyExtractLimit} min={0} max={5000} disabled={disabled} t={t} onSave={(next) => { save(['dailyExtractLimit'], next) }} />
      <TextField label={t('setExtractModel')} hint={t('setExtractModelHint')} value={value.extractModel} disabled={disabled} onSave={(next) => { save(['extractModel'], next) }} />
      </div>
    </div>
  )
}

function Field({ id, label, hint, children, error }: { id: string; label: string; hint?: string | undefined; children: ReactNode; error?: string | undefined }): ReactNode {
  return (
    <div style={S.groupRow}>
      <span style={S.rowText}>
        <label htmlFor={id} style={S.primary}>{label}</label>
        {hint === undefined ? null : <span style={S.caption}>{hint}</span>}
      </span>
      <span style={S.control}>
        {children}
        {error === undefined ? null : <span style={S.error}>{error}</span>}
      </span>
    </div>
  )
}

function SelectField<V extends string>({ label, hint, value, options, disabled, onSave }: {
  label: string
  hint?: string
  value: V
  options: readonly (readonly [V, string])[]
  disabled: boolean
  onSave: (next: V) => void
}): ReactNode {
  const id = useId()
  return (
    <Field id={id} label={label} hint={hint}>
      <select id={id} style={{ ...S.select, width: '100%' }} value={value} disabled={disabled} onChange={(event) => { onSave(event.target.value as V) }}>
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </Field>
  )
}

/** Text draft that follows the saved value until edited, and saves on Enter or blur. */
function useDraft(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return [draft, setDraft]
}

const commitKeys = (commit: () => void) => ({
  onBlur: commit,
  onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') commit() },
})

function TextField({ label, hint, value, disabled, onSave }: { label: string; hint?: string; value: string; disabled: boolean; onSave: (next: string) => void }): ReactNode {
  const id = useId()
  const [draft, setDraft] = useDraft(value)
  const commit = (): void => { if (draft.trim() !== value) onSave(draft.trim()) }
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} value={draft} disabled={disabled} onChange={(event) => { setDraft(event.target.value) }} {...commitKeys(commit)} />
    </Field>
  )
}

function NumberField({ label, hint, value, min, max, disabled, t, onSave }: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  disabled: boolean
  t: T
  onSave: (next: number) => void
}): ReactNode {
  const id = useId()
  const [draft, setDraft] = useDraft(String(value))
  const parsed = /^\d+$/u.test(draft.trim()) ? Number(draft.trim()) : Number.NaN
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max
  const commit = (): void => { if (valid && parsed !== value) onSave(parsed) }
  return (
    <Field id={id} label={label} hint={hint} error={valid ? undefined : t('setRange', { min, max })}>
      <Input id={id} inputMode="numeric" value={draft} disabled={disabled} aria-invalid={!valid || undefined} onChange={(event) => { setDraft(event.target.value) }} {...commitKeys(commit)} />
    </Field>
  )
}

/** Write-only field: the saved secret never reaches the browser. */
function SecretField({ label, hint, disabled, t, onSave }: { label: string; hint?: string; disabled: boolean; t: T; onSave: (next: string) => void }): ReactNode {
  const id = useId()
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    if (draft.trim() === '') return
    onSave(draft.trim())
    setDraft('')
  }
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} type="password" autoComplete="off" placeholder={t('setApiKeyPlaceholder')} value={draft} disabled={disabled} onChange={(event) => { setDraft(event.target.value) }} {...commitKeys(commit)} />
    </Field>
  )
}
