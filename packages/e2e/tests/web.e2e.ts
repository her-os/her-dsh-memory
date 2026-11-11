/**
 * The management tab inside a real `dsh web`: memories learned through the
 * headless profile show up, edits made in the UI land in the database, and
 * the plugin's settings are edited on the same page.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
/** Every settings layer file of a profile, concatenated. */
const patchText = (profile: string): string => {
  const dir = join(home.dir, 'profiles', profile)
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(name => /\.ya?ml$/u.test(name))
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}
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
    await expect.poll(() => page.getByTestId('her-memory-stat-active').textContent()).toBe('在用2')
  })

  it('searches memories by keyword', async () => {
    const search = page.getByRole('searchbox', { name: '按关键词或意思搜索' })
    await search.fill('面试')
    await expect.poll(() => page.getByText(CAT_MEMORY).count()).toBe(0)
    expect(await page.getByText(INTERVIEW_MEMORY).count()).toBeGreaterThan(0)
    await search.fill('')
    await expect.poll(() => page.getByText(CAT_MEMORY).count()).toBeGreaterThan(0)
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

  it('edits the settings from the page, and the plugin picks them up', async () => {
    const settings = page.getByTestId('her-memory-settings')
    await settings.getByRole('button', { name: '展开设置' }).click()
    const source = settings.getByLabel('语义检索来源')
    expect(await source.inputValue()).toBe('off')
    await source.selectOption('remote')
    // The Host plugin reloads with the new source: remote without an address reports itself unconfigured.
    await expect.poll(() => page.getByText(/未配置向量服务/u).count(), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(() => settings.getByLabel('服务地址').count()).toBe(1)

    const recall = settings.getByLabel('每轮最多带入几条记忆')
    await recall.fill('99')
    await expect.poll(() => settings.getByText('请输入 1 到 20 之间的整数').count()).toBe(1)
    await recall.fill('7')
    await recall.press('Enter')
    await expect.poll(() => patchText('web'), { timeout: 30_000 }).toMatch(/recallCount\W+7/u)
    expect(patchText('web')).toMatch(/provider\W+remote/u)

    const batch = settings.getByLabel('攒满几轮整理一次')
    expect(await batch.inputValue()).toBe('3')
    await batch.fill('1')
    await batch.press('Enter')
    await expect.poll(() => patchText('web'), { timeout: 30_000 }).toMatch(/extractBatchTurns\W+1/u)
    await settings.getByLabel('回复前先整理其它会话').selectOption('off')
    await expect.poll(() => patchText('web'), { timeout: 30_000 }).toMatch(/extractBeforeRecall\W+false/u)

    await source.selectOption('off')
    await expect.poll(() => page.getByRole('button', { name: '开启本机语义检索' }).count(), { timeout: 30_000 }).toBe(1)
  })
})
