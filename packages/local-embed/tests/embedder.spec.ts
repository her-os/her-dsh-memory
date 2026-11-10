import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbedderNotReadyError } from '@her-os/memory-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalEmbedder, modelDir, poolOutputs, truncateIds } from '../src/embedder.ts'
import { LOCAL_MODELS, localModel, type LocalModel } from '../src/models.ts'
import type { OrtModule, OrtSession, OrtTensor } from '../src/runtime.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hm-local-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const tensor = (data: unknown, dims: readonly number[]): OrtTensor => ({ data, dims })

/** Mark runtime and model as downloaded, the way a finished download does. */
function installed(model: LocalModel): void {
  const runtime = join(root, 'runtime', `onnxruntime-1.31.1-${process.platform}-${process.arch}`)
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, '.complete'), JSON.stringify({ version: '1.31.1', layout: 2 }))
  mkdirSync(modelDir(root, model.id), { recursive: true })
  writeFileSync(join(modelDir(root, model.id), '.complete'), '{}')
}

/** A fake runtime whose model returns a 3-dim pooled vector from the token count, recording each batch. */
function fakeRuntime(batches: { inputs: string[]; ids: bigint[] }[]): OrtModule {
  const session: OrtSession = {
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['sentence_embedding'],
    async run(feeds) {
      const [batch, length] = feeds.input_ids!.dims as [number, number]
      batches.push({ inputs: Object.keys(feeds), ids: [...(feeds.input_ids!.data as BigInt64Array)] })
      const mask = feeds.attention_mask!.data as BigInt64Array
      const out = new Float32Array(batch * 3)
      for (let row = 0; row < batch; row++) {
        let count = 0
        for (let j = 0; j < length; j++) count += Number(mask[row * length + j])
        out.set([count, 1, 0], row * 3)
      }
      return { sentence_embedding: tensor(out, [batch, 3]) }
    },
    async release() {},
  }
  return {
    InferenceSession: { create: async () => session },
    Tensor: function Tensor(this: Record<string, unknown>, type: string, data: BigInt64Array, dims: readonly number[]) { this.type = type; this.data = data; this.dims = dims } as unknown as OrtModule['Tensor'],
  }
}

/** Tokenizer that maps each character to its code point, with ids 1 and 2 around it. */
const charTokenizer = { encode: (text: string) => ({ ids: [1, ...[...text].map(c => c.codePointAt(0)!), 2] }) }

describe('LocalEmbedder', () => {
  it('prefixes queries and documents per model and feeds token type ids when the model takes them', async () => {
    const model = localModel('multilingual-e5-small')!
    installed(model)
    const batches: { inputs: string[]; ids: bigint[] }[] = []
    let ready = 0
    const embedder = new LocalEmbedder({ model, root, source: 'auto', runtime: async () => fakeRuntime(batches), tokenizer: () => charTokenizer, onReady: () => { ready++ } })
    const [query] = await embedder.embed(['猫'], undefined, 'query')
    await embedder.embed(['猫', '橘猫'], undefined, 'document')
    expect(ready).toBe(1)
    expect(embedder.status().state).toBe('ready')
    const text = (ids: bigint[]): string => String.fromCodePoint(...ids.filter(id => id > 2n).map(Number))
    expect(text(batches[0]!.ids)).toBe('query: 猫')
    expect(batches[0]!.inputs).toContain('token_type_ids')
    // Padded to the longer document; padding is masked out of the result.
    expect(batches[1]!.ids).toHaveLength(2 * ('passage: 橘猫'.length + 2))
    expect(Math.hypot(...query!)).toBeCloseTo(1)
    expect(embedder.fingerprint()).toBe('local|multilingual-e5-small|384')
    await embedder.dispose()
  })

  it('reports not ready while the files are missing and starts the download', async () => {
    const model = localModel('bge-small-zh')!
    let fetches = 0
    const failing = (async () => { fetches++; throw new TypeError('offline') }) as unknown as typeof fetch
    const embedder = new LocalEmbedder({ model, root, source: 'modelscope', fetchImpl: failing })
    await expect(embedder.embed(['猫'])).rejects.toBeInstanceOf(EmbedderNotReadyError)
    await embedder.prepare()
    expect(fetches).toBeGreaterThan(0)
    const status = embedder.status()
    expect(status.state).toBe('error')
    expect(status.error).toContain('offline')
    expect(status.downloaded).toBe(false)
    await expect(embedder.embed(['猫'])).rejects.toThrow(/offline/u)
    await embedder.dispose()
  })

  it('reloads after an idle unload', async () => {
    const model = LOCAL_MODELS[0]!
    installed(model)
    const batches: { inputs: string[]; ids: bigint[] }[] = []
    let ready = 0
    const embedder = new LocalEmbedder({ model, root, source: 'auto', idleUnloadMs: 20, runtime: async () => fakeRuntime(batches), tokenizer: () => charTokenizer, onReady: () => { ready++ } })
    await embedder.embed(['a'])
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(embedder.status().state).toBe('idle')
    await embedder.embed(['b'])
    expect(ready).toBe(2)
    await embedder.dispose()
  })

  it('refuses on a platform without runtime binaries', async () => {
    const embedder = new LocalEmbedder({ model: LOCAL_MODELS[0]!, root, source: 'auto', platform: 'darwin', arch: 'x64' })
    expect(embedder.status().state).toBe('unsupported')
    await expect(embedder.embed(['a'])).rejects.toThrow(/darwin-x64/u)
  })
})

describe('pooling', () => {
  it('takes CLS or the masked mean, then normalizes', () => {
    // batch 1, length 3, dims 2; the third token is padding.
    const hidden = tensor(new Float32Array([3, 0, 0, 4, 100, 100]), [1, 3, 2])
    const mask = new BigInt64Array([1n, 1n, 0n])
    expect([...poolOutputs({ last_hidden_state: hidden }, mask, 1, 3, 'cls')[0]!]).toEqual([1, 0])
    const mean = poolOutputs({ last_hidden_state: hidden }, mask, 1, 3, 'mean')[0]!
    expect(mean[0]).toBeCloseTo(0.6)
    expect(mean[1]).toBeCloseTo(0.8)
  })

  it('cuts long inputs but keeps the closing token', () => {
    expect(truncateIds([1, 5, 6, 7, 2], 4)).toEqual([1, 5, 6, 2])
    expect(truncateIds([1, 5, 2], 4)).toEqual([1, 5, 2])
  })
})

describe('catalog', () => {
  it('lists the default first, each with an onnx file it downloads', () => {
    expect(LOCAL_MODELS[0]!.id).toBe('embeddinggemma-q4')
    for (const model of LOCAL_MODELS) {
      expect(model.files.map(file => file.path)).toContain(model.onnx)
      expect(model.files.map(file => file.path)).toEqual(expect.arrayContaining(['tokenizer.json', 'tokenizer_config.json']))
      if (model.onnx.endsWith('_q4.onnx') || model.repo.includes('gemma')) expect(model.files.some(file => file.path === `${model.onnx}_data`)).toBe(true)
    }
  })
})
