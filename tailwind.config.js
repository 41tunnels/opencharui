/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['variant', 'html.dark &'],
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{vue,js,ts,css}',
    './src/browser/**/*.{js,ts}'
  ],
  theme: {
    extend: {
      /* Semantic colours from the 41tunnels design system (src/renderer/src/tokens).
         Each one is declared as the var() rather than a resolved value, so the
         utility re-resolves per element and [data-surface="dark"] on <html> keeps
         flipping whole subtrees. Do not inline the hexes here.

         Spacing and radius are deliberately not bridged — the design system's
         scale diverges from Tailwind's above space-4, and quietly redefining what
         p-5 means would be worse than being explicit. See tokens/README.md. */
      colors: {
        page: 'var(--surface-page)',
        card: 'var(--surface-card)',
        inset: 'var(--surface-inset)',
        code: 'var(--surface-code)',
        hairline: 'var(--border-hairline)',
        edge: 'var(--border-strong)',
        body: 'var(--text-body)',
        strong: 'var(--text-strong)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
        accent: 'var(--text-accent)'
      }
    }
  },
  plugins: []
}
