/** Small shared pieces of the memory page: styles, async state, confirmation. */

import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryLocaleKey } from './locales.ts'

/** Translator of this namespace. */
export type T = Translate<MemoryLocaleKey>

/** Inline styles built on DSH design tokens. */
export const S = {
  page: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-1)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
  },
  primary: { color: 'var(--dsw-alias-label-primary)' },
  secondary: { color: 'var(--dsw-alias-label-secondary)' },
  caption: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xxs-12)' },
  error: { color: 'var(--dsw-alias-state-error-primary)' },
  success: { color: 'var(--dsw-alias-state-success-primary)' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  textarea: {
    width: '100%', minHeight: 72, resize: 'vertical', boxSizing: 'border-box', font: 'inherit', padding: 8,
    color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
  },
  select: {
    font: 'inherit', padding: '4px 8px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm)',
  },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
} satisfies Record<string, CSSProperties>

/** Async load state of one view. */
export interface Loaded<V> {
  readonly value: V | undefined
  readonly error: string | undefined
  readonly loading: boolean
  reload(): void
}

/**
 * Load a value and reload on demand; the latest request wins.
 * @param load - the loader.
 * @param deps - inputs that trigger a reload.
 * @returns the load state.
 */
export function useLoad<V>(load: () => Promise<V>, deps: readonly unknown[]): Loaded<V> {
  const [state, setState] = useState<{ value: V | undefined; error: string | undefined; loading: boolean }>({ value: undefined, error: undefined, loading: true })
  const [tick, setTick] = useState(0)
  const latest = useRef(0)
  useEffect(() => {
    const request = ++latest.current
    setState(current => ({ ...current, loading: true }))
    load().then(
      (value) => { if (request === latest.current) setState({ value, error: undefined, loading: false }) },
      (error: unknown) => { if (request === latest.current) setState(current => ({ ...current, error: messageOf(error), loading: false })) },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => { setTick(n => n + 1) }, [])
  return { ...state, reload }
}

/**
 * Message of a thrown value.
 * @param error - anything thrown.
 * @returns its message.
 */
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Run page actions and keep the last failure for display.
 * @returns `run` and the failure text.
 */
export function useAction(): { run: (action: () => Promise<unknown>) => Promise<boolean>; failure: string | undefined; busy: boolean } {
  const [failure, setFailure] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await action()
      return true
    } catch (error) {
      setFailure(messageOf(error))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { run, failure, busy }
}

/**
 * Load failure with a retry button.
 * @param props - message, retry and translator.
 * @returns the notice.
 */
export function LoadError({ error, retry, t }: { error: string; retry: () => void; t: T }): ReactNode {
  return (
    <div style={S.row}>
      <span style={S.error}>{t('loadFailed', { error })}</span>
      <Button size="sm" variant="outline" onClick={retry}>{t('retry')}</Button>
    </div>
  )
}

/** A pending confirmation. */
export interface ConfirmRequest {
  readonly message: string
  readonly action: () => Promise<unknown>
  readonly danger?: boolean
}

/**
 * Confirmation dialog for destructive actions.
 * @param props - the request, close callback and translator.
 * @returns the dialog.
 */
export function ConfirmDialog({ request, onClose, run, t }: { request: ConfirmRequest | undefined; onClose: () => void; run: (action: () => Promise<unknown>) => Promise<boolean>; t: T }): ReactNode {
  return (
    <Modal
      open={request !== undefined}
      onClose={onClose}
      title={t('confirm')}
      closeLabel={t('close')}
      footer={(
        <div style={S.row}>
          <Button size="sm" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const action = request?.action
              onClose()
              if (action !== undefined) void run(action)
            }}
          >
            {t('confirm')}
          </Button>
        </div>
      )}
    >
      <p style={S.primary}>{request?.message}</p>
    </Modal>
  )
}

/**
 * Format an ISO instant for display in the user's locale.
 * @param iso - ISO instant.
 * @returns short local date and time.
 */
export const when = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Switch with its label shown beside it; the primitive only names itself for assistive technology.
 * @param props - state, change callback, label and disabled flag.
 * @returns the labelled switch.
 */
export function LabeledSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }): ReactNode {
  return (
    <span style={{ ...S.row, gap: 6 }}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <span aria-hidden="true" style={S.secondary}>{label}</span>
    </span>
  )
}
