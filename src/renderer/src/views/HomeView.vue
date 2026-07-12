<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
    <h1 class="text-2xl font-semibold">OpenCharUI</h1>
    <p class="ui-text-muted max-w-md">
      Select a character from the sidebar to start a chat, or create a new character to begin.
    </p>
    <div class="flex gap-3">
      <button class="ui-btn-primary px-4 py-2 text-sm" @click="router.push({ name: 'character-new' })">
        Create Character
      </button>
    </div>
  </div>
</template>
