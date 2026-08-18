# OpenCharUI

*A [41tunnels](https://41tunnels.com) project.*

Browser-based roleplay chat app powered by local AI models via [Ollama](https://ollama.com). Everything runs on your machine — chats, characters, and inference stay local, and nothing is sent to the cloud.

Pair with **Amallo**, the 41tunnels desktop agent, to reach your own Ollama from anywhere. Amallo runs next to Ollama on your PC and opens an outbound connection to the 41tunnels relay — no port forwarding, no exposed inbound ports, and it keeps working behind CGNAT. Scan the pairing QR code once from the web app's Settings page and both sides derive their own encryption key on the spot, so the relay only ever sees ciphertext. From then on, `web` can reach your PC's Ollama from any network, while inference and data still never leave your machine.

## Features

- **Private by design** — uses local AI models on your machine; your chats and character data never leave your device
- **Connect from anywhere with Amallo** — pair with the Amallo desktop agent over the 41tunnels relay for encrypted, NAT-traversing access to your local Ollama, no port forwarding required
- **PNG character card import** — import SillyTavern-compatible character cards (V1/V2/V3) from PNG or JSON
- ChatGPT-like UI with collapsible Characters and Chats sidebar
- Character cards with personality, scenario, and greeting
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
