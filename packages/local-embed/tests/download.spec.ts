import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DownloadError, downloadFile, modelUrls, npmUrls, tryLock } from '../src/download.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hm-dl-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const CONTENT = Buffer.from('0123456789abcdefghij')
const sha256 = createHash('sha256').update(CONTENT).digest('hex')

/** A fetch that serves CONTENT and honors Range; hosts in `broken` fail to connect. */
const serving = (calls: string[], broken = new Set<string>()): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const range = new Headers(init?.headers).get('range')
  calls.push(range === null ? url : `${url} ${range}`)
  if (broken.has(new URL(url).host)) throw new TypeError('fetch failed')
  if (range !== null) {
    const start = Number(/bytes=(\d+)-/u.exec(range)![1])
    return new Response(CONTENT.subarray(start), { status: 206 })
  }
  return new Response(CONTENT, { status: 200 })
}) as typeof fetch

describe('downloadFile', () => {
  it('falls back to the next mirror and verifies the hash', async () => {
    const calls: string[] = []
    const dest = join(dir, 'a', 'model.onnx')
    let bytes = 0
    await downloadFile(['https://one.test/x', 'https://two.test/x'], dest, { size: CONTENT.length, sha256, fetchImpl: serving(calls, new Set(['one.test'])), onBytes: (n) => { bytes += n } })
    expect(readFileSync(dest)).toEqual(CONTENT)
    expect(calls).toEqual(['https://one.test/x', 'https://two.test/x'])
    expect(bytes).toBe(CONTENT.length)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('resumes a partial file with a range request', async () => {
    const calls: string[] = []
    const dest = join(dir, 'model.onnx')
    writeFileSync(`${dest}.part`, CONTENT.subarray(0, 8))
    await downloadFile(['https://one.test/x'], dest, { size: CONTENT.length, sha256, fetchImpl: serving(calls) })
    expect(calls).toEqual(['https://one.test/x bytes=8-'])
    expect(readFileSync(dest)).toEqual(CONTENT)
  })

  it('discards content with the wrong hash and reports every mirror', async () => {
    const dest = join(dir, 'model.onnx')
    const error = await downloadFile(['https://one.test/x'], dest, { sha256: '00'.repeat(32), fetchImpl: serving([]) }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DownloadError)
    expect(String(error)).toContain('one.test: SHA-256 mismatch')
    expect(existsSync(dest) || existsSync(`${dest}.part`)).toBe(false)
  })

  it('keeps a finished file without fetching', async () => {
    const calls: string[] = []
    const dest = join(dir, 'model.onnx')
    writeFileSync(dest, CONTENT)
    await downloadFile(['https://one.test/x'], dest, { size: CONTENT.length, fetchImpl: serving(calls) })
    expect(calls).toEqual([])
  })

  it('checks npm integrity', async () => {
    const integrity = `sha512-${createHash('sha512').update(CONTENT).digest('base64')}`
    await downloadFile(['https://one.test/x'], join(dir, 'p.tgz'), { integrity, fetchImpl: serving([]) })
    await expect(downloadFile(['https://one.test/x'], join(dir, 'q.tgz'), { integrity: 'sha512-AAAA', fetchImpl: serving([]) })).rejects.toThrow(/integrity mismatch/u)
  })
})

describe('mirrors', () => {
  it('orders Hugging Face before ModelScope on auto', () => {
    expect(modelUrls('Xenova/bge-m3', 'onnx/model_int8.onnx', 'auto')).toEqual([
      'https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx',
      'https://www.modelscope.cn/models/Xenova/bge-m3/resolve/master/onnx/model_int8.onnx',
    ])
    expect(modelUrls('a/b', 'f', 'modelscope')).toHaveLength(1)
    expect(npmUrls('onnxruntime-node', '1.31.1', 'modelscope')).toEqual(['https://registry.npmmirror.com/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz'])
  })
})

describe('tryLock', () => {
  it('lets one holder in at a time', () => {
    const path = join(dir, '.lock')
    const first = tryLock(path)
    expect(first).toBeDefined()
    expect(tryLock(path)).toBeUndefined()
    first!.release()
    const second = tryLock(path)
    expect(second).toBeDefined()
    second!.release()
  })
})
