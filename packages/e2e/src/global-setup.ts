/**
 * Build and pack the plugin once per e2e run, so every test installs the
 * same tarball users would get.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Absolute path of the packed `@her-os/dsh-memory` tarball. */
    tarball: string
  }
}

const PLUGIN_DIR = resolve(import.meta.dirname, '../../dsh')

export default function setup(project: TestProject): () => void {
  const out = mkdtempSync(join(tmpdir(), 'her-memory-pack-'))
  const pnpm = process.env.npm_execpath?.includes('pnpm') === true ? [process.execPath, process.env.npm_execpath] : ['pnpm']
  const run = (...args: string[]): void => { execFileSync(pnpm[0]!, [...pnpm.slice(1), ...args], { cwd: PLUGIN_DIR, stdio: 'inherit' }) }
  if (process.env.HER_MEMORY_SKIP_BUILD !== '1') run('run', 'build')
  run('pack', '--pack-destination', out)
  const tarball = readdirSync(out).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack wrote no tarball to ${out}`)
  project.provide('tarball', join(out, tarball))
  return () => { rmSync(out, { recursive: true, force: true }) }
}
