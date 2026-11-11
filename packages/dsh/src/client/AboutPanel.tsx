/**
 * About section at the bottom of the memory page: how the plugin writes,
 * recalls, and stores memories, and who makes Her. Collapsed until opened.
 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { type ReactNode, useState } from 'react'
import type { MemoryLocaleKey } from './locales.ts'
import { S, type T } from './ui.tsx'

/** Her website. */
const SITE = 'https://hersoul.cn/zh'

const TOPICS: readonly (readonly [MemoryLocaleKey, MemoryLocaleKey])[] = [
  ['aboutWriteTitle', 'aboutWrite'],
  ['aboutRecallTitle', 'aboutRecall'],
  ['aboutControlTitle', 'aboutControl'],
  ['aboutDataTitle', 'aboutData'],
]

/**
 * The about section.
 * @param props - translator.
 * @returns the section.
 */
export function AboutPanel({ t }: { t: T }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <section style={S.card} data-testid="her-memory-about">
      <div style={S.between}>
        <strong style={S.primary}>{t('aboutTitle')}</strong>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => { setOpen(current => !current) }}>{open ? t('aboutHide') : t('aboutShow')}</Button>
      </div>
      {open
        ? (
            <div style={S.page}>
              {TOPICS.map(([title, body]) => (
                <div key={title} style={S.field}>
                  <span style={S.primary}>{t(title)}</span>
                  <span style={S.secondary}>{t(body)}</span>
                </div>
              ))}
              <div style={S.field}>
                <span style={S.primary}>{t('aboutHerTitle')}</span>
                <span style={S.secondary}>{t('aboutHer')}</span>
                <a href={SITE} target="_blank" rel="noreferrer" style={{ color: 'var(--dsw-alias-link)' }}>{SITE}</a>
              </div>
            </div>
          )
        : null}
    </section>
  )
}
