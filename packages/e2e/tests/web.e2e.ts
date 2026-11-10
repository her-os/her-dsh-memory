/**
 * The management tab inside a real `dsh web`: memories learned through the
 * headless profile show up, and edits made in the UI land in the database.
 */

import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { DshHome, type WebServer } from '../src/dsh.ts'
import { openMemoryPage } from '../src/web.ts'
import { DEFAULT_ANSWER, extractionReply, type MockModel, startMockModel } from '../src/mock-model.ts'

const CAT = '我家的猫叫年糕，是只橘猫'
const INTERVIEW = '下周三我有个面试，有点紧张'
const CAT_MEMORY = '用户养了一只叫年糕的橘猫'
const INTERVIEW_MEMORY = '用户下周三有一场面试'
const CORRECTED = '用户养了两只猫：橘猫年糕和白猫汤圆'

interface Row { id: number; content: string; status: string; pinned: number; supersedes: number | null }

let mock: MockModel
let home: DshHome
let web: WebServer
let browser: Browser
let page: Page

const rows = (): Row[] => home.query<Row>('SELECT id, content, status, pinned, supersedes FROM memories ORDER BY id')
const row = (content: string): Row | undefined => rows().find(r => r.content === content)
const meta = (key: string): string | undefined => home.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)[0]?.value

beforeAll(async () => {
  mock = await startMockModel()
  mock.respond(request => request.extraction
    ? extractionReply([
        { action: 'add', kind: 'preference', content: CAT_MEMORY, evidence: CAT, importance: 2 },
        { action: 'add', kind: 'promise', content: INTERVIEW_MEMORY, evidence: '下周三我有个面试', importance: 3 },
      ])
    : { text: DEFAULT_ANSWER })
  home = new DshHome(mock.baseURL)
  await home.addPlugin('headless', inject('tarball'))
  await home.addPlugin('web', inject('tarball'))
  // Semantic search has its own test (local-embed.e2e.ts); these stay offline.
  home.configurePlugin('headless', { embedding: { provider: 'off' } })
  home.configurePlugin('web', { embedding: { provider: 'off' } })
  const first = await home.headless(CAT)
  await home.headless(INTERVIEW, first.sessionId)
  await home.headless('今天就先聊到这吧', first.sessionId)
  // A recall, so the detail has a reason to show.
  await home.headless('年糕最近老挑食怎么办')

  web = await home.web()
  browser = await chromium.launch({ channel: process.env.HER_MEMORY_CHROME_CHANNEL ?? 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1400, height: 1000 } })
  page = await context.newPage()
  await page.goto(web.url)
  await openMemoryPage(page)
})

afterAll(async () => {
  await browser?.close()
  await web?.stop()
  await mock?.close()
  home?.dispose()
})

describe('her-memory management tab in DSH web', () => {
  it('lists the learned memories with their counts', async () => {
    await expect.poll(() => page.getByText(CAT_MEMORY).count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByText(INTERVIEW_MEMORY).count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByText(/在用 2 条/u).count()).toBeGreaterThan(0)
  })

  it('shows why a memory was recalled', async () => {
    await page.getByText(CAT_MEMORY).first().click()
    const dialog = page.getByRole('dialog')
    await expect.poll(() => dialog.getByText(/为什么想起它（最近 1 次）/u).count()).toBe(1)
    expect(await dialog.getByText('还没有被想起过。').count()).toBe(0)
  })

  it('pins from the detail dialog', async () => {
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('switch', { name: '置顶' }).click()
    await expect.poll(() => row(CAT_MEMORY)?.pinned).toBe(1)
  })

  it('saves an edited content as a new version and keeps the old one as history', async () => {
    const dialog = page.getByRole('dialog')
    const old = row(CAT_MEMORY)!
    await dialog.locator('textarea').first().fill(CORRECTED)
    await dialog.getByRole('button', { name: '保存为更正' }).click()
    await expect.poll(() => row(CORRECTED)?.status).toBe('active')
    expect(row(CORRECTED)!.supersedes).toBe(old.id)
    expect(row(CAT_MEMORY)!.status).toBe('superseded')
    await expect.poll(() => dialog.getByText('历史版本').count()).toBe(1)
  })

  it('deletes to the trash and restores', async () => {
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await expect.poll(() => row(CORRECTED)?.status).toBe('deleted')
    await dialog.getByRole('button', { name: '恢复', exact: true }).click()
    await expect.poll(() => row(CORRECTED)?.status).toBe('active')
    await page.keyboard.press('Escape')
  })

  it('pausing stops learning from new turns', async () => {
    await page.getByRole('switch', { name: '记住新的事情' }).click()
    await expect.poll(() => meta('paused')).toBe('1')
    const queued = (): number => home.query('SELECT 1 FROM extract_queue').length
    const before = queued()
    await home.headless('我下个月要去成都出差')
    expect(queued()).toBe(before)
    expect(home.query("SELECT 1 FROM extract_queue WHERE payload LIKE '%成都%'")).toHaveLength(0)
  })
})
