/** Catalog of on-device embedding models the user can choose from. */

/** One file of a model repository. */
export interface ModelFile {
  /** Path inside the repository, also the path under the model directory. */
  readonly path: string
  /** Size in bytes. */
  readonly size: number
  /** SHA-256 of the content, for files the hosts store in LFS. */
  readonly sha256?: string
}

/** How token states become one sentence vector when the model has no pooled output. */
export type Pooling = 'cls' | 'mean'

/** One selectable model. */
export interface LocalModel {
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Repository on Hugging Face and ModelScope (same name on both). */
  readonly repo: string
  /** Weight file the session opens. */
  readonly onnx: string
  readonly files: readonly ModelFile[]
  /** Vector dimension. */
  readonly dims: number
  readonly pooling: Pooling
  /** Text put before a search query. */
  readonly queryPrefix: string
  /** Text put before a stored memory. */
  readonly documentPrefix: string
  /** Longest input in tokens; longer texts are cut. */
  readonly maxTokens: number
  /** Languages the model handles well. */
  readonly languages: 'zh' | 'multi'
  /** Relative recall quality, 1 (basic) to 3 (best), from `bench/eval.ts` with 10,000 distracting memories. */
  readonly quality: 1 | 2 | 3
  /** Relative speed, 1 (slow) to 3 (fast). */
  readonly speed: 1 | 2 | 3
  /** Memory the process gains with the model loaded and in use, in MB (measured by `bench/eval.ts`). */
  readonly memoryMB: number
}

const TOKENIZER = (size: number, sha256?: string): ModelFile => ({ path: 'tokenizer.json', size, ...(sha256 === undefined ? {} : { sha256 }) })
const TOKENIZER_CONFIG = (size: number): ModelFile => ({ path: 'tokenizer_config.json', size })

const GEMMA_REPO = 'onnx-community/embeddinggemma-300m-ONNX'
const GEMMA_TOKENIZER = [
  TOKENIZER(20_323_312, '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47'),
  TOKENIZER_CONFIG(1_156_830),
]
const GEMMA_COMMON = {
  repo: GEMMA_REPO,
  dims: 768,
  pooling: 'mean',
  queryPrefix: 'task: search result | query: ',
  documentPrefix: 'title: none | text: ',
  maxTokens: 512,
  languages: 'multi',
} as const

/** Every model offered, default first. */
export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    ...GEMMA_COMMON,
    id: 'embeddinggemma-q4',
    name: 'EmbeddingGemma 300M（4-bit）',
    onnx: 'onnx/model_q4.onnx',
    files: [
      ...GEMMA_TOKENIZER,
      { path: 'onnx/model_q4.onnx', size: 519_322, sha256: 'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043' },
      { path: 'onnx/model_q4.onnx_data', size: 196_725_760, sha256: '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02' },
    ],
    quality: 3,
    speed: 2,
    memoryMB: 500,
  },
  {
    ...GEMMA_COMMON,
    id: 'embeddinggemma-int8',
    name: 'EmbeddingGemma 300M（8-bit）',
    onnx: 'onnx/model_quantized.onnx',
    files: [
      ...GEMMA_TOKENIZER,
      { path: 'onnx/model_quantized.onnx', size: 567_874, sha256: '172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8' },
      { path: 'onnx/model_quantized.onnx_data', size: 308_890_624, sha256: '705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0' },
    ],
    quality: 3,
    speed: 1,
    memoryMB: 1700,
  },
  {
    id: 'bge-small-zh',
    name: 'BGE small 中文',
    repo: 'Xenova/bge-small-zh-v1.5',
    onnx: 'onnx/model_int8.onnx',
    files: [
      TOKENIZER(439_125),
      TOKENIZER_CONFIG(367),
      { path: 'onnx/model_int8.onnx', size: 23_903_394, sha256: 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5' },
    ],
    dims: 512,
    pooling: 'cls',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    documentPrefix: '',
    maxTokens: 512,
    languages: 'zh',
    quality: 1,
    speed: 3,
    memoryMB: 150,
  },
  {
    id: 'multilingual-e5-small',
    name: 'Multilingual E5 small',
    repo: 'Xenova/multilingual-e5-small',
    onnx: 'onnx/model_int8.onnx',
    files: [
      TOKENIZER(17_082_730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'),
      TOKENIZER_CONFIG(443),
      { path: 'onnx/model_int8.onnx', size: 118_054_593, sha256: '4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c' },
    ],
    dims: 384,
    pooling: 'mean',
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    maxTokens: 512,
    languages: 'multi',
    quality: 2,
    speed: 3,
    memoryMB: 650,
  },
  {
    id: 'bge-m3',
    name: 'BGE-M3',
    repo: 'Xenova/bge-m3',
    onnx: 'onnx/model_int8.onnx',
    files: [
      TOKENIZER(17_082_821, '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790'),
      TOKENIZER_CONFIG(1173),
      { path: 'onnx/model_int8.onnx', size: 568_456_694, sha256: 'a206e10e995aa2a833924bcd725ba5dd6c3425cd34bac3cf2b5677cd2a1c51d6' },
    ],
    dims: 1024,
    pooling: 'cls',
    queryPrefix: '',
    documentPrefix: '',
    maxTokens: 512,
    languages: 'multi',
    quality: 3,
    speed: 2,
    memoryMB: 1700,
  },
]

/** Model used when the settings name none. */
export const DEFAULT_LOCAL_MODEL = 'embeddinggemma-q4'

/**
 * Look a model up.
 * @param id - model id.
 * @returns the model, or `undefined` for an unknown id.
 */
export const localModel = (id: string): LocalModel | undefined => LOCAL_MODELS.find(model => model.id === id)

/**
 * Total download size of a model, excluding the shared runtime.
 * @param model - the model.
 * @returns bytes.
 */
export const modelBytes = (model: LocalModel): number => model.files.reduce((sum, file) => sum + file.size, 0)
