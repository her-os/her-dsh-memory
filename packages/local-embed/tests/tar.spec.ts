import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runtimeSelector } from '../src/runtime.ts'
import { extractTgz, TarReader } from '../src/tar.ts'

/** One ustar header block. */
function header(name: string, size: number, flag: string, prefix: string): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write(flag, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  block.write(prefix, 345, 155, 'utf8')
  return block
}

const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
const entry = (name: string, data: string, flag = '0', prefix = ''): Buffer => {
  const body = Buffer.from(data)
  return Buffer.concat([header(name, body.length, flag, prefix), pad(body)])
}
const pax = (path: string): Buffer => {
  const record = ` path=${path}\n`
  let length = record.length + 2
  if (String(length).length + record.length !== length) length = record.length + String(record.length + 3).length
  return entry('PaxHeader', `${length}${record}`, 'x')
}
const archive = (...parts: Buffer[]): Buffer => Buffer.concat([...parts, Buffer.alloc(1024)])

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hm-tar-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('TarReader', () => {
  it('reads files across chunk boundaries, ustar prefixes and pax paths', () => {
    const long = `package/${'d'.repeat(120)}/file.js`
    const tar = archive(
      entry('package/a.txt', 'hello'),
      entry('package/dir', '', '5'),
      entry('b.txt', 'x'.repeat(700), '0', 'package/deep'),
      pax(long),
      entry('short-name', 'long'),
      entry('package/empty', ''),
    )
    const seen: Record<string, string> = {}
    const reader = new TarReader((item) => {
      if (item.type !== 'file') return undefined
      const chunks: Buffer[] = []
      return { write: (c) => { chunks.push(Buffer.from(c)) }, end: () => { seen[item.path] = Buffer.concat(chunks).toString() } }
    })
    for (let i = 0; i < tar.length; i += 37) reader.push(tar.subarray(i, i + 37))
    expect(seen).toEqual({ 'package/a.txt': 'hello', 'package/deep/b.txt': 'x'.repeat(700), [long]: 'long', 'package/empty': '' })
  })
})

describe('extractTgz', () => {
  it('writes the selected files only and refuses paths outside the destination', async () => {
    const file = join(dir, 'p.tgz')
    writeFileSync(file, gzipSync(archive(entry('package/package.json', '{}'), entry('package/README.md', 'no'))))
    const out = join(dir, 'out')
    const written = await extractTgz(file, out, path => path.endsWith('.json') ? `node_modules/x/${path.slice(8)}` : undefined)
    expect(written).toEqual(['node_modules/x/package.json'])
    expect(readFileSync(join(out, 'node_modules/x/package.json'), 'utf8')).toBe('{}')
    await expect(extractTgz(file, out, () => '../escape')).rejects.toThrow(/escapes/u)
  })
})

describe('runtimeSelector', () => {
  it('keeps the JavaScript, nested manifests and this platform\'s binaries, without the versioned duplicate', () => {
    const select = runtimeSelector('onnxruntime-node', 'darwin', 'arm64')
    expect(select('package/package.json')).toBe('node_modules/onnxruntime-node/package.json')
    expect(select('package/dist/index.js')).toBe('node_modules/onnxruntime-node/dist/index.js')
    expect(select('package/dist/index.js.map')).toBeUndefined()
    expect(select('package/dist/index.d.ts')).toBeUndefined()
    expect(select('package/bin/napi-v6/darwin/arm64/onnxruntime_binding.node')).toBe('node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node')
    expect(select('package/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib')).toBeDefined()
    expect(select('package/bin/napi-v6/darwin/arm64/libonnxruntime.1.31.1.dylib')).toBeUndefined()
    expect(select('package/bin/napi-v6/win32/x64/onnxruntime.dll')).toBeUndefined()
    expect(select('package/script/install.js')).toBeUndefined()
    const common = runtimeSelector('onnxruntime-common', 'darwin', 'arm64')
    expect(common('package/dist/cjs/package.json')).toBe('node_modules/onnxruntime-common/dist/cjs/package.json')
    expect(common('package/bin/napi-v6/darwin/arm64/x.node')).toBeUndefined()
  })
})
