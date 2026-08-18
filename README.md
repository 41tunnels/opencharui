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

Serve the `dist/` folder with any static host, or use the Docker image below. Ensure Ollama CORS is configured for your deployment origin.

## Docker

Released versions are published to the GitHub Container Registry:

```bash
docker run --rm -p 8080:8080 ghcr.io/41tunnels/opencharui:latest
```

The app is then at `http://localhost:8080`. Images are tagged with the release version (`:1.2.3`) and `:latest`, for `linux/amd64` and `linux/arm64`. See `docker-compose.yml` for a fuller example.

Configure Ollama CORS for whatever origin you serve the container on, e.g. `OLLAMA_ORIGINS=http://localhost:8080` (see [Ollama setup](#ollama-setup) above).

### Analytics (optional)

The image ships with analytics off and makes no third-party request. To send page loads to your own [Umami](https://umami.is) instance, set **both**:

| Variable | Example |
| --- | --- |
| `UMAMI_URL` | `https://umami.example.com` |
| `UMAMI_WEBSITE_ID` | `00000000-0000-0000-0000-000000000000` |

These are read at container start and written to `config.json`, which the app fetches on load — so they can be changed by restarting the container, with no rebuild. Only the initial page load is recorded; the app is hash-routed and the tag sets `data-exclude-hash`, so which chat or character you open is never sent.

## GitHub Pages

A copy is deployed to GitHub Pages at:

`https://opencharui.github.io/web/`

That deployment is **manual** — run the *Deploy GitHub Pages* workflow from the Actions tab, selecting the `release` branch. Pushing to `release` cuts a release and publishes the Docker image, but does not update Pages.

Configure Ollama CORS for that origin when using the hosted build, e.g. `OLLAMA_ORIGINS=https://opencharui.github.io`.

## Releases

`web` uses [semantic-release](https://semantic-release.gitbook.io). Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:` → minor, `fix:` → patch, `!`/`BREAKING CHANGE` → major), and merging to `release` derives the next version, tags it, publishes GitHub release notes and pushes the Docker image. Version numbers are never bumped by hand.

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
