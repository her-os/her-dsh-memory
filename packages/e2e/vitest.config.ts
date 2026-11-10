import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.e2e.ts'],
    globalSetup: ['src/global-setup.ts'],
    // Each file boots real DSH processes; run files one at a time.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
