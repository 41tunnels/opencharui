import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts (which is scoped to root: src/renderer for
// the app build) — vitest needs to see the whole repo, including test/ and
// src/browser/relay/, none of which the Vue app build touches directly.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@browser': resolve('src/browser')
    }
  },
  test: {
    // Pure crypto/wire logic needs no DOM — Node's built-in WebCrypto
    // (globalThis.crypto.subtle) covers it. happy-dom is a devDependency
    // for later steps' Vue-component tests; switch environment per-file
    // with a `// @vitest-environment happy-dom` comment when that's needed
    // rather than paying the DOM setup cost for every test by default.
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
