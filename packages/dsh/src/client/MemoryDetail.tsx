/** Detail dialog of one memory: edit, flags, lifecycle actions, history, and why it was recalled. */

import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { KINDS, type Kind, type MemoryApi, type MemoryDetail as Detail, type MemoryItem, type MemoryPatch } from './api.ts'
import { type Draft, draftOf, draftPatch, splitList } from './draft.ts'
import { MemoryTags } from './MemoryList.tsx'
import { type ConfirmRequest, LabeledSwitch, LoadError, S, type T, useLoad, when } from './ui.tsx'

/**
 * The detail dialog.
 * @param props - memory id (undefined closes the dialog), api, translator, change and confirm callbacks.
 * @returns the dialog.
 */
export function MemoryDetail({ id, api, t, onClose, onChanged, confirm, run, busy }: {
  id: number | undefined
  api: MemoryApi
  t: T
  onClose: () => void
  onChanged: () => void
  confirm: (request: ConfirmRequest) => void
  run: (action: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
}): ReactNode {
  const [shown, setShown] = useState(id)
  useEffect(() => { if (id !== undefined) setShown(id) }, [id])
  const detail = useLoad<Detail | undefined>(async () => shown === undefined ? undefined : api.detail(shown), [api, shown])
  const memory = detail.value?.memory
  const [draft, setDraft] = useState<Draft | undefined>()
  // Id of the memory the user has unsaved edits for; a reload of that memory keeps them.
  const edited = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (memory !== undefined && edited.current === memory.id) return
    edited.current = undefined
    setDraft(memory === undefined ? undefined : draftOf(memory))
  }, [memory])
  const editDraft = (next: Draft): void => {
    edited.current = memory?.id
    setDraft(next)
  }

  const act = async (action: () => Promise<unknown>, follow?: (result: unknown) => void): Promise<void> => {
    let result: unknown
    const ok = await run(async () => { result = await action() })
    if (!ok) return
    onChanged()
    if (follow === undefined) detail.reload()
    else follow(result)
  }

  const save = (): void => {
    if (memory === undefined || draft === undefined) return
    const patch = draftPatch(memory, draft)
    const content = draft.content.trim()
    void act(async () => {
      let current = memory
      if (Object.keys(patch).length > 0) current = await api.patch(current.id, patch)
      if (content !== '' && content !== memory.content) current = await api.correct(current.id, content)
      return current
    }, (result) => { edited.current = undefined; setShown((result as MemoryItem).id); detail.reload() })
  }

  const flag = (patch: MemoryPatch): void => { if (memory !== undefined) void act(() => api.patch(memory.id, patch)) }
  const editable = memory !== undefined && memory.status !== 'deleted' && memory.status !== 'superseded'
  const contentChanged = memory !== undefined && draft !== undefined && draft.content.trim() !== memory.content

  return (
    <Modal open={id !== undefined} onClose={onClose} title={t('detailTitle', { id: shown ?? '' })} closeLabel={t('close')}>
      {detail.error !== undefined ? <LoadError error={detail.error} retry={detail.reload} t={t} /> : null}
      {memory === undefined || draft === undefined
        ? (detail.error === undefined ? <p style={S.secondary}>{t('loading')}</p> : null)
        : (
            <div style={{ ...S.page, maxHeight: '70vh', overflow: 'auto' }}>
              <MemoryTags memory={memory} t={t} />
              <span style={S.caption}>
                {t('learnedAt', { time: when(memory.learnedAt) })}
                {' · '}
                {t('scope', { scope: memory.scope })}
                {' · '}
                {t('strength', { value: (detail.value?.strength ?? 0).toFixed(2) })}
              </span>
              {detail.value?.successor === undefined ? null : (
                <Button size="sm" variant="ghost" onClick={() => { setShown(detail.value!.successor!.id) }}>{t('successor', { id: detail.value.successor.id })}</Button>
              )}

              <label style={S.field}>
                <span style={S.secondary}>{t('content')}</span>
                <textarea style={S.textarea} value={draft.content} disabled={!editable} onChange={(event) => { editDraft({ ...draft, content: event.target.value }) }} />
                {contentChanged ? <span style={S.caption}>{t('correctionHint')}</span> : null}
              </label>
              <div style={S.row}>
                <label style={S.field}>
                  <span style={S.secondary}>{t('kind')}</span>
                  <select style={S.select} value={draft.kind} disabled={!editable} onChange={(event) => { editDraft({ ...draft, kind: event.target.value as Kind }) }}>
                    {KINDS.map(value => <option key={value} value={value}>{t(`kind.${value}`)}</option>)}
                  </select>
                </label>
                <label style={S.field}>
                  <span style={S.secondary}>{t('importance')}</span>
                  <select style={S.select} value={draft.importance} disabled={!editable} onChange={(event) => { editDraft({ ...draft, importance: Number(event.target.value) }) }}>
                    {[1, 2, 3].map(value => <option key={value} value={value}>{t(`importance.${value as 1 | 2 | 3}`)}</option>)}
                  </select>
                </label>
                <label style={S.field}>
                  <span style={S.secondary}>{t('occurredAt')}</span>
                  <Input type="date" value={draft.occurredAt} disabled={!editable} onChange={(event) => { editDraft({ ...draft, occurredAt: event.target.value }) }} />
                </label>
                <label style={S.field}>
                  <span style={S.secondary}>{t('followUpAt')}</span>
                  <Input type="date" value={draft.followUpAt} disabled={!editable} onChange={(event) => { editDraft({ ...draft, followUpAt: event.target.value }) }} />
                </label>
              </div>
              <label style={S.field}>
                <span style={S.secondary}>{t('people')}</span>
                <Input value={draft.people} disabled={!editable} onChange={(event) => { editDraft({ ...draft, people: event.target.value }) }} />
              </label>
              {editable
                ? (
                    <div style={S.row}>
                      <Button size="sm" variant="primary" disabled={busy} onClick={save}>{contentChanged ? t('saveAsCorrection') : t('save')}</Button>
                    </div>
                  )
                : null}

              {editable
                ? (
                    <div style={S.row}>
                      <LabeledSwitch checked={memory.pinned} label={t('pin')} disabled={busy} onChange={(pinned) => { flag({ pinned }) }} />
                      <LabeledSwitch checked={memory.sensitive} label={t('sensitiveSwitch')} disabled={busy} onChange={(sensitive) => { flag({ sensitive }) }} />
                      <LabeledSwitch checked={memory.mentionBlocked} label={t('mentionBlockSwitch')} disabled={busy} onChange={(mentionBlocked) => { flag({ mentionBlocked }) }} />
                      <LabeledSwitch checked={memory.needsConfirm} label={t('confirmSwitch')} disabled={busy} onChange={(needsConfirm) => { flag({ needsConfirm }) }} />
                    </div>
                  )
                : null}

              <div style={S.row}>
                {memory.status === 'active' || memory.status === 'faded'
                  ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { flag({ status: 'archived' }) }}>{t('archive')}</Button>
                  : null}
                {memory.status === 'archived'
                  ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { flag({ status: 'active' }) }}>{t('unarchive')}</Button>
                  : null}
                {memory.status === 'deleted'
                  ? (
                      <>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act(() => api.restore(memory.id)) }}>{t('restore')}</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => { confirm({ message: t('purgeConfirm'), danger: true, action: async () => { await api.purge(memory.id); onChanged(); onClose() } }) }}>{t('purge')}</Button>
                      </>
                    )
                  : (
                      <>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act(() => api.remove(memory.id)) }}>{t('remove')}</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => { confirm({ message: t('forgetConfirm'), danger: true, action: async () => { await api.forget(memory.id); onChanged(); detail.reload() } }) }}>{t('forget')}</Button>
                      </>
                    )}
              </div>

              {(detail.value?.history.length ?? 0) > 0
                ? (
                    <section style={S.field}>
                      <strong style={S.primary}>{t('history')}</strong>
                      <ul style={S.list}>
                        {detail.value!.history.map(old => (
                          <li key={old.id} style={S.caption}>
                            #{old.id} · {when(old.learnedAt)} · {old.content}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                : null}

              <section style={S.field}>
                <strong style={S.primary}>{t('recalls', { count: detail.value?.recalls.length ?? 0 })}</strong>
                {(detail.value?.recalls.length ?? 0) === 0
                  ? <span style={S.caption}>{t('noRecalls')}</span>
                  : (
                      <ul style={S.list}>
                        {detail.value!.recalls.map(entry => (
                          <li key={`${entry.sessionId}:${entry.turn}:${entry.createdAt}`} style={S.caption}>
                            {when(entry.createdAt)} · {entry.reason} · {entry.score.toFixed(2)}
                            {entry.filtered === null ? '' : ` · ${t('recallFiltered', { reason: entry.filtered })}`}
                          </li>
                        ))}
                      </ul>
                    )}
              </section>

              {(detail.value?.mentions.length ?? 0) > 0
                ? (
                    <section style={S.field}>
                      <strong style={S.primary}>{t('mentions', { count: detail.value!.mentions.length })}</strong>
                      <ul style={S.list}>
                        {detail.value!.mentions.map(mention => (
                          <li key={`${mention.sessionId}:${mention.mentionedAt}`} style={S.caption}>
                            {when(mention.mentionedAt)}
                            {mention.responded === null ? '' : ` · ${mention.responded ? t('responded') : t('ignored')}`}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                : null}
            </div>
          )}
    </Modal>
  )
}
