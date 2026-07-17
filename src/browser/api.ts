import type { OpenCharUiApi } from '@shared/api'
import type { Character, Persona } from '@shared/types'
import {
  normalizeSavedMessages,
  parseChatSave,
  prepareChatImport
} from '@shared/chat-schema'
import * as characters from './db/characters'
import * as personas from './db/personas'
import * as chats from './db/chats'
import * as settings from './db/settings'
import * as uiState from './db/ui-state'
import * as modelNotes from './db/model-notes'
import * as ollama from './llm/ollama'
import * as chatGen from './chat-generation'
import * as deviceSync from './device-sync'
import { emit, subscribe } from './events'
import { listChatsForCharacter, listChatsForPersona } from './db/chats'

const streamCallbacks = (chatId: string) => {
  return {
    onChunk: (delta: string) => {
      void chats.getChat(chatId).then((chat) => {
        if (chat) emit('chat:chunk', { chatId, delta })
      })
    }
  }
}

const notifyChatCancelled = (chatId: string): void => {
  emit('chat:cancelled', { chatId })
}

const handleGenerationError = (chatId: string, err: unknown): never => {
  if (chatGen.isChatCancelledError(err)) {
    notifyChatCancelled(chatId)
    throw err
  }
  const error = err instanceof Error ? err.message : 'Generation failed'
  emit('chat:error', { chatId, error })
  throw err
}

