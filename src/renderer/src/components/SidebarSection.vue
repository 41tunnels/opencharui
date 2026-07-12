<script setup lang="ts">
defineProps<{ title: string; open: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    class="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide ui-text-subtle hover:text-neutral-700 dark:hover:text-neutral-300"
    @click="$emit('toggle')"
  >
    <span>{{ title }}</span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      class="h-3.5 w-3.5 shrink-0 transition-transform duration-200"
      :class="open ? 'rotate-90' : ''"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  </button>
</template>
