<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { safeParseChatSave } from '@shared/chat-schema'
import { normalizeCharacterImportData } from '@shared/character-card-import'
import { safeParseCharacter } from '@shared/character-schema'
import { formatRelativeTime } from '@shared/format-time'
import { useAppStore } from '@renderer/stores/app'
import SidebarSection from '@renderer/components/SidebarSection.vue'

const router = useRouter()
const store = useAppStore()

const showImport = ref(false)
const importJson = ref('')
const importError = ref<string | null>(null)
const importing = ref(false)
const showCharacterImport = ref(false)
const characterImportJson = ref('')
const characterImportError = ref<string | null>(null)
const characterImporting = ref(false)
const pendingCharacterId = ref<string | null>(null)

const startChat = async (characterId: string) => {
  if (store.personas.length > 1) {
    pendingCharacterId.value = characterId
    return
  }

  const chat = await store.createChatForCharacter(characterId)
  router.push({ name: 'chat', params: { id: chat.id } })
}

const startChatWithPersona = async (personaId: string) => {
  if (!pendingCharacterId.value) return
  const chat = await store.createChatForCharacter(pendingCharacterId.value, personaId)
  pendingCharacterId.value = null
  router.push({ name: 'chat', params: { id: chat.id } })
}

const editCharacter = (id: string) => {
  router.push({ name: 'character-edit', params: { id } })
}

const editPersona = (id: string) => {
  router.push({ name: 'persona-edit', params: { id } })
}

const deleteCharacter = async (id: string, name: string) => {
  if (
    !confirm(
      `Delete "${name}"? This character and all of their chats will be permanently removed.`
    )
  ) {
    return
  }

  if (store.activeChat?.characterId === id) {
    store.handleChatDeleted(store.activeChat.id)
    router.push({ name: 'home' })
  }

  await window.api.characters.delete(id)

  await Promise.all([store.refreshCharacters(), store.refreshChats()])
}

