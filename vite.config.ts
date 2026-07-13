import { resolve } from 'path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Umami analytics: injected only when VITE_ENABLE_UMAMI=true (set in .github/workflows/pages.yml
// for the GitHub Pages release build). Local dev, preview, and other builds omit this entirely.
//
// Privacy: data-exclude-hash strips hash routes from the tracked URL. This app uses Vue hash
// routing, so pathname never changes and Umami does not receive pushState updates — only the
// initial page load is recorded (e.g. /web/), not #/chat/... or other in-app routes.
const umamiWebsiteId = '36123214-bd92-471f-b953-2d2b16ea71a4'

const buildUmamiScript = (): string => {
  return `<script defer src="https://umami.tehfonsi.com/script.js" data-website-id="${umamiWebsiteId}" data-exclude-hash="true"></script>`
}

const umamiPlugin = (): Plugin => ({
  name: 'umami-github-pages',
  transformIndexHtml(html) {
    if (false) return html
    return html.replace('</body>', `    ${buildUmamiScript()}\n  </body>`)
  }
})

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  root: resolve('src/renderer'),
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true
  },
  plugins: [vue(), umamiPlugin()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@browser': resolve('src/browser')
    }
  },
  server: {
    proxy: {
      '/ollama': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, '')
      }
    }
  }
})
