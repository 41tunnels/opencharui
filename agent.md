# Agent guide

Instructions for AI agents working in this repository.

## Requirements

All product and UX requirements are maintained in **[requirements.md](./requirements.md)**. Read that document before implementing or changing chat, character, formatting, or generation behavior.

When you add or change a user-facing rule, update `requirements.md` in the same change.

## Stack

Vue 3 SPA + TypeScript + Tailwind + Pinia + IndexedDB + Ollama (fetch).

## Conventions

- Use Tailwind for styling.
- Shared types and logic: `src/shared/`.
- Browser layer (DB, Ollama, API): `src/browser/`.
- Renderer UI: `src/renderer/`.
- Dev: `npm run dev`.

## Architecture

The UI calls `window.api` (typed as `OpenCharUiApi` in `src/shared/api.ts`). The browser implementation in `src/browser/api.ts` handles persistence and generation — there is no Electron or backend server.
