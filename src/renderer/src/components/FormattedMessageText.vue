<script setup lang="ts">
import { computed } from 'vue'
import { parseMessageSegments } from '@shared/message-format'

const props = defineProps<{
  content: string
}>()

const segments = computed(() => parseMessageSegments(props.content))
</script>

<template>
  <span class="whitespace-pre-wrap">
    <template v-for="(segment, index) in segments" :key="index">
      <span v-if="segment.type === 'thought'" class="thought-text">{{ segment.value }}</span>
      <span v-else-if="segment.type === 'quote'" class="quote-text">{{ segment.value }}</span>
      <span v-else class="spoken-text">{{ segment.value }}</span>
    </template>
  </span>
</template>
