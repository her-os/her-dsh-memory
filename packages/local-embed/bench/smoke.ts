/**
 * Download one model into a cache root and embed a few sentences.
 * Usage: node packages/local-embed/bench/smoke.ts <cache-root> [model-id] [source]
 */

import { type DownloadSource, LOCAL_MODELS, LocalEmbedder, localModel } from '../src/index.ts'

const [root, id = LOCAL_MODELS[0]!.id, source = 'auto'] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: smoke.ts <cache-root> [model-id] [source]')
const model = localModel(id)
if (model === undefined) throw new Error(`unknown model ${id}`)
const embedder = new LocalEmbedder({ model, root, source: source as DownloadSource, logger: console })
const started = performance.now()
const ticker = setInterval(() => { const s = embedder.status(); console.log(s.state, `${(s.received / 1e6).toFixed(1)}/${(s.total / 1e6).toFixed(1)} MB`) }, 2000)
await embedder.prepare()
clearInterval(ticker)
console.log('prepared in', Math.round(performance.now() - started), 'ms', embedder.status())
const docs = ['用户养了一只叫年糕的橘猫', '用户下周三有一场面试', '用户对花生过敏', '用户最近在学吉他', '用户搬到了杭州']
const vectors = await embedder.embed(docs, undefined, 'document')
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, v, i) => sum + v * b[i]!, 0)
for (const query of ['我家主子最近不吃饭', '找工作的事有点慌', '能吃坚果吗', '弹琴手指疼', '新城市生活怎么样']) {
  const t = performance.now()
  const [q] = await embedder.embed([query], undefined, 'query')
  const ranked = docs.map((d, i) => [dot(q!, vectors[i]!), d] as const).sort((a, b) => b[0] - a[0])
  console.log(query, '→', ranked[0]![1], ranked[0]![0].toFixed(3), `${(performance.now() - t).toFixed(0)} ms`)
}
console.log('rss MB', Math.round(process.memoryUsage().rss / 1e6))
await embedder.dispose()
