/**
 * Drives a real DSH CLI against a throwaway `DSH_HOME`: installs the packed
 * plugin the way users do (`dsh plugin add`), runs headless turns, serves the
 * Web UI, and reads the plugin's database.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** DSH release the tests run against; keep in step with the plugin's devDependencies. */
export const DSH_VERSION = '0.2.1-rc.2'

/** Longest wait for one headless turn. */
const TURN_TIMEOUT_MS = 120_000

/**
 * Command that starts DSH: `DSH_BIN` when set (for example a desktop build), else the pinned npm CLI.
 * @returns executable and leading arguments.
 */
export function dshCommand(): [string, ...string[]] {
  const override = process.env.DSH_BIN?.trim()
  if (override !== undefined && override !== '') return [override]
  const require = createRequire(import.meta.url)
  return [process.execPath, join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')]
}

const PROXY_VARS = ['ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']

/** Event of `dsh headless --json`. */
export type RunEvent = Record<string, unknown> & { type: string }

/** One finished headless turn. */
export interface Turn {
  readonly sessionId: string
  readonly final: string
  readonly events: readonly RunEvent[]
}

/** A running `dsh web`. */
export interface WebServer {
  /** Tokenized URL of the UI. */
  readonly url: string
  stop(): Promise<void>
}

const exited = (child: ChildProcess): Promise<number | null> =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise(resolve => child.once('exit', code => { resolve(code) }))

/** One throwaway DSH home. */
export class DshHome {
  readonly dir: string
  readonly workspace: string
  private readonly env: NodeJS.ProcessEnv

  /**
   * @param modelBaseURL - base URL of the model endpoint, e.g. the mock's.
   */
  constructor(modelBaseURL: string) {
    this.dir = mkdtempSync(join(tmpdir(), 'her-memory-e2e-'))
    this.workspace = join(this.dir, 'workspace')
    mkdirSync(this.workspace)
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of PROXY_VARS) delete env[name]
    for (const name of Object.keys(env)) if (name.startsWith('DSH_') && name !== 'DSH_BIN') delete env[name]
    this.env = {
      ...env,
      DSH_HOME: this.dir,
      DEEPSEEK_BASE_URL: modelBaseURL,
      DEEPSEEK_API_KEY: 'mock-key',
      NO_PROXY: '127.0.0.1,localhost',
    }
  }

  /** Database file the plugin writes by default. */
  get dbPath(): string { return join(this.dir, 'her-memory', 'memory.db') }

  private run(args: string[], timeoutMs = TURN_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const [bin, ...lead] = dshCommand()
    const child = spawn(bin, [...lead, ...args], { cwd: this.workspace, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    return exited(child).then((code) => {
      clearTimeout(timer)
      return { code, stdout, stderr }
    })
  }

  /**
   * Install a plugin package into a profile with `dsh plugin add`.
   * @param profile - profile name, e.g. `headless` or `web`.
   * @param spec - package spec or tarball path.
   */
  async addPlugin(profile: string, spec: string): Promise<void> {
    const result = await this.run(['plugin', '--profile', profile, 'add', spec], 300_000)
    if (result.code !== 0) throw new Error(`dsh plugin add failed (${result.code}):\n${result.stderr}${result.stdout}`)
  }

  /**
   * Override the plugin's settings in a profile's patch layer.
   * @param profile - profile name.
   * @param config - settings merged over the defaults, as JSON (a YAML subset).
   */
  configurePlugin(profile: string, config: object): void {
    writeFileSync(join(this.dir, 'profiles', profile, 'cordis.patch.yml'), `- id: her-memory\n  config: ${JSON.stringify(config)}\n`)
  }

  /**
   * Answer one task with the headless profile.
   * @param task - the user message.
   * @param sessionId - continue this session instead of starting one.
   * @returns the session, final answer and run events.
   */
  async headless(task: string, sessionId?: string): Promise<Turn> {
    const result = await this.run(['headless', '--json', ...(sessionId === undefined ? [] : ['--session-id', sessionId]), task])
    const events = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as RunEvent)
    const session = events.find(event => event.type === 'session')
    const final = events.find(event => event.type === 'final')
    if (result.code !== 0 || session === undefined || final === undefined) {
      throw new Error(`dsh headless failed (${result.code}):\n${result.stderr.slice(-3000)}\n${result.stdout.slice(-2000)}`)
    }
    return { sessionId: String(session.sessionId), final: String(final.text), events }
  }

  /**
   * Serve the Web UI on a free port.
   * @returns the URL and a stopper.
   */
  async web(): Promise<WebServer> {
    const [bin, ...lead] = dshCommand()
    const child = spawn(bin, [...lead, 'web', '--no-open', '--port', '0'], { cwd: this.workspace, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`dsh web did not start:\n${output.slice(-3000)}`)) }, 120_000)
      const scan = (chunk: Buffer): void => {
        output += chunk.toString()
        const match = /dsh web: (http\S+token=\S+)/u.exec(output)
        if (match !== null) { clearTimeout(timer); resolve(match[1]!) }
      }
      child.stdout.on('data', scan)
      child.stderr.on('data', scan)
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh web exited (${code}):\n${output.slice(-3000)}`)) })
    })
    return {
      url,
      async stop() {
        child.kill('SIGTERM')
        const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
        await exited(child)
        clearTimeout(timer)
      },
    }
  }

  /**
   * Read rows from the plugin database.
   * @param sql - a SELECT statement.
   * @param params - bound parameters.
   * @returns the rows.
   */
  query<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    const db = new DatabaseSync(this.dbPath, { readOnly: true })
    try { return db.prepare(sql).all(...params) as T[] } finally { db.close() }
  }

  /** Remove the home. */
  dispose(): void { rmSync(this.dir, { recursive: true, force: true }) }
}
