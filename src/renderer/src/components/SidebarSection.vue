<script setup lang="ts">
defineProps<{ title: string; open: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    class="ui-eyebrow flex w-full items-center justify-between px-3 pb-1.5 pt-2.5 text-left hover:text-strong"
    @click="$emit('toggle')"
  >
    <span>{{ title }}</span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      class="h-3 w-3 shrink-0 transition-transform duration-200"
      :class="open ? 'rotate-90' : ''"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  </button>
</template>
