# OpenCharUI Requirements

Product and UX requirements for OpenCharUI.

## Chat messages

### Accent formatting

Text wrapped in asterisks must render differently from plain text in **all chat bubbles** (user messages, assistant messages, and streaming text).

| Syntax | Rendering |
|--------|-----------|
| `*text*` | Italic, accent color (`text-accent`) |
| `**text**` | Same as above (also supported) |

- Parsing lives in `src/shared/message-format.ts` (`parseAccentSegments`).
- UI component: `src/renderer/src/components/FormattedMessageText.vue`.
- Plain text outside delimiters keeps the default bubble color.
- Line breaks are preserved.
- During streaming, an unclosed leading `*` or `**` starts accent styling immediately (no need to wait for the closing delimiter).

### Opening message

When a new chat starts:

- If the character has a **greeting** defined, the app displays it immediately as the first assistant message. It is **not** sent to the LLM.
- If there is no greeting, the chat starts empty and the user writes the first message.

Regenerating the opening assistant message (before any user message) still calls the model and may use the greeting as scene direction in the prompt.

### Message variations

- The latest assistant message supports **Regenerate** to produce a new variant.
- Previous variants are kept; **← / →** navigates between them with a `1 / n` indicator.
- Only the active variant is used as context for subsequent replies.

### Deleting a chat

Deleting a chat must **immediately** abort any in-flight generation for that chat, stop streaming, and avoid saving partial assistant output.

### JSON editing

- Each chat view has a **JSON mode** toggle (same pattern as character/persona editing).
- JSON includes chat metadata and all messages (not the linked character or persona objects).
- **Apply JSON** validates locally; **Save** writes the full chat back to IndexedDB.
- Chat `id` and each message `chatId` must stay consistent with the open chat.
- The chat list sidebar has **Import chat JSON** — paste exported chat JSON to import (assigns new ids; linked character/persona must exist when referenced).

## Characters

- Characters are JSON objects stored in IndexedDB with name, description, scenario, personality, optional greeting (shown as the first assistant message in new chats), and default generation params.
- Global system prompt lives in Settings (not per character).
- Default global system prompt includes roleplay rules, formatting guidance, and placeholders: `{{char}}` is replaced with the character name and `{{user}}` with the name of the user.
- Only user-created characters are shown (via **New Character**, save, or import). Bundled templates in `resources/characters/` are not auto-added.
- Import/export uses the browser file picker and download.

## Personas

- Personas represent the user's roleplay identity and are stored in IndexedDB with `name` and optional `description`.
- The app auto-creates one default persona named `Sam` when no personas exist.
- New chats automatically use the sole persona. If more than one persona exists, the user chooses one when starting a chat and may change it in Chat settings.
- Persona context is appended to the system prompt. `{{user}}` is replaced with the selected persona name.
- Personas support create, edit, JSON mode, import, export, and delete. The last persona cannot be deleted; deleting another persona reassigns its chats.

## Models

- **Ollama only** — the app connects to a local Ollama instance for inference and model listing, either directly or through a paired amallo relay connection.
- User selects a model from the header; the first available Ollama model is used by default and applied to new chats.
- Direct connections need Ollama running with CORS configured for the app origin (see README); dev mode uses a Vite proxy instead. Pairing with amallo over the relay needs no CORS setup at all — WebSocket connections aren't subject to it — which is the point of that path.
- A **gear icon** next to the header model selector opens the **Models** page for managing installed models.

### Model manager

- Lists all models currently installed in Ollama, including size when available.
- **Download** new models by name (Ollama library names such as `llama3.2` or `mistral`).
- Download shows status, byte progress, percentage, and estimated time remaining; downloads can be cancelled.
- **Remove** deletes a model from Ollama (with confirmation).
- Each model supports an optional **note** stored in IndexedDB (`modelNotes` in the `settings` store).
- After download or removal, the header model list refreshes automatically.

### Per-chat settings

Each chat has a **Settings** page (from the chat header) with:

- Chat-specific **system prompt** (appended after the global Settings prompt when set)
- **Persona** selection when more than one persona exists
- **Context window** (message pairs) for how much chat history is sent to the model
- **Temperature**, **top P**, **max tokens**, and **keep model loaded** (Ollama `keep_alive`) for generation
- Empty generation fields inherit from the linked character's defaults; empty chat system prompt uses only the global prompt
- Empty keep-alive uses Ollama's default; `0` unloads after the reply, `-1` keeps the model loaded indefinitely
- Per-chat settings are stored on the chat record and included in chat JSON import/export
- Chat settings and character defaults explain temperature, top P, and max tokens with example values.

## Development

- Run with `npm run dev`.
- Open the app in a browser at the Vite dev URL.

## Persistence

- Chats, messages, characters, personas, and settings: **IndexedDB** (database name `opencharui`, in the browser).
- Assistant messages may store multiple variations in the database.
- Clearing browser site data removes all app data.
