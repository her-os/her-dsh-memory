/** Minimal streaming reader of gzip'd tar archives (npm tarballs): regular files only. */

import { closeSync, createReadStream, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { createGunzip } from 'node:zlib'

const BLOCK = 512

/** One archive entry header. */
export interface TarEntry {
  /** Path inside the archive, `/`-separated. */
  readonly path: string
  readonly size: number
  /** `file`, `directory`, or `other` (links, devices, metadata). */
  readonly type: 'file' | 'directory' | 'other'
}

/** Receiver of one entry's content. */
export interface TarSink {
  write(chunk: Uint8Array): void
  end(): void
}

const text = (block: Uint8Array, start: number, length: number): string => {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

const octal = (block: Uint8Array, start: number, length: number): number => {
  const value = text(block, start, length).trim()
  return value === '' ? 0 : Number.parseInt(value, 8)
}

/** The `path` record of a pax extended header. */
const paxPath = (data: Buffer): string | undefined => {
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (record.slice(0, equals) === 'path') return record.slice(equals + 1)
    offset += length
  }
  return undefined
}

/**
 * Parse tar data pushed in arbitrary chunks.
 * `onEntry` returns a sink for the entry's bytes, or `undefined` to skip them.
 */
export class TarReader {
  private pending = Buffer.alloc(0)
  private entry: { remaining: number; padding: number; sink: ((chunk: Uint8Array) => void) | undefined; end: (() => void) | undefined } | undefined
  private nextPath: string | undefined
  private ended = false
  private readonly onEntry: (entry: TarEntry) => TarSink | undefined

  /**
   * @param onEntry - receives each header; returns the content sink and an end callback, or `undefined`.
   */
  constructor(onEntry: (entry: TarEntry) => TarSink | undefined) {
    this.onEntry = onEntry
  }

  /**
   * Feed more archive bytes.
   * @param chunk - the next bytes.
   */
  push(chunk: Uint8Array): void {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.ended) return
      if (this.entry !== undefined) {
        const { entry } = this
        if (entry.remaining > 0) {
          if (this.pending.length === 0) return
          const take = Math.min(entry.remaining, this.pending.length)
          entry.sink?.(this.pending.subarray(0, take))
          entry.remaining -= take
          this.pending = this.pending.subarray(take)
          if (entry.remaining > 0) return
        }
        if (this.pending.length < entry.padding) return
        this.pending = this.pending.subarray(entry.padding)
        this.entry = undefined
        entry.end?.()
        continue
      }
      if (this.pending.length < BLOCK) return
      const header = this.pending.subarray(0, BLOCK)
      this.pending = this.pending.subarray(BLOCK)
      if (header.every(byte => byte === 0)) { this.ended = true; return }
      const size = octal(header, 124, 12)
      const flag = String.fromCharCode(header[156] ?? 0x30)
      const padding = (BLOCK - (size % BLOCK)) % BLOCK
      if (flag === 'x' || flag === 'L') {
        // A pax extended header or GNU long name describes the next entry.
        const meta: Buffer[] = []
        const end = (): void => {
          const data = Buffer.concat(meta)
          this.nextPath = (flag === 'x' ? paxPath(data) : data.toString('utf8').replace(/\0+$/u, '')) ?? this.nextPath
        }
        this.entry = { remaining: size, padding, sink: (data) => { meta.push(Buffer.from(data)) }, end }
        continue
      }
      if (flag === 'g') { this.entry = { remaining: size, padding, sink: undefined, end: undefined }; continue }
      const prefix = text(header, 345, 155)
      const name = text(header, 0, 100)
      const path = this.nextPath ?? (prefix === '' ? name : `${prefix}/${name}`)
      this.nextPath = undefined
      const type = flag === '0' || flag === '\0' || flag === '7' ? 'file' : flag === '5' ? 'directory' : 'other'
      const sink = this.onEntry({ path, size, type })
      this.entry = { remaining: size, padding, sink: sink?.write, end: sink?.end }
    }
  }
}

/**
 * Extract selected regular files of a `.tgz` into a directory.
 * @param archive - path of the gzip'd tar.
 * @param destination - directory to write into.
 * @param select - maps an archive path to a relative output path, or `undefined` to skip it.
 * @returns the relative output paths written.
 * @throws when an output path would leave `destination`.
 */
export async function extractTgz(archive: string, destination: string, select: (path: string) => string | undefined): Promise<string[]> {
  const written: string[] = []
  const root = normalize(destination + sep)
  const reader = new TarReader((entry) => {
    if (entry.type !== 'file') return undefined
    const relative = select(entry.path)
    if (relative === undefined) return undefined
    const target = normalize(join(destination, relative))
    if (!target.startsWith(root)) throw new Error(`archive entry escapes the destination: ${entry.path}`)
    mkdirSync(dirname(target), { recursive: true })
    const fd = openSync(target, 'w')
    written.push(relative)
    return { write: (chunk) => { writeSync(fd, chunk) }, end: () => { closeSync(fd) } }
  })
  const stream = createReadStream(archive).pipe(createGunzip())
  for await (const chunk of stream as AsyncIterable<Buffer>) reader.push(chunk)
  return written
}
