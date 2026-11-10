/**
 * Two outputs beside each other in lib/:
 * - index.js: the Host plugin, ESM for Node; DSH peers stay imports, workspace
 *   code and small helpers are inlined.
 * - client.js: the browser half in the DSH client module format. The file calls
 *   `window.__ModuleLoader__.load({ id, factory })`, and the factory resolves
 *   shared modules through the injected `require`. Only the DSH page's
 *   platform modules may stay external; everything else is inlined. This
 *   mirrors `clientBundle` in DSH's packages/client/tsdown.client.ts, which is
 *   not published.
 */

import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string }

/** Module-table rows every DSH page provides (packages/client/web/src/platform.ts). */
const PLATFORM_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const HOST_PEERS = /^@deepseek-ai\/(?:cordis|schemastery)(?:\/|$)/
const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    name: 'host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: {
      onlyBundle: false,
      neverBundle: (specifier: string) => HOST_PEERS.test(specifier),
      alwaysBundle: (specifier: string) => !HOST_PEERS.test(specifier),
    },
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      onlyBundle: false,
      neverBundle: (specifier: string) => PLATFORM_MODULES.has(specifier),
      alwaysBundle: (specifier: string) => !PLATFORM_MODULES.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      banner: chunk => `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
