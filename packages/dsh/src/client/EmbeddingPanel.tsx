/**
 * Semantic-search part of the overview: where vectors come from, the local
 * model's download and load state, index progress, and the local model catalog.
 */

import { Button, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useState } from 'react'
import type { EmbeddingStatus, LocalModelItem, LocalModelStatus, MemoryApi } from './api.ts'
import { type Loaded, S, type T, useLoad } from './ui.tsx'

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

/** Short status of semantic search, shown as a tag next to the title. */
function statusTag(embedding: EmbeddingStatus, t: T): [TagTone, string] {
  if (embedding.provider === 'off') return ['neutral', t('embeddingDisabled')]
  const { local } = embedding
  if (local === null) return embedding.configured ? ['success', t('tagReady')] : ['warning', t('tagNotConfigured')]
  switch (local.state) {
    case 'downloading': return ['info', t('tagDownloading')]
    case 'waiting': return ['info', t('tagWaiting')]
    case 'loading': return ['info', t('tagLoading')]
    case 'ready': return ['success', t('tagReady')]
    case 'error': return ['danger', t('tagError')]
    case 'unsupported': return ['warning', t('tagUnsupported')]
    case 'idle': return local.downloaded ? ['success', t('tagDownloaded')] : ['warning', t('tagMissing')]
  }
}

/**
 * The semantic-search card.
 * @param props - api, translator, status, action runner, refresh and model selection.
 * @returns the card.
 */
export function EmbeddingPanel({ api, t, embedding, run, busy, onChanged, selectModel }: {
  api: MemoryApi
  t: T
  embedding: EmbeddingStatus
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  onChanged: () => void
  /** Select a local model in the settings; the Host then downloads and loads it. */
  selectModel: (id: string) => void
}): ReactNode {
  const [test, setTest] = useState<string | undefined>()
  const [catalogOpen, setCatalogOpen] = useState(false)
  const { local } = embedding
  const version = `${local?.model ?? ''}:${String(local?.downloaded ?? false)}`
  const catalog = useLoad(async () => embedding.provider === 'local' ? await api.localModels() : undefined, [api, embedding.provider, version])
  const modelName = catalog.value?.models.find(model => model.id === local?.model)?.name ?? local?.model ?? ''
  const progress = local !== null && local.state === 'downloading' && local.total > 0 ? local.received / local.total : undefined
  const [tone, label] = statusTag(embedding, t)
  return (
    <section style={S.card} data-testid="her-memory-embedding">
      <div style={S.between}>
        <span style={S.rowText}>
          <span style={S.row}>
            <strong style={S.primary}>{t('embeddingTitle')}</strong>
            <Tag tone={tone}>{label}</Tag>
          </span>
          <span style={S.secondary}>
            {embedding.provider === 'off' ? t('embeddingDisabledHint') : embedding.provider === 'local' ? t('providerLocal', { model: modelName }) : t('providerRemote')}
          </span>
        </span>
        <span style={S.row}>
          {local !== null && local.state === 'error'
            ? <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run(() => api.prepareLocalModel()).then((ok) => { if (ok) onChanged() }) }}>{t('localRetry')}</Button>
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
      {local === null ? null : <span style={local.state === 'error' ? S.error : S.caption} data-testid="her-memory-local-state">{localLine(local, t)}</span>}
      {progress === undefined
        ? null
        : (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t('localProgress')} style={{ height: 6, borderRadius: 3, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' }}>
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
        : embedding.provider === 'remote' ? <span style={S.caption}>{t('embeddingOff')}</span> : null}
      {test === undefined ? null : <span style={S.success}>{test}</span>}
      {embedding.provider === 'local'
        ? (
            <div>
              <Button size="sm" variant="ghost" aria-expanded={catalogOpen} onClick={() => { setCatalogOpen(open => !open) }}>
                {`${catalogOpen ? '▾' : '▸'} ${t('showModels')}`}
              </Button>
            </div>
          )
        : null}
      {catalogOpen && embedding.provider === 'local' ? <ModelCatalog api={api} t={t} run={run} busy={busy} catalog={catalog} selectModel={selectModel} /> : null}
    </section>
  )
}

function ModelCatalog({ api, t, run, busy, catalog, selectModel }: {
  api: MemoryApi
  t: T
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  catalog: Loaded<Awaited<ReturnType<MemoryApi['localModels']>> | undefined>
  selectModel: (id: string) => void
}): ReactNode {
  if (catalog.value === undefined) return <span style={S.caption}>{catalog.error ?? t('loading')}</span>
  const { supported, models } = catalog.value
  return (
    <div style={S.field} data-testid="her-memory-models">
      <span style={S.caption}>{supported ? t('modelsHint') : t('localUnsupported')}</span>
      <ul style={S.group}>
        {models.map((model: LocalModelItem) => (
          <li key={model.id} style={S.groupRow}>
            <span style={S.rowText}>
              <span style={S.row}>
                <span style={S.primary}>{model.name}</span>
                {model.selected ? <Tag tone="solid">{t('modelSelected')}</Tag> : null}
                {model.downloaded ? <Tag tone="outline">{t('modelDownloaded')}</Tag> : null}
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
            {model.selected
              ? null
              : (
                  <span style={S.row}>
                    {model.downloaded
                      ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => api.deleteLocalModel(model.id)).then(() => { catalog.reload() }) }}>{t('modelDelete')}</Button>
                      : null}
                    {supported
                      ? <Button size="sm" variant={model.downloaded ? 'primary' : 'outline'} disabled={busy} onClick={() => { selectModel(model.id) }}>{model.downloaded ? t('modelUse') : t('modelDownloadUse')}</Button>
                      : null}
                  </span>
                )}
          </li>
        ))}
      </ul>
    </div>
  )
}
