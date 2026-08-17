<script setup lang="ts">
import { computed } from 'vue'

const model = defineModel<string | number | undefined>({ required: true })

const props = withDefaults(
  defineProps<{
    min?: number
    max?: number
    step?: number
    placeholder?: string
    inputClass?: string
  }>(),
  {
    step: 1,
    inputClass: ''
  }
)

const numericValue = computed(() => {
  if (model.value === '' || model.value === null || model.value === undefined) return null
  const parsed = typeof model.value === 'number' ? model.value : Number(model.value)
  return Number.isNaN(parsed) ? null : parsed
})

const decimalPlaces = (value: number): number => {
  const text = String(value)
  const index = text.indexOf('.')
  return index === -1 ? 0 : text.length - index - 1
}

const clamp = (value: number): number => {
  let next = value
  if (props.min !== undefined) next = Math.max(props.min, next)
  if (props.max !== undefined) next = Math.min(props.max, next)
  const precision = Math.max(decimalPlaces(props.step), decimalPlaces(next))
  return Number(next.toFixed(precision))
}

const emitValue = (value: number | '' | undefined) => {
  if (value === '' || value === undefined) {
    model.value = ''
    return
  }
  model.value = typeof model.value === 'string' ? String(value) : value
}

const stepBy = (delta: number) => {
  const base = numericValue.value ?? props.min ?? 0
  emitValue(clamp(base + delta))
}

const onInput = (event: Event) => {
  const raw = (event.target as HTMLInputElement).value
  if (raw === '') {
    emitValue('')
    return
  }
  if (typeof model.value === 'string') {
    model.value = raw
    return
  }
  const parsed = Number(raw)
  if (!Number.isNaN(parsed)) model.value = parsed
}
</script>

<template>
  <div class="relative">
    <input
      type="number"
      :value="model"
      :min="min"
      :max="max"
      :step="step"
      :placeholder="placeholder"
      class="ui-input ui-number-input w-full py-2 pl-3 pr-9 text-sm"
      :class="inputClass"
      @input="onInput"
    />
    <div
      class="absolute inset-y-0 right-0 flex w-7 flex-col overflow-hidden rounded-r-lg border-l border-edge"
    >
      <button
        type="button"
        tabindex="-1"
        aria-label="Increase value"
        class="ui-text-muted flex flex-1 items-center justify-center border-b border-hairline bg-inset hover:text-strong"
        @mousedown.prevent
        @click="stepBy(step)"
      >
        <svg viewBox="0 0 10 6" class="h-2 w-2" aria-hidden="true">
          <path d="M5 1 9 5H1Z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        tabindex="-1"
        aria-label="Decrease value"
        class="ui-text-muted flex flex-1 items-center justify-center bg-inset hover:text-strong"
        @mousedown.prevent
        @click="stepBy(-step)"
      >
        <svg viewBox="0 0 10 6" class="h-2 w-2" aria-hidden="true">
          <path d="M1 1h8l-4 4Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  </div>
</template>
