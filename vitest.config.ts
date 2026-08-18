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
    include: ['test/**/*.test.ts'],
    // Headroom, not a cure. The slowest test here runs in a few hundred ms,
    // but test/relay/fetch.test.ts has failed on CI at 5003ms — a marginal
    // overshoot of vitest's 5s default when the parallel workers contend on
    // a two-core runner. This buys margin for that case. It does not fix the
    // underlying flake: under heavy starvation the same file still times out
    // at 15s, so if this recurs the cause is elsewhere and worth chasing
    // rather than papering over with a bigger number.
    testTimeout: 15000
  }
})
