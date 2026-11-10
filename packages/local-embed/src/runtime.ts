/**
 * The ONNX runtime for Node, fetched on first use. The npm package carries
 * binaries for every platform and a postinstall script; only the current
 * platform's binaries and the JavaScript are kept, so nothing runs at install.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { type DownloadSource, downloadFile, npmUrls } from './download.ts'
import { extractTgz } from './tar.ts'

/** onnxruntime-node release used, with its npm integrity hashes. */
export const ORT_VERSION = '1.31.1'
const PACKAGES = [
  { name: 'onnxruntime-node', integrity: 'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==', size: 115_391_311 },
  { name: 'onnxruntime-common', integrity: 'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==', size: 72_322 },
] as const

/** Approximate bytes downloaded for the runtime. */
export const RUNTIME_DOWNLOAD_BYTES = PACKAGES.reduce((sum, item) => sum + item.size, 0)

/** Platforms with prebuilt binaries in {@link ORT_VERSION}. */
const SUPPORTED = new Set(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'])

/**
 * Whether the runtime has binaries for a platform.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns `true` when supported.
 */
export const runtimeSupported = (platform: string = process.platform, arch: string = process.arch): boolean => SUPPORTED.has(`${platform}-${arch}`)

/** The part of onnxruntime-node this package uses. */
export interface OrtTensor {
  readonly data: unknown
  readonly dims: readonly number[]
}

/** An open model. */
export interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  release(): Promise<void>
}

/** Session options this package sets. */
export interface OrtSessionOptions {
  intraOpNumThreads?: number
  interOpNumThreads?: number
  executionProviders?: string[]
  graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all'
  enableCpuMemArena?: boolean
}

/** The onnxruntime-node module. */
export interface OrtModule {
  InferenceSession: { create(path: string, options?: OrtSessionOptions): Promise<OrtSession> }
  Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => OrtTensor
}

/**
 * Archive paths kept from each package.
 * @param name - package name.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the selector for {@link extractTgz}.
 */
export function runtimeSelector(name: string, platform: string, arch: string): (path: string) => string | undefined {
  const binaries = `package/bin/napi-v6/${platform}/${arch}/`
  return (path) => {
    if (!path.startsWith('package/')) return undefined
    const keep = path === 'package/package.json'
      || /^package\/dist\/.+\.js$/u.test(path)
      // Nested manifests set the module type of dist/cjs and dist/esm.
      || /^package\/dist\/(.+\/)?package\.json$/u.test(path)
      || (name === 'onnxruntime-node' && path.startsWith(binaries) && !path.slice(binaries.length).includes(`.${ORT_VERSION}.`))
    return keep ? `node_modules/${name}/${path.slice('package/'.length)}` : undefined
  }
}

/** Progress and cancellation of {@link ensureRuntime}. */
export interface RuntimeOptions {
  readonly source: DownloadSource
  readonly signal?: AbortSignal
  readonly onBytes?: (bytes: number) => void
  readonly fetchImpl?: typeof fetch
}

/**
 * Directory the runtime of this platform lives in.
 * @param root - shared cache root.
 * @returns the directory.
 */
export const runtimeDir = (root: string): string => join(root, 'runtime', `onnxruntime-${ORT_VERSION}-${process.platform}-${process.arch}`)

const MARKER = '.complete'
/** Bump when {@link runtimeSelector} keeps different files, so older extractions are redone. */
const LAYOUT = 2
const markerText = JSON.stringify({ version: ORT_VERSION, layout: LAYOUT })

const markerCurrent = (dir: string): boolean => {
  try { return readFileSync(join(dir, MARKER), 'utf8') === markerText } catch { return false }
}

/**
 * Whether the runtime is already in place.
 * @param root - shared cache root.
 * @returns `true` when extracted.
 */
export const runtimeReady = (root: string): boolean => markerCurrent(runtimeDir(root))

/**
 * Download and unpack the runtime unless already present.
 * @param root - shared cache root.
 * @param options - mirror preference, cancellation, progress.
 * @returns the runtime directory.
 */
export async function ensureRuntime(root: string, options: RuntimeOptions): Promise<string> {
  const dir = runtimeDir(root)
  if (markerCurrent(dir)) return dir
  const archives = join(root, 'runtime', 'downloads')
  mkdirSync(archives, { recursive: true })
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
  for (const item of PACKAGES) {
    const archive = join(archives, `${item.name}-${ORT_VERSION}.tgz`)
    await downloadFile(npmUrls(item.name, ORT_VERSION, options.source), archive, {
      integrity: item.integrity,
      size: item.size,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onBytes === undefined ? {} : { onBytes: options.onBytes }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })
    const written = await extractTgz(archive, dir, runtimeSelector(item.name, process.platform, process.arch))
    if (written.length === 0) throw new Error(`${item.name} ${ORT_VERSION} has no files for ${process.platform}-${process.arch}`)
  }
  writeFileSync(join(dir, MARKER), markerText)
  rmSync(archives, { recursive: true, force: true })
  return dir
}

/**
 * Load the runtime from its directory.
 * @param dir - directory returned by {@link ensureRuntime}.
 * @returns the module.
 */
export function loadRuntime(dir: string): OrtModule {
  const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8')) as { version?: string }
  if (manifest.version !== ORT_VERSION) throw new Error(`unexpected onnxruntime-node ${manifest.version ?? '?'} in ${dir}`)
  return createRequire(join(dir, 'index.js'))('onnxruntime-node') as OrtModule
}
