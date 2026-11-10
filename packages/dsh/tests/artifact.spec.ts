/**
 * Checks the built lib/ against what DSH loads. Run `pnpm build` first; the
 * suite is skipped when lib/ is absent.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const lib = new URL('../lib/', import.meta.url)
const built = existsSync(new URL('client.js', lib)) && existsSync(new URL('index.js', lib))
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])

describe.skipIf(!built)('built artifacts', () => {
  it('wraps the client bundle in the DSH module loader call', () => {
    const code = readFileSync(new URL('client.js', lib), 'utf8')
    expect(code.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(code).toContain('id: "@her-os/dsh-memory"')
    expect(code).toMatch(/return module\.exports;\s*\}\s*\}\);/)
  })

  it('requires only platform modules from the client bundle', () => {
    const code = readFileSync(new URL('client.js', lib), 'utf8')
    const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
    expect(required.filter(name => !PLATFORM_MODULES.has(name!))).toEqual([])
  })

  it('imports only Node builtins and declared DSH peers from the host bundle', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { peerDependencies: Record<string, string> }
    const code = readFileSync(new URL('index.js', lib), 'utf8')
    const imported = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]!)
    expect(imported.filter(name => !name.startsWith('node:') && !(name in manifest.peerDependencies))).toEqual([])
    const mod = await import(new URL('index.js', lib).href) as Record<string, unknown>
    expect(Object.keys(mod).sort()).toEqual(['Config', 'HerMemoryRemote', 'MAINTENANCE_INTERVAL_MS', 'PROMPT_SECTION', 'apply', 'embedderOf', 'name'])
  })

  it('publishes the herMemory Remote for both faces', async () => {
    const host = await import(new URL('typert.host.js', lib).href) as { TYPERT: { package: string; face: string; invocations: readonly { endpoint?: string; method?: string }[] } }
    expect(host.TYPERT.package).toBe('@her-os/dsh-memory')
    expect(host.TYPERT.face).toBe('host')
    expect(JSON.stringify(host.TYPERT.invocations)).toContain('herMemory/call')
    const { validateTypertManifest } = await import('@deepseek-ai/dsh-typert-loader')
    expect(() => validateTypertManifest('@her-os/dsh-memory', host.TYPERT)).not.toThrow()
    const client = readFileSync(new URL('typert.remote-client.js', lib), 'utf8')
    expect([...client.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]).filter(name => name !== 'zod' && !name!.startsWith('@deepseek-ai/'))).toEqual([])
  })
})
