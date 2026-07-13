import { resolve } from 'path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Umami analytics: injected only when VITE_ENABLE_UMAMI=true (set in .github/workflows/pages.yml
// for the GitHub Pages release build). Local dev, preview, and other builds omit this entirely.
//
// Privacy: we track a single pageview of the site root only — not hash routes, chat URLs, or
// in-app navigation. data-auto-track="false" and data-hash-mode="false" disable Umami's default
// SPA/history tracking; the manual track() call below always reports the base path (e.g. /web/).
const umamiWebsiteId = '36123214-bd92-471f-b953-2d2b16ea71a4'

const buildUmamiScripts = (base: string): string => {
  const mainUrl = base.endsWith('/') ? base : `${base}/`

  return `<script defer src="https://umami.tehfonsi.com/script.js" data-website-id="${umamiWebsiteId}" data-auto-track="false" data-hash-mode="false"></script>
    <script>
      window.addEventListener('load', function () {
        if (!window.umami) return
        window.umami.track(function (props) {
          return Object.assign({}, props, { url: ${JSON.stringify(mainUrl)} })
        })
      })
    </script>`
}

const umamiPlugin = (): Plugin => ({
  name: 'umami-github-pages',
  transformIndexHtml(html) {
    if (process.env.VITE_ENABLE_UMAMI !== 'true') return html
    const base = process.env.VITE_BASE ?? '/'
    return html.replace('</head>', `    ${buildUmamiScripts(base)}\n  </head>`)
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