export const createBrowserApi = (): OpenCharUiApi => {
  return {
    characters: {
      list: () => characters.listCharacters(),
      get: async (id: string) => {
        const char = await characters.getCharacter(id)
        if (!char) throw new Error('Character not found')
        return char
      },
      save: async (character: Character) => {
        await characters.saveCharacter(character)
      },
      delete: async (id: string) => {
        const chatIds = (await listChatsForCharacter(id)).map((chat) => chat.id)
        for (const chatId of chatIds) {
          chatGen.cancelGenerationForChat(chatId)
        }
        await characters.deleteCharacter(id)
        for (const chatId of chatIds) {
          notifyChatCancelled(chatId)
        }
      },
      import: () => characters.importCharacter(),
      export: (id: string) => characters.exportCharacter(id)
    },
    personas: {
      list: () => personas.listPersonas(),
      get: async (id: string) => {
        const persona = await personas.getPersona(id)
        if (!persona) throw new Error('Persona not found')
        return persona
      },
      save: async (persona: Persona) => {
        await personas.savePersona(persona)
      },
      delete: async (id: string) => {
        const chatIds = (await listChatsForPersona(id)).map((chat) => chat.id)
        for (const chatId of chatIds) {
          chatGen.cancelGenerationForChat(chatId)
        }
        await personas.deletePersona(id)
        for (const chatId of chatIds) {
          notifyChatCancelled(chatId)
        }
      },
      import: () => personas.importPersona(),
      export: (id: string) => personas.exportPersona(id)
    },
    chats: {
      list: () => chats.listChats(),
      get: async (id: string) => {
        const chat = await chats.getChat(id)
        if (!chat) throw new Error('Chat not found')
        return chat
      },
      create: (characterId: string, personaId?: string) => chats.createChat(characterId, personaId),
      save: async (raw) => {
        const parsed = parseChatSave(raw)
        const saved = await chats.saveChat({
          ...parsed,
          messages: normalizeSavedMessages(parsed.messages, parsed.id)
        })
        return saved
      },
      import: async (raw) => {
        const parsed = parseChatSave(raw)
        const prepared = prepareChatImport(parsed)
        return chats.importChat({
          ...prepared,
          messages: normalizeSavedMessages(prepared.messages, prepared.id)
        })
      },
      delete: async (id: string) => {
        chatGen.cancelGenerationForChat(id)
        await chats.deleteChat(id)
        notifyChatCancelled(id)
      },
      rename: (id: string, title: string) => chats.renameChat(id, title),
      setModel: (id: string, modelId: string, provider: 'ollama') =>
        chats.setChatModel(id, modelId, provider),
      saveSettings: (id: string, settings) => chats.saveChatSettings(id, settings)
    },
    settings: {
      get: () => settings.getSettings(),
      save: async (partial) => {
        const saved = await settings.saveSettings(partial)
        if (partial.ollamaUrl !== undefined || partial.ollamaApiKey !== undefined) {
          ollama.invalidateOllamaBaseUrl()
          // Connection changed — re-evaluate sync against the new target.
          void deviceSync.syncNow()
        }
        return saved
      }
    },
    sync: {
      now: () => deviceSync.syncNow(),
      getStatus: () => deviceSync.getSyncStatus(),
      onStatusChanged: (callback) => deviceSync.onSyncStatusChanged(callback)
    },
    ui: {
      get: () => uiState.getUiState(),
      save: (partial) => uiState.saveUiState(partial)
    },
    llm: {
      getStatus: async () => {
        const probe = await ollama.probeOllama()
        return {
          ollamaAvailable: probe === 'ok',
          usingAmallo: await ollama.isUsingAmallo(),
          unauthorized: probe === 'unauthorized'
        }
      },
      listModels: async () => {
        const probe = await ollama.probeOllama()
        if (probe !== 'ok') return []
        return ollama.listModels()
      },
      getModelContextLength: (modelId: string) => ollama.getModelContextLength(modelId),
      pullModel: async (name, onProgress, signal) => {
        const probe = await ollama.probeOllama()
        if (probe !== 'ok') throw new Error('Ollama is not connected')
        return ollama.pullModel(name, onProgress, signal)
      },
      deleteModel: async (name) => {
        const probe = await ollama.probeOllama()
        if (probe !== 'ok') throw new Error('Ollama is not connected')
        return ollama.deleteModel(name)
      }
    },
    modelNotes: {
      getAll: () => modelNotes.getModelNotes(),
      set: (modelId, note) => modelNotes.setModelNote(modelId, note),
      delete: (modelId) => modelNotes.deleteModelNote(modelId)
    },
    chat: {
      send: async (chatId: string, content: string) => {
        try {
          const result = await chatGen.sendUserMessage(chatId, content, streamCallbacks(chatId))
          emit('chat:done', { chatId, messageId: result.messageId })
        } catch (err) {
          if (chatGen.isChatCancelledError(err)) {
            notifyChatCancelled(chatId)
            return
          }
          handleGenerationError(chatId, err)
        }
      },
      generateOpening: async (chatId: string) => {
        try {
          const result = await chatGen.generateOpeningMessage(chatId)
          if (result) {
            emit('chat:done', { chatId, messageId: result.messageId })
          }
        } catch (err) {
          if (chatGen.isChatCancelledError(err)) {
            notifyChatCancelled(chatId)
            return
          }
          handleGenerationError(chatId, err)
        }
      },
      regenerateLast: async (chatId: string) => {
        try {
          const result = await chatGen.regenerateLastAssistantMessage(
            chatId,
            streamCallbacks(chatId)
          )
          emit('chat:done', { chatId, messageId: result.messageId })
        } catch (err) {
          if (chatGen.isChatCancelledError(err)) {
            notifyChatCancelled(chatId)
            return
          }
          handleGenerationError(chatId, err)
        }
      },
      setVariation: (chatId: string, messageId: string, direction: 'prev' | 'next') =>
        chatGen.selectMessageVariation(chatId, messageId, direction),
      editLastUserMessage: async (chatId: string, content: string) => {
        try {
          const result = await chatGen.editLastUserMessage(
            chatId,
            content,
            streamCallbacks(chatId)
          )
          if (result.regenerated && result.messageId) {
            emit('chat:done', { chatId, messageId: result.messageId })
          }
          return result.message
        } catch (err) {
          if (chatGen.isChatCancelledError(err)) {
            notifyChatCancelled(chatId)
            throw err
          }
          return handleGenerationError(chatId, err)
        }
      },
      editLastAssistantMessage: (chatId: string, content: string) =>
        chatGen.editLastAssistantMessage(chatId, content),
      deleteMessage: (chatId: string, messageId: string) =>
        chats.deleteChatMessage(chatId, messageId),
      abort: async (chatId: string) => {
        chatGen.abortGeneration(chatId)
      },
      onChunk: (callback) => subscribe('chat:chunk', callback),
      onDone: (callback) => subscribe('chat:done', callback),
      onError: (callback) => subscribe('chat:error', callback),
      onCancelled: (callback) => subscribe('chat:cancelled', callback)
    }
  }
}
