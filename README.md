# OpenCharUI

Browser-based roleplay chat app powered by local Ollama inference. All data is stored in the browser via IndexedDB.

## Features

- ChatGPT-like UI with collapsible Characters and Chats sidebar
- Character cards defined as JSON (personality, scenario, greeting)
- Streaming chat via local [Ollama](https://ollama.com)
- IndexedDB persistence for chats, messages, and characters

## Requirements

- Node.js 20+ (for development and building)
- [Ollama](https://ollama.com) running locally with at least one model pulled

## Ollama setup

1. Install and start Ollama.
2. Pull a model, e.g. `ollama pull llama3.2`.
3. **CORS:** The browser must be allowed to call Ollama. Set one of:
   - `OLLAMA_ORIGINS=*` (permissive, local dev)
   - `OLLAMA_ORIGINS=http://localhost:5173` (Vite dev)
   - Your deployed app origin when hosting the built SPA

During `npm run dev`, Vite proxies Ollama at `/ollama` so CORS is not required in development.

## Development

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (typically `http://localhost:5173`).

See **[requirements.md](./requirements.md)** for product rules and **[agent.md](./agent.md)** for agent instructions.

## Build

```bash
npm run build
npm run preview
```

Serve the `dist/` folder with any static host. Ensure Ollama CORS is configured for your deployment origin.

## GitHub Pages

Pushes to the `release` branch deploy automatically to GitHub Pages at:

`https://opencharui.github.io/web/`

Configure Ollama CORS for that origin when using the hosted build, e.g. `OLLAMA_ORIGINS=https://opencharui.github.io`.

## Project structure

- `src/renderer` — Vue 3 + Tailwind UI
- `src/browser` — IndexedDB storage, Ollama client, chat generation, `window.api` implementation
- `src/shared` — types, Zod schemas, prompt builder
- `resources/characters` — optional character JSON templates (not auto-imported)

## Data storage

All app data lives in the browser IndexedDB database `opencharui`:

- Characters, chats, messages, settings
- No server-side storage; clearing site data removes all chats

Existing data from the previous Electron desktop app is **not** migrated automatically.
