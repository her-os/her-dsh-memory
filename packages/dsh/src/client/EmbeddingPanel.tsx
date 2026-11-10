/**
 * Semantic-search part of the overview: where vectors come from, the local
 * model's download and load state, index progress, and the local model catalog.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useState } from 'react'
import type { EmbeddingStatus, LocalModelItem, LocalModelStatus, MemoryApi } from './api.ts'
import { S, type T, useLoad } from './ui.tsx'

/** Refresh while something is moving. */
const POLL_MS = 2000

const mb = (bytes: number): number => Math.round(bytes / 1e6)
const stars = (n: number): string => '★'.repeat(n) + '☆'.repeat(3 - n)

/**
 * Whether the overview should refresh itself.
 * @param embedding - current status.
 * @returns `true` while downloading, loading, or backfilling.
 */
export const embeddingBusy = (embedding: EmbeddingStatus): boolean =>
  embedding.running || (embedding.local !== null && ['downloading', 'waiting', 'loading'].includes(embedding.local.state))

/**
 * Re-run `reload` every few seconds while `active`.
 * @param active - whether to poll.
 * @param reload - the refresh.
 */
export function usePoll(active: boolean, reload: () => void): void {
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(reload, POLL_MS)
    return () => { clearInterval(timer) }
  }, [active, reload])
}

function localLine(local: LocalModelStatus, t: T): string {
  switch (local.state) {
    case 'downloading': return t('localDownloading', { received: mb(local.received), total: mb(local.total) })
    case 'waiting': return t('localWaiting')
    case 'loading': return t('localLoading')
    case 'ready': return t('localReady')
    case 'error': return t('localError', { error: local.error ?? '' })
    case 'unsupported': return t('localUnsupported')
    case 'idle': return local.downloaded ? t('localIdle') : t('localMissing')
  }
}

/**
 * The semantic-search block.
 * @param props - api, translator, status, action runner and refresh.
 * @returns the block.
 */
export function EmbeddingPanel({ api, t, embedding, run, busy, onChanged }: {
  api: MemoryApi
  t: T
  embedding: EmbeddingStatus
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  onChanged: () => void
}): ReactNode {
  const [test, setTest] = useState<string | undefined>()
  const [catalogOpen, setCatalogOpen] = useState(false)
  const { local } = embedding
  const progress = local !== null && local.state === 'downloading' && local.total > 0 ? local.received / local.total : undefined
  return (
    <div style={S.field} data-testid="her-memory-embedding">
      <div style={S.between}>
        <span style={S.secondary}>
          <strong style={S.primary}>{t('embeddingTitle')}</strong>
          {' · '}
          {embedding.provider === 'off' ? t('embeddingDisabled') : embedding.provider === 'local' ? t('providerLocal', { model: local?.model ?? '' }) : t('providerRemote')}
        </span>
        <span style={S.row}>
          {embedding.provider === 'local'
            ? <Button size="sm" variant="outline" onClick={() => { setCatalogOpen(open => !open) }}>{catalogOpen ? t('hideModels') : t('showModels')}</Button>
            : null}
          {local !== null && local.state === 'error'
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(() => api.prepareLocalModel()).then((ok) => { if (ok) onChanged() }) }}>{t('localRetry')}</Button>
            : null}
          {embedding.configured
            ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setTest(undefined)
                      void run(async () => {
                        const result = await api.testEmbedding()
                        setTest(t('testResult', { dimension: result.dimension, ms: result.ms }))
                      })
                    }}
                  >
                    {t('testEmbedding')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || embedding.running || embedding.done >= embedding.total}
                    onClick={() => { void run(() => api.backfill()).then((ok) => { if (ok) onChanged() }) }}
                  >
                    {t('backfill')}
                  </Button>
                </>
              )
            : null}
        </span>
      </div>
      {local === null ? null : <span style={local.state === 'error' ? S.error : S.secondary} data-testid="her-memory-local-state">{localLine(local, t)}</span>}
      {progress === undefined
        ? null
        : (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t('localProgress')} style={{ height: 4, borderRadius: 2, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: 'var(--dsw-alias-state-success-primary)' }} />
            </div>
          )}
      {embedding.configured
        ? (
            <span style={S.caption}>
              {t('embeddingProgress', { done: embedding.done, total: embedding.total })}
              {embedding.running ? ` · ${t('embeddingRunning')}` : ''}
              {embedding.lastError === null ? '' : ` · ${t('embeddingError', { error: embedding.lastError })}`}
            </span>
          )
        : <span style={S.caption}>{embedding.provider === 'remote' ? t('embeddingOff') : t('embeddingDisabledHint')}</span>}
      {test === undefined ? null : <span style={S.success}>{test}</span>}
      {catalogOpen ? <ModelCatalog api={api} t={t} run={run} busy={busy} version={local?.downloaded ?? false} /> : null}
    </div>
  )
}

function ModelCatalog({ api, t, run, busy, version }: {
  api: MemoryApi
  t: T
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  version: unknown
}): ReactNode {
  const [tick, setTick] = useState(0)
  const catalog = useLoad(() => api.localModels(), [api, version, tick])
  if (catalog.value === undefined) return <span style={S.caption}>{catalog.error ?? t('loading')}</span>
  return (
    <div style={S.field} data-testid="her-memory-models">
      <span style={S.caption}>{catalog.value.supported ? t('modelsHint') : t('localUnsupported')}</span>
      <ul style={S.list}>
        {catalog.value.models.map((model: LocalModelItem) => (
          <li key={model.id} style={S.between}>
            <span style={S.field}>
              <span style={S.primary}>
                {model.name}
                {model.selected ? ` · ${t('modelSelected')}` : ''}
              </span>
              <span style={S.caption}>
                {t('modelFacts', {
                  download: model.downloadMB,
                  quality: stars(model.quality),
                  speed: stars(model.speed),
                  memory: model.memoryMB,
                  languages: model.languages === 'zh' ? t('languagesZh') : t('languagesMulti'),
                })}
              </span>
            </span>
            {model.downloaded && !model.selected
              ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(() => api.deleteLocalModel(model.id)).then(() => { setTick(n => n + 1) }) }}>{t('modelDelete')}</Button>
              : <span style={S.caption}>{model.downloaded ? t('modelDownloaded') : t('modelNotDownloaded')}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
