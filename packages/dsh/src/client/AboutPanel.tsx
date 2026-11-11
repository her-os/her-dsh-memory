/**
 * Header of the memory page: what the plugin is and who makes it, with the
 * how-it-works tiles collapsed until opened.
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

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 } as const
const tile = { ...S.stat, padding: '10px 12px', gap: 4 } as const
const tileTitle = { fontSize: 'var(--dsw-font-xs-13-font-size, 13px)', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } as const
const link = { color: 'var(--dsw-alias-link)', textDecoration: 'none', fontSize: 'var(--dsw-font-xs-13-font-size, 13px)' } as const

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
        <span style={S.rowText}>
          <strong style={S.primary}>{t('aboutTitle')}</strong>
          <span style={S.caption}>{t('aboutTagline')}</span>
        </span>
        <span style={S.row}>
          <a href={SITE} target="_blank" rel="noreferrer" style={link}>{`${t('aboutLink')} ↗`}</a>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => { setOpen(current => !current) }}>{open ? t('aboutHide') : t('aboutShow')}</Button>
        </span>
      </div>
      {open
        ? (
            <div style={grid}>
              {TOPICS.map(([title, body]) => (
                <div key={title} style={tile}>
                  <span style={tileTitle}>{t(title)}</span>
                  <span style={S.caption}>{t(body)}</span>
                </div>
              ))}
            </div>
          )
        : null}
    </section>
  )
}
