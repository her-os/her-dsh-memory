/**
 * Filterable memory list. Rows are virtualized and fetched page by page as
 * the user scrolls, so tens of thousands of memories stay responsive.
 */

import { Button, Checkbox, Input, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { KINDS, type Kind, type ListFilter, type MemoryApi, type MemoryItem, type Status } from './api.ts'
import { S, type T, messageOf } from './ui.tsx'

/** Rows fetched per request. */
export const PAGE_SIZE = 100
const ROW_ESTIMATE = 68
const LIST_HEIGHT = 520

type StatusView = 'current' | 'archived' | 'history' | 'all'

const STATUS_VIEWS: Record<StatusView, readonly Status[]> = {
  current: ['active', 'faded'],
  archived: ['archived'],
  history: ['superseded'],
  all: ['active', 'faded', 'archived', 'superseded'],
}

/**
 * Status and flag tags of one memory.
 * @param props - the memory and translator.
 * @returns the tags.
 */
export function MemoryTags({ memory, t }: { memory: MemoryItem; t: T }): ReactNode {
  return (
    <span style={S.row}>
      <Tag tone="quiet">{t(`kind.${memory.kind}`)}</Tag>
      {memory.status === 'active' ? null : <Tag tone={memory.status === 'deleted' ? 'danger' : 'neutral'}>{t(`status.${memory.status}`)}</Tag>}
      {memory.pinned ? <Tag tone="info">{t('pinned')}</Tag> : null}
      {memory.sensitive ? <Tag tone="warning">{t('sensitive')}</Tag> : null}
      {memory.mentionBlocked ? <Tag tone="outline">{t('mentionBlocked')}</Tag> : null}
      {memory.needsConfirm ? <Tag tone="outline">{t('needsConfirm')}</Tag> : null}
    </span>
  )
}

/**
 * The memories view.
 * @param props - api, translator, person filter, open-detail callback and a change counter that forces a reload.
 * @returns the list with its filters.
 */
export function MemoryList({ api, t, person, clearPerson, open, version }: {
  api: MemoryApi
  t: T
  person: string | undefined
  clearPerson: () => void
  open: (id: number) => void
  version: number
}): ReactNode {
  const id = useId()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind | ''>('')
  const [statusView, setStatusView] = useState<StatusView>('current')
  const [pinned, setPinned] = useState(false)
  const [sensitive, setSensitive] = useState(false)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()) }, 250)
    return () => { clearTimeout(timer) }
  }, [search])

  const filter: ListFilter = {
    statuses: STATUS_VIEWS[statusView],
    ...(query === '' ? {} : { search: query }),
    ...(kind === '' ? {} : { kind }),
    ...(person === undefined ? {} : { person }),
    ...(pinned ? { pinned: true } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  }
  const filterKey = JSON.stringify(filter)

  const fetchPage = useCallback(async (offset: number, reset: boolean) => {
    if (inFlight.current && !reset) return
    const request = reset ? ++generation.current : generation.current
    inFlight.current = true
    setLoading(true)
    try {
      const page = await api.list(JSON.parse(filterKey) as ListFilter, offset, PAGE_SIZE)
      if (request !== generation.current) return
      setItems(current => reset ? page.items : [...current, ...page.items])
      setTotal(page.total)
      setError(undefined)
    } catch (failure) {
      if (request === generation.current) setError(messageOf(failure))
    } finally {
      if (request === generation.current) {
        inFlight.current = false
        setLoading(false)
      }
    }
  }, [api, filterKey])

  useEffect(() => { void fetchPage(0, true) }, [fetchPage, version])

  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const lastIndex = virtualRows.at(-1)?.index ?? -1
  useEffect(() => {
    if (lastIndex >= items.length - 10 && items.length < total && !loading) void fetchPage(items.length, false)
  }, [lastIndex, items.length, total, loading, fetchPage])

  const nothingStored = items.length === 0 && !loading && error === undefined && filterKey === JSON.stringify({ statuses: STATUS_VIEWS.current })

  return (
    <div style={S.page}>
      <div style={S.row}>
        <Input type="search" placeholder={t('search')} aria-label={t('search')} value={search} onChange={(event) => { setSearch(event.target.value) }} style={{ minWidth: 200 }} />
        <select aria-label={t('kind')} style={S.select} value={kind} onChange={(event) => { setKind(event.target.value as Kind | '') }}>
          <option value="">{t('allKinds')}</option>
          {KINDS.map(value => <option key={value} value={value}>{t(`kind.${value}`)}</option>)}
        </select>
        <SegmentedControl<StatusView>
          id={`${id}-status`}
          label={t('statusFilter')}
          value={statusView}
          onChange={setStatusView}
          options={[
            { value: 'current', label: t('statusCurrent') },
            { value: 'archived', label: t('statusArchived') },
            { value: 'history', label: t('statusHistory') },
            { value: 'all', label: t('statusAll') },
          ]}
        />
      </div>
      <div style={S.between}>
        <div style={S.row}>
          <Checkbox checked={pinned} onChange={setPinned} label={t('onlyPinned')} />
          <Checkbox checked={sensitive} onChange={setSensitive} label={t('onlySensitive')} />
          {person === undefined ? null : (
            <span style={S.row}>
              <Tag tone="info">{t('personFilter', { name: person })}</Tag>
              <Button size="sm" variant="ghost" onClick={clearPerson}>{t('clearPerson')}</Button>
            </span>
          )}
        </div>
        <span style={S.caption}>{loading && items.length === 0 ? t('loading') : t('total', { count: total })}</span>
      </div>
      {error === undefined ? null : (
        <div style={S.row}>
          <span style={S.error}>{t('loadFailed', { error })}</span>
          <Button size="sm" variant="outline" onClick={() => { void fetchPage(0, true) }}>{t('retry')}</Button>
        </div>
      )}
      {items.length === 0 && !loading && error === undefined
        ? <p style={S.secondary}>{nothingStored ? t('empty') : t('noMatch')}</p>
        : (
            <div ref={scroller} style={{ height: LIST_HEIGHT, overflow: 'auto', contain: 'strict' }} role="list" aria-label={t('viewMemories')}>
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {virtualRows.map((row) => {
                  const memory = items[row.index]
                  if (memory === undefined) return null
                  return (
                    <div
                      key={memory.id}
                      role="listitem"
                      data-index={row.index}
                      ref={virtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)`, paddingBottom: 6, boxSizing: 'border-box' }}
                    >
                      <button
                        type="button"
                        onClick={() => { open(memory.id) }}
                        style={{ ...S.card, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', gap: 4 }}
                      >
                        <span style={{ ...S.primary, overflowWrap: 'anywhere' }}>{memory.content}</span>
                        <span style={S.between}>
                          <MemoryTags memory={memory} t={t} />
                          <span style={S.caption}>
                            #{memory.id}
                            {memory.people.length === 0 ? '' : ` · ${memory.people.join('、')}`}
                            {memory.occurredAt === null ? '' : ` · ${memory.occurredAt}`}
                          </span>
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
    </div>
  )
}
