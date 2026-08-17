<script setup lang="ts">
/**
 * The 41tunnels endorsement — OpenCharUI is a 41tunnels project, and this is the
 * one place in the app that says so.
 *
 * The mark has two drawings, not one drawing at two sizes: below
 * --mark-crossover (24px) the primary mark's counters fill in, so it swaps to the
 * open variant. At the 14px used here that means the open path.
 */
const MARK_PRIMARY =
  'M32 8 L32 30 L17.3 30 Z M13.3 36 L32 36 L32 50 L4 50 Z M46 8 H58 V30 H46 Z M46 36 H58 V50 H46 Z'
const MARK_OPEN =
  'M32 7 L32 27 L18.7 27 Z M12 39 L32 39 L32 51 L4 51 Z M44 7 H58 V27 H44 Z M44 39 H58 V51 H44 Z'

const props = withDefaults(defineProps<{ size?: number }>(), { size: 14 })
</script>

<template>
  <span class="inline-flex items-center gap-2 ui-text-muted">
    <svg
      viewBox="0 0 64 64"
      :width="props.size"
      :height="props.size"
      class="block shrink-0"
      role="img"
      aria-label="41tunnels"
    >
      <path
        fill="currentColor"
        fill-rule="evenodd"
        :d="props.size <= 24 ? MARK_OPEN : MARK_PRIMARY"
      />
    </svg>
    <span class="ui-mono-sm">a 41tunnels project</span>
  </span>
</template>
