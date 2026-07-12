/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['variant', 'html.dark &'],
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{vue,js,ts,css}',
    './src/browser/**/*.{js,ts}'
  ],
  theme: {
    extend: {}
  },
  plugins: []
}