const deletePersona = async (id: string, name: string) => {
  if (!confirm(`Delete "${name}"? Chats using this persona will be reassigned.`)) return

  try {
    await window.api.personas.delete(id)
    await Promise.all([store.refreshPersonas(), store.refreshChats()])
    if (store.activeChat) {
      await store.loadChat(store.activeChat.id)
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Failed to delete persona')
  }
}

const deleteChat = async (id: string, title: string) => {
  if (!confirm(`Delete chat "${title}"? This cannot be undone.`)) return

  if (store.activeChat?.id === id) {
    store.handleChatDeleted(id)
    router.push({ name: 'home' })
  }

  await window.api.chats.delete(id)
  await store.refreshChats()
}

const toggleImport = () => {
  showImport.value = !showImport.value
  if (showImport.value) showCharacterImport.value = false
  importError.value = null
}

const toggleCharacterImport = () => {
  showCharacterImport.value = !showCharacterImport.value
  if (showCharacterImport.value) showImport.value = false
  characterImportError.value = null
}

const submitImport = async () => {
  importError.value = null
  importing.value = true
  try {
    let raw: unknown
    try {
      raw = JSON.parse(importJson.value)
    } catch {
      importError.value = 'Invalid JSON'
      return
    }

    const result = safeParseChatSave(raw)
    if (!result.success) {
      importError.value = result.error.errors.map((e) => e.message).join(', ')
      return
    }

    const chat = await window.api.chats.import(result.data)
    await store.refreshChats()
    showImport.value = false
    importJson.value = ''
    router.push({ name: 'chat', params: { id: chat.id } })
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Import failed'
  } finally {
    importing.value = false
  }
}

const submitCharacterImport = async () => {
  characterImportError.value = null
  characterImporting.value = true
  try {
    let raw: unknown
    try {
      raw = JSON.parse(characterImportJson.value)
    } catch {
      characterImportError.value = 'Invalid JSON'
      return
    }

    raw = normalizeCharacterImportData(raw)
    const result = safeParseCharacter(raw)
    if (!result.success) {
      characterImportError.value = result.error.errors.map((e) => e.message).join(', ')
      return
    }

    const character = { ...result.data, id: crypto.randomUUID() }
    await window.api.characters.save(character)
    await store.refreshCharacters()
    showCharacterImport.value = false
    characterImportJson.value = ''
    router.push({ name: 'character-edit', params: { id: character.id } })
  } catch (err) {
    characterImportError.value = err instanceof Error ? err.message : 'Import failed'
  } finally {
    characterImporting.value = false
  }
}

const importCharacterFromFile = async () => {
  characterImportError.value = null
  characterImporting.value = true

  try {
    const character = await window.api.characters.import()
    if (!character) return

    await store.refreshCharacters()
    showCharacterImport.value = false
    characterImportJson.value = ''
    router.push({ name: 'character-edit', params: { id: character.id } })
  } catch (err) {
    characterImportError.value = err instanceof Error ? err.message : 'Import failed'
  } finally {
    characterImporting.value = false
  }
}
</script>

<template>
  <aside
    class="ui-surface fixed bottom-0 left-0 top-12 z-40 flex w-64 shrink-0 flex-col overflow-hidden border-r transition-[width,transform] duration-200 ease-in-out md:relative md:inset-auto md:z-auto"
    :class="
      store.uiState.sidebarCollapsed
        ? '-translate-x-full border-r-0 md:translate-x-0 md:w-0'
        : 'translate-x-0 md:w-64'
    "
  >
    <SidebarSection
      title="Characters"
      :open="store.uiState.sidebarSections.characters"
      @toggle="store.toggleSidebarSection('characters')"
    />
    <div v-show="store.uiState.sidebarSections.characters" class="space-y-0.5 px-2 pb-3">
      <div
        v-for="character in store.characters"
        :key="character.id"
        class="group flex items-center gap-0.5 rounded-lg ui-hover-row"
      >
        <button
          class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
          @click="startChat(character.id)"
        >
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {{ character.name.charAt(0).toUpperCase() }}
          </span>
          <span class="min-w-0 flex-1 truncate">{{ character.name }}</span>
        </button>
        <div
          class="ui-hover-reveal mr-1 flex w-[5.5rem] shrink-0 items-center justify-end gap-0.5 transition-opacity duration-150"
        >
          <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-1 text-xs ui-text-subtle hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            title="Edit character"
            @click.stop="editCharacter(character.id)"
          >
            Edit
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-1 text-xs ui-text-subtle hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
            title="Delete character"
            @click.stop="deleteCharacter(character.id, character.name)"
          >
            Delete
          </button>
        </div>
      </div>
      <p v-if="store.characters.length === 0" class="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-600">
        No characters yet
      </p>
    </div>

    <SidebarSection
      title="Personas"
      :open="store.uiState.sidebarSections.personas"
      @toggle="store.toggleSidebarSection('personas')"
    />
    <div v-show="store.uiState.sidebarSections.personas" class="space-y-0.5 px-2 pb-3">
      <div
        v-for="persona in store.personas"
        :key="persona.id"
        class="group flex items-center gap-0.5 rounded-lg ui-hover-row"
      >
        <button
          class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
          @click="editPersona(persona.id)"
        >
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {{ persona.name.charAt(0).toUpperCase() }}
          </span>
          <span class="min-w-0 flex-1 truncate">{{ persona.name }}</span>
        </button>
        <div
          class="ui-hover-reveal mr-1 flex w-[5.5rem] shrink-0 items-center justify-end gap-0.5 transition-opacity duration-150"
        >
          <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-1 text-xs ui-text-subtle hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            title="Edit persona"
            @click.stop="editPersona(persona.id)"
          >
            Edit
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md px-1.5 py-1 text-xs ui-text-subtle hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
            title="Delete persona"
            @click.stop="deletePersona(persona.id, persona.name)"
          >
            Delete
          </button>
        </div>
      </div>
      <p v-if="store.personas.length === 0" class="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-600">
        No personas yet
      </p>
    </div>

    <SidebarSection
      title="Chats"
      :open="store.uiState.sidebarSections.chats"
      @toggle="store.toggleSidebarSection('chats')"
    />
    <div v-show="store.uiState.sidebarSections.chats" class="flex min-h-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        <div
          v-for="chat in store.chats"
          :key="chat.id"
          class="group flex items-center gap-0.5 rounded-lg ui-hover-row"
          :class="store.activeChat?.id === chat.id ? 'ui-active-row' : ''"
        >
          <button
            class="flex min-w-0 flex-1 flex-col px-3 py-2 text-left"
            @click="router.push({ name: 'chat', params: { id: chat.id } })"
          >
            <span class="truncate text-sm">{{ chat.title }}</span>
            <time
              v-if="chat.lastMessageAt"
              :datetime="new Date(chat.lastMessageAt).toISOString()"
              :title="new Date(chat.lastMessageAt).toLocaleString()"
              class="truncate text-xs ui-text-subtle"
            >
              {{ formatRelativeTime(chat.lastMessageAt) }}
            </time>
          </button>
          <div
            class="ui-hover-reveal mr-1 flex w-[3.25rem] shrink-0 items-center justify-end transition-opacity duration-150"
          >
            <button
              type="button"
              class="shrink-0 rounded-md px-1.5 py-1 text-xs ui-text-subtle hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
              title="Delete chat"
              @click.stop="deleteChat(chat.id, chat.title)"
            >
              Delete
            </button>
          </div>
        </div>
        <p v-if="store.chats.length === 0" class="px-3 py-2 text-xs text-neutral-400 dark:text-neutral-600">
          No chats yet
        </p>
      </div>

      <div class="shrink-0 border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        <button
          type="button"
          class="ui-btn-outline w-full px-3 py-2 text-sm"
          @click="toggleImport"
        >
          {{ showImport ? 'Cancel import' : '+ Import chat JSON' }}
        </button>

        <div v-if="showImport" class="mt-2 space-y-2">
          <textarea
            v-model="importJson"
            rows="8"
            class="ui-input w-full p-2 font-mono text-xs"
            placeholder="Paste chat JSON here..."
          />
          <button
            type="button"
            class="ui-btn-primary w-full px-3 py-2 text-sm disabled:opacity-50"
            :disabled="importing || !importJson.trim()"
            @click="submitImport"
          >
            Import
          </button>
          <p v-if="importError" class="text-xs text-red-600 dark:text-red-400">{{ importError }}</p>
          <p class="text-xs ui-text-subtle">
            Paste JSON from chat JSON mode. The character and persona must already exist; new ids
            are assigned on import.
          </p>
        </div>

        <button
          type="button"
          class="ui-btn-outline mt-2 w-full px-3 py-2 text-sm"
          @click="toggleCharacterImport"
        >
          {{ showCharacterImport ? 'Cancel import' : '+ Import character' }}
        </button>

        <div v-if="showCharacterImport" class="mt-2 space-y-2">
          <textarea
            v-model="characterImportJson"
            rows="8"
            class="ui-input w-full p-2 font-mono text-xs"
            placeholder="Paste character JSON here..."
          />
          <button
            type="button"
            class="ui-btn-primary w-full px-3 py-2 text-sm disabled:opacity-50"
            :disabled="characterImporting || !characterImportJson.trim()"
            @click="submitCharacterImport"
          >
            Import
          </button>
          <button
            type="button"
            class="ui-btn-outline w-full px-3 py-2 text-sm disabled:opacity-50"
            :disabled="characterImporting"
            @click="importCharacterFromFile"
          >
            Import JSON or PNG file
          </button>
          <p v-if="characterImportError" class="text-xs text-red-600 dark:text-red-400">
            {{ characterImportError }}
          </p>
          <p class="text-xs ui-text-subtle">
            Paste OpenCharUI or SillyTavern JSON, or import a PNG character card. A new id is
            assigned on import.
          </p>
        </div>
      </div>
    </div>

    <div class="mt-auto shrink-0 space-y-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
      <button
        class="ui-btn-outline w-full px-3 py-2 text-sm"
        @click="router.push({ name: 'character-new' })"
      >
        + New Character
      </button>
      <button
        class="ui-btn-outline w-full px-3 py-2 text-sm"
        @click="router.push({ name: 'persona-new' })"
      >
        + New Persona
      </button>
    </div>
  </aside>

  <div
    v-if="pendingCharacterId"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="pendingCharacterId = null"
  >
    <div class="ui-surface w-full max-w-sm rounded-2xl border p-4 shadow-xl">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h2 class="text-base font-semibold">Choose persona</h2>
        <button
          type="button"
          class="ui-btn-ghost px-2 py-1 text-sm"
          @click="pendingCharacterId = null"
        >
          Cancel
        </button>
      </div>
      <div class="space-y-2">
        <button
          v-for="persona in store.personas"
          :key="persona.id"
          type="button"
          class="ui-hover-row flex w-full flex-col rounded-lg px-3 py-2 text-left"
          @click="startChatWithPersona(persona.id)"
        >
          <span class="text-sm font-medium">{{ persona.name }}</span>
          <span v-if="persona.description" class="mt-0.5 line-clamp-2 text-xs ui-text-subtle">
            {{ persona.description }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
