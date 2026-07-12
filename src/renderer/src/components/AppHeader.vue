<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAppStore } from '@renderer/stores/app'
import ModelSelector from '@renderer/components/ModelSelector.vue'

const router = useRouter()
const store = useAppStore()

const GITHUB_REPO_URL = 'https://github.com/OpenCharUI/web'

const newChat = async () => {
  if (store.characters.length === 0) {
    router.push({ name: 'character-new' })
    return
  }
  const chat = await store.createChatForCharacter(store.characters[0].id)
  router.push({ name: 'chat', params: { id: chat.id } })
}
</script>

<template>
  <header class="ui-surface flex h-12 shrink-0 items-center gap-3 border-b px-4">
    <button
      type="button"
      class="ui-btn-ghost p-1.5"
      :title="store.uiState.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'"
      :aria-expanded="!store.uiState.sidebarCollapsed"
      aria-label="Toggle sidebar"
      @click="store.toggleSidebarCollapsed()"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        class="h-5 w-5"
        aria-hidden="true"
      >
        <path stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
    <ModelSelector />
    <button
      type="button"
      class="ui-btn-ghost p-1.5"
      title="Manage models"
      aria-label="Manage models"
      @click="router.push({ name: 'models' })"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        class="h-5 w-5"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        />
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        />
      </svg>
    </button>
    <div class="flex items-center gap-2 text-sm">
      <span
        class="inline-block h-2 w-2 rounded-full"
        :class="store.llmStatus.ollamaAvailable ? 'bg-green-500' : 'bg-red-500'"
      />
      <span class="ui-text-muted">
        {{ store.llmStatus.ollamaAvailable ? 'Ollama connected' : 'Ollama not connected' }}
      </span>
    </div>
    <div class="ml-auto flex items-center gap-2">
      <button
        type="button"
        class="ui-btn-ghost px-3 py-1.5 text-sm"
        :title="store.isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'"
        :aria-label="store.isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="store.toggleTheme()"
      >
        <svg
          v-if="store.isDarkTheme"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          class="h-5 w-5"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            stroke-linecap="round"
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
          />
        </svg>
        <svg
          v-else
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          class="h-5 w-5"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"
          />
        </svg>
      </button>
      <a
        :href="GITHUB_REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="ui-btn-ghost p-1.5"
        title="View on GitHub"
        aria-label="View on GitHub"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-5 w-5"
          aria-hidden="true"
        >
          <path
            d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.135-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.435 1.845 1.23 1.07 1.86 2.775 1.335 3.465 1.015.105-.78.42-1.335.765-1.64-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.37 1.23-3.225-.12-.3-.54-1.53.12-3.105 0 0 1.005-.315 3.3 1.26.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.575 3.3-1.26 3.3-1.26.66 1.575.24 2.805.12 3.105.765.855 1.23 1.92 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z"
          />
        </svg>
      </a>
      <button
        class="ui-btn-ghost px-3 py-1.5 text-sm"
        @click="router.push({ name: 'settings' })"
      >
        Settings
      </button>
      <button class="ui-btn-primary px-3 py-1.5 text-sm" @click="newChat">New Chat</button>
    </div>
  </header>
</template>
