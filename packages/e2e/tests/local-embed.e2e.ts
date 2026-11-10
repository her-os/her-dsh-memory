/**
 * On-device semantic search inside a real DSH: the Web server downloads the
 * runtime and model in the background, the page shows progress and the
 * catalog, and once ready a paraphrase with no shared keyword recalls the
 * memory. Downloads about 140 MB, so it runs only with `HER_MEMORY_E2E_LOCAL=1`;
 * `HER_MEMORY_EMBED_CACHE` points at a filled cache root to skip the download.
 */

import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { DshHome, type WebServer } from '../src/dsh.ts'
import { openMemoryPage } from '../src/web.ts'
import { DEFAULT_ANSWER, extractionReply, type MockModel, startMockModel } from '../src/mock-model.ts'

const CAT_MEMORY = '用户养了一只叫年糕的橘猫'
const MODEL = 'bge-small-zh'
const SETTINGS = { embedding: { provider: 'local', localModel: MODEL, downloadSource: 'auto' } }
/** Longest wait for the download and load. */
const READY_TIMEOUT_MS = 15 * 60_000

let mock: MockModel
let home: DshHome
let web: WebServer
let browser: Browser
let page: Page

const vectors = (): number => home.query<{ n: number }>('SELECT count(*) AS n FROM memory_vectors')[0]!.n

describe.runIf(process.env.HER_MEMORY_E2E_LOCAL === '1')('her-memory local embedding in DSH', () => {
  beforeAll(async () => {
    mock = await startMockModel()
    mock.respond(request => request.extraction
      ? extractionReply([{ action: 'add', kind: 'preference', content: CAT_MEMORY, evidence: '我家的猫叫年糕，是只橘猫', importance: 2 }])
      : { text: DEFAULT_ANSWER })
    home = new DshHome(mock.baseURL)
    const cache = process.env.HER_MEMORY_EMBED_CACHE?.trim()
    if (cache !== undefined && cache !== '' && existsSync(cache)) cpSync(cache, join(home.dir, 'her-memory', 'embedding'), { recursive: true })
    await home.addPlugin('headless', inject('tarball'))
    await home.addPlugin('web', inject('tarball'))
    home.configurePlugin('headless', SETTINGS)
    home.configurePlugin('web', SETTINGS)

    web = await home.web()
    browser = await chromium.launch({ channel: process.env.HER_MEMORY_CHROME_CHANNEL ?? 'chrome', headless: true })
    page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1400, height: 1000 } })).newPage()
    await page.goto(web.url)
    await openMemoryPage(page)
  }, READY_TIMEOUT_MS)

  afterAll(async () => {
    await browser?.close()
    await web?.stop()
    await mock?.close()
    home?.dispose()
  })

  it('downloads and loads the model in the background, showing its state', async () => {
    const state = page.getByTestId('her-memory-local-state')
    await expect.poll(async () => await state.textContent(), { timeout: READY_TIMEOUT_MS, interval: 2000 }).toBe('模型已就绪')
    await expect.poll(() => existsSync(join(home.dir, 'her-memory', 'embedding', 'models', MODEL, '.complete'))).toBe(true)
  }, READY_TIMEOUT_MS)

  it('lists the catalog with the model in use', async () => {
    await page.getByRole('button', { name: '本地模型' }).click()
    const catalog = page.getByTestId('her-memory-models')
    await expect.poll(async () => await catalog.textContent()).toContain('EmbeddingGemma')
    expect(await catalog.textContent()).toContain('使用中')
  })

  it('embeds learned memories and recalls them by meaning', { timeout: 300_000 }, async () => {
    const first = await home.headless('我家的猫叫年糕，是只橘猫')
    await home.headless('它最近有点胖', first.sessionId)
    await home.headless('今天就先聊到这吧', first.sessionId)
    expect(home.query('SELECT 1 FROM memories')).toHaveLength(1)
    // The headless run may exit before its model loads; the Web server's maintenance pass embeds the memory.
    await expect.poll(vectors, { timeout: 150_000, interval: 2000 }).toBe(1)
    const fingerprint = home.query<{ fingerprint: string }>('SELECT fingerprint FROM memory_vectors')[0]!.fingerprint
    expect(fingerprint).toBe(`local|${MODEL}|512`)

    const start = mock.requests.length
    await home.headless('我家主子最近不吃饭')
    const chat = mock.requests.slice(start).find(request => !request.extraction && request.lastUser.includes('我家主子最近不吃饭'))
    expect(chat?.lastUser).toMatch(/<memory-recall>[\s\S]*用户养了一只叫年糕的橘猫[\s\S]*<\/memory-recall>/u)
  })
})
