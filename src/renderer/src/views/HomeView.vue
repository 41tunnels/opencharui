<script setup lang="ts">
import { useRouter } from 'vue-router'
import BrandEndorsement from '@renderer/components/BrandEndorsement.vue'

const router = useRouter()
</script>

<template>
  <div class="flex flex-1 flex-col items-center justify-center gap-6 p-4 text-center md:p-8">
    <h1
      class="ui-text-strong text-3xl font-medium tracking-tight"
      style="letter-spacing: var(--text-h1-ls)"
    >
      OpenCharUI
    </h1>
    <p class="ui-text-muted max-w-md text-[17px] leading-relaxed" style="text-wrap: pretty">
      Pick a character from the sidebar to start a chat. Everything stays on this device unless you
      pair it with your own machine.
    </p>
    <div class="flex flex-wrap justify-center gap-2">
      <button
        class="ui-btn-primary px-4 py-2.5 text-sm"
        @click="router.push({ name: 'character-new' })"
      >
        Create character
      </button>
      <button class="ui-btn-outline px-4 py-2.5 text-sm" @click="router.push({ name: 'settings' })">
        Pair a machine
      </button>
    </div>
    <BrandEndorsement class="mt-6" />
  </div>
</template>
