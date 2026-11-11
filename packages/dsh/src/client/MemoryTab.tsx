/**
 * Memory management page on this bundle's page in Plugins: an overview with
 * the pause switch and the semantic-search index, the settings, then
 * memories, people, forgotten items, and trash, and an about section last.
 */

import { Button, Input, SegmentedControl, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import type { MemoryApi, PersonItem } from './api.ts'
import { EmbeddingPanel, embeddingBusy, usePoll } from './EmbeddingPanel.tsx'
import { MemoryDetail } from './MemoryDetail.tsx'
import { MemoryList } from './MemoryList.tsx'
import { type SettingValue, type SettingsForm, useSettings } from './settings.ts'
import { SettingsPanel } from './SettingsPanel.tsx'
import { AboutPanel } from './AboutPanel.tsx'
import { splitList } from './draft.ts'
import { type ConfirmRequest, ConfirmDialog, LoadError, S, type T, useAction, useLoad, when } from './ui.tsx'

/** What the registration injects. */
export interface MemoryTabInjected {
  readonly api: MemoryApi
  /** DSH config form of this plugin's settings. */
  readonly settings: SettingsForm
}

/** Props assembled by the Plugins page slot renderer. */
export type MemoryTabProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'herMemory'> & InjectFace<MemoryTabInjected>

type View = 'memories' | 'people' | 'suppressions' | 'trash'

/**
 * Render the memory page.
 * @param props - slot runtime props, the translator and the injected api.
 * @returns the page content.
 */
export function MemoryTab({ t, api, settings: form }: MemoryTabProps): ReactNode {
  const id = useId()
  const [view, setView] = useState<View>('memories')
  const [person, setPerson] = useState<string | undefined>()
  const [openId, setOpenId] = useState<number | undefined>()
  const [version, setVersion] = useState(0)
  const [confirming, setConfirming] = useState<ConfirmRequest | undefined>()
  const { run, failure, busy } = useAction()
  const changed = useCallback(() => { setVersion(n => n + 1) }, [])
  const overview = useLoad(() => api.overview(), [api, version])
  const settings = useSettings(form)
  // A settings write reloads the Host plugin; show its new state once the revision moves.
  const revision = settings.snapshot.revision
  useEffect(() => { if (revision !== undefined) changed() }, [revision, changed])
  const save = useCallback((path: readonly string[], value: SettingValue): void => {
    void run(async () => { if (!await settings.set(path, value)) throw new Error(t('settingsRejected')) })
  }, [run, settings, t])

  const showPerson = (name: string): void => {
    setPerson(name)
    setView('memories')
  }

  return (
    <div style={S.page}>
      <Overview api={api} t={t} overview={overview} run={run} busy={busy} onChanged={changed} selectModel={(id) => { save(['embedding', 'localModel'], id) }} enableLocal={() => { save(['embedding', 'provider'], 'local') }} />
      {failure === undefined ? null : <span style={S.error}>{t('actionFailed', { error: failure })}</span>}
      <SettingsPanel settings={settings} t={t} busy={busy} save={save} />
      <SegmentedControl<View>
        id={`${id}-view`}
        label={t('tab')}
        value={view}
        onChange={setView}
        options={[
          { value: 'memories', label: t('viewMemories') },
          { value: 'people', label: t('viewPeople') },
          { value: 'suppressions', label: t('viewSuppressions') },
          { value: 'trash', label: t('viewTrash') },
        ]}
      />
      {view === 'memories' ? <MemoryList api={api} t={t} person={person} clearPerson={() => { setPerson(undefined) }} open={setOpenId} version={version} /> : null}
      {view === 'people' ? <PeopleView api={api} t={t} run={run} busy={busy} version={version} onChanged={changed} showPerson={showPerson} /> : null}
      {view === 'suppressions' ? <SuppressionsView api={api} t={t} run={run} busy={busy} version={version} onChanged={changed} /> : null}
      {view === 'trash' ? <TrashView api={api} t={t} open={setOpenId} version={version} confirm={setConfirming} onChanged={changed} /> : null}
      <AboutPanel t={t} />
      <MemoryDetail id={openId} api={api} t={t} onClose={() => { setOpenId(undefined) }} onChanged={changed} confirm={setConfirming} run={run} busy={busy} />
      <ConfirmDialog request={confirming} onClose={() => { setConfirming(undefined) }} run={run} t={t} />
    </div>
  )
}

function Overview({ api, t, overview, run, busy, onChanged, selectModel, enableLocal }: {
  api: MemoryApi
  t: T
  overview: ReturnType<typeof useLoad<Awaited<ReturnType<MemoryApi['overview']>>>>
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  onChanged: () => void
  selectModel: (id: string) => void
  enableLocal: () => void
}): ReactNode {
  usePoll(overview.value !== undefined && embeddingBusy(overview.value.embedding), overview.reload)
  if (overview.error !== undefined && overview.value === undefined) return <LoadError error={overview.error} retry={overview.reload} t={t} />
  const value = overview.value
  if (value === undefined) return <p style={S.secondary}>{t('loading')}</p>
  const { counts, embedding } = value
  const stats = [
    ['active', t('statActive'), counts.active],
    ['faded', t('statFaded'), counts.faded],
    ['archived', t('statArchived'), counts.archived],
    ['deleted', t('statDeleted'), counts.deleted],
  ] as const
  return (
    <>
      <section style={S.card}>
        <div style={S.between}>
          <span style={S.rowText}>
            <span style={S.row}>
              <strong style={S.primary}>{t('overviewTitle')}</strong>
              <Tag tone={value.paused ? 'warning' : 'success'}>{value.paused ? t('paused') : t('enabled')}</Tag>
            </span>
            <span style={S.caption}>{t('pauseHint')}</span>
          </span>
          <Switch
            checked={!value.paused}
            label={t('pauseSwitch')}
            disabled={busy}
            onChange={(on) => { void run(() => api.setPaused(!on)).then((ok) => { if (ok) onChanged() }) }}
          />
        </div>
        <div style={S.stats}>
          {stats.map(([key, label, count]) => (
            <div key={key} style={S.stat} data-testid={`her-memory-stat-${key}`}>
              <span style={S.caption}>{label}</span>
              <span style={S.statValue}>{count}</span>
            </div>
          ))}
        </div>
        {value.queue > 0 ? <span style={S.caption}>{t('queueLine', { count: value.queue })}</span> : null}
        {value.extractError === null ? null : <span style={S.error}>{t('extractError', { time: when(value.extractError.at), error: value.extractError.message })}</span>}
      </section>
      <EmbeddingPanel api={api} t={t} embedding={embedding} run={run} busy={busy} onChanged={onChanged} selectModel={selectModel} enableLocal={enableLocal} />
    </>
  )
}

function PeopleView({ api, t, run, busy, version, onChanged, showPerson }: {
  api: MemoryApi
  t: T
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  version: number
  onChanged: () => void
  showPerson: (name: string) => void
}): ReactNode {
  const people = useLoad(() => api.people(), [api, version])
  const [editing, setEditing] = useState<{ id: number; relation: string; note: string; aliases: string } | undefined>()
  if (people.error !== undefined) return <LoadError error={people.error} retry={people.reload} t={t} />
  if (people.value === undefined) return <p style={S.secondary}>{t('loading')}</p>
  if (people.value.length === 0) return <p style={S.secondary}>{t('peopleEmpty')}</p>
  const startEdit = (person: PersonItem): void => {
    setEditing({ id: person.id, relation: person.relation ?? '', note: person.note ?? '', aliases: person.aliases.join('，') })
  }
  return (
    <ul style={S.list}>
      {people.value.map(person => (
        <li key={person.id} style={S.card}>
          <div style={S.between}>
            <span style={S.primary}>
              <strong>{person.name}</strong>
              {person.relation === null ? '' : ` · ${person.relation}`}
              {person.aliases.length === 0 ? '' : ` · ${person.aliases.join('、')}`}
            </span>
            <span style={S.row}>
              <span style={S.caption}>{t('memoryCount', { count: person.memoryCount })}</span>
              <Button size="sm" variant="ghost" onClick={() => { showPerson(person.name) }}>{t('showMemories')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { startEdit(person) }}>{t('edit')}</Button>
            </span>
          </div>
          {person.note === null || editing?.id === person.id ? null : <span style={S.caption}>{person.note}</span>}
          {editing?.id !== person.id
            ? null
            : (
                <div style={S.page}>
                  <label style={S.field}>
                    <span style={S.secondary}>{t('relation')}</span>
                    <Input value={editing.relation} onChange={(event) => { setEditing({ ...editing, relation: event.target.value }) }} />
                  </label>
                  <label style={S.field}>
                    <span style={S.secondary}>{t('aliases')}</span>
                    <Input value={editing.aliases} onChange={(event) => { setEditing({ ...editing, aliases: event.target.value }) }} />
                  </label>
                  <label style={S.field}>
                    <span style={S.secondary}>{t('note')}</span>
                    <textarea style={S.textarea} value={editing.note} onChange={(event) => { setEditing({ ...editing, note: event.target.value }) }} />
                  </label>
                  <div style={S.row}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => {
                        void run(() => api.updatePerson(editing.id, { relation: editing.relation, note: editing.note, aliases: splitList(editing.aliases) }))
                          .then((ok) => { if (ok) { setEditing(undefined); onChanged() } })
                      }}
                    >
                      {t('save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(undefined) }}>{t('cancel')}</Button>
                  </div>
                </div>
              )}
        </li>
      ))}
    </ul>
  )
}

function SuppressionsView({ api, t, run, busy, version, onChanged }: {
  api: MemoryApi
  t: T
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
  version: number
  onChanged: () => void
}): ReactNode {
  const items = useLoad(() => api.suppressions(), [api, version])
  if (items.error !== undefined) return <LoadError error={items.error} retry={items.reload} t={t} />
  if (items.value === undefined) return <p style={S.secondary}>{t('loading')}</p>
  return (
    <div style={S.page}>
      <span style={S.caption}>{t('suppressionsHint')}</span>
      {items.value.length === 0
        ? <p style={S.secondary}>{t('suppressionsEmpty')}</p>
        : (
            <ul style={S.list}>
              {items.value.map(item => (
                <li key={item.id} style={{ ...S.card, ...S.between, flexDirection: 'row' }}>
                  <span style={S.primary}>{item.summary}</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => api.removeSuppression(item.id)).then((ok) => { if (ok) onChanged() }) }}>{t('allowAgain')}</Button>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}

function TrashView({ api, t, open, version, confirm, onChanged }: {
  api: MemoryApi
  t: T
  open: (id: number) => void
  version: number
  confirm: (request: ConfirmRequest) => void
  onChanged: () => void
}): ReactNode {
  const trash = useLoad(() => api.list({ statuses: ['deleted'] }, 0, 200), [api, version])
  if (trash.error !== undefined) return <LoadError error={trash.error} retry={trash.reload} t={t} />
  if (trash.value === undefined) return <p style={S.secondary}>{t('loading')}</p>
  return (
    <div style={S.page}>
      <div style={S.between}>
        <span style={S.caption}>{t('trashHint')}</span>
        {trash.value.total === 0
          ? null
          : <Button size="sm" variant="outline" onClick={() => { confirm({ message: t('emptyTrashConfirm'), danger: true, action: async () => { await api.emptyTrash(); onChanged() } }) }}>{t('emptyTrash')}</Button>}
      </div>
      {trash.value.total === 0
        ? <p style={S.secondary}>{t('trashEmpty')}</p>
        : (
            <ul style={S.list}>
              {trash.value.items.map(memory => (
                <li key={memory.id}>
                  <button type="button" onClick={() => { open(memory.id) }} style={{ ...S.card, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
                    <span style={S.primary}>{memory.content}</span>
                    <span style={S.caption}>#{memory.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}
