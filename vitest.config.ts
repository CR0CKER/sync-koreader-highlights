import { defineConfig } from 'vitest/config'

/**
 * Dedicated Vitest config. It deliberately does NOT load `vite.config.ts`,
 * whose `vite-plugin-logseq` only works in the dev-server build path and
 * throws under Vitest's server ("Only works for non-middleware mode").
 * The unit suite covers the pure layer (`sidecar.ts`, `render.ts`), which
 * needs no plugin, no DOM, and no `logseq` global.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
