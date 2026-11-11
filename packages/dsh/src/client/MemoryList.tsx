/**
 * Filterable memory list, one page at a time with previous and next buttons.
 */

import { Button, Checkbox, Input, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { KINDS, type Kind, type ListFilter, type MemoryApi, type MemoryItem, type Status } from './api.ts'
import { S, type T, messageOf } from './ui.tsx'

/** Rows shown per page. */
export const PAGE_SIZE = 20

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
  const [page, setPage] = useState(1)
  // The page the shown rows belong to; it trails `page` while the next one loads.
  const [shown, setShown] = useState(1)
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const top = useRef<HTMLDivElement>(null)

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

  // A new filter starts over from the first page.
  useEffect(() => { setPage(1) }, [filterKey])

  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    try {
      const result = await api.list(JSON.parse(filterKey) as ListFilter, (page - 1) * PAGE_SIZE, PAGE_SIZE)
      if (request !== generation.current) return
      // A page past the end, e.g. after deleting the last row on it, falls back to the last page.
      const last = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      if (page > last) {
        setPage(last)
        return
      }
      setItems(result.items)
      setShown(page)
      setTotal(result.total)
      setError(undefined)
    } catch (failure) {
      if (request === generation.current) setError(messageOf(failure))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [api, filterKey, page])

  useEffect(() => { void load() }, [load, version])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const go = (next: number): void => {
    setPage(next)
    top.current?.scrollIntoView({ block: 'nearest' })
  }

  const nothingStored = items.length === 0 && !loading && error === undefined && filterKey === JSON.stringify({ statuses: STATUS_VIEWS.current })

  return (
    <div style={S.page} ref={top}>
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
          <Button size="sm" variant="outline" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      )}
      {items.length === 0 && !loading && error === undefined
        ? <p style={S.secondary}>{nothingStored ? t('empty') : t('noMatch')}</p>
        : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: loading ? 0.6 : 1 }} role="list" aria-label={t('viewMemories')}>
                {items.map(memory => (
                  <div key={memory.id} role="listitem">
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
                ))}
              </div>
              {pages > 1
                ? (
                    <nav style={{ ...S.row, justifyContent: 'center' }} aria-label={t('pagination')}>
                      <Button size="sm" variant="outline" disabled={shown <= 1 || loading} onClick={() => { go(shown - 1) }}>{t('previousPage')}</Button>
                      <span style={S.caption}>{t('pageOf', { page: shown, pages })}</span>
                      <Button size="sm" variant="outline" disabled={shown >= pages || loading} onClick={() => { go(shown + 1) }}>{t('nextPage')}</Button>
                    </nav>
                  )
                : null}
            </>
          )}
    </div>
  )
}
