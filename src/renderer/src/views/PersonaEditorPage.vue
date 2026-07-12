<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { safeParsePersona } from '@shared/persona-schema'
import type { Persona } from '@shared/types'
import { useAppStore } from '@renderer/stores/app'

type PersonaForm = Persona & {
  description: string
}

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const rawMode = ref(false)
const rawJson = ref('')
const saveError = ref<string | null>(null)
const loadError = ref<string | null>(null)
const saving = ref(false)
const loading = ref(true)

const emptyPersona = (): PersonaForm => ({
  id: crypto.randomUUID(),
  name: '',
  description: ''
})

const normalizePersona = (persona: Persona): PersonaForm => {
  return {
    ...persona,
    description: persona.description ?? ''
  }
}

const clonePersona = (persona: Persona): PersonaForm => {
  return JSON.parse(JSON.stringify(normalizePersona(persona))) as PersonaForm
}

const form = ref<PersonaForm>(emptyPersona())
const isNew = computed(() => route.name === 'persona-new')

const loadPersona = async () => {
  loading.value = true
  loadError.value = null
  saveError.value = null
  rawMode.value = false

  try {
    if (isNew.value) {
      form.value = clonePersona(emptyPersona())
    } else {
      const id = route.params.id as string
      if (!id) {
        loadError.value = 'Persona not found'
        return
      }
      const persona = await window.api.personas.get(id)
      form.value = clonePersona(persona)
    }
    rawJson.value = JSON.stringify(form.value, null, 2)
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load persona'
  } finally {
    loading.value = false
  }
}

onMounted(loadPersona)

const syncRawFromForm = () => {
  rawJson.value = JSON.stringify(form.value, null, 2)
}

const applyRawJson = (): boolean => {
  saveError.value = null
  try {
    const parsed = JSON.parse(rawJson.value)
    const result = safeParsePersona(parsed)
    if (!result.success) {
      saveError.value = result.error.errors.map((error) => error.message).join(', ')
      return false
    }
    form.value = clonePersona(result.data)
    rawJson.value = JSON.stringify(form.value, null, 2)
    return true
  } catch {
    saveError.value = 'Invalid JSON'
    return false
  }
}

const toggleRawMode = () => {
  if (rawMode.value) {
    if (!applyRawJson()) return
  } else {
    syncRawFromForm()
  }
  rawMode.value = !rawMode.value
}

const save = async () => {
  saving.value = true
  saveError.value = null
  try {
    if (rawMode.value && !applyRawJson()) return

    const persona: Persona = {
      id: form.value.id,
      name: form.value.name.trim(),
      ...(form.value.description.trim()
        ? { description: form.value.description.trim() }
        : { description: '' })
    }

    const result = safeParsePersona(persona)
    if (!result.success) {
      saveError.value = result.error.errors.map((error) => error.message).join(', ')
      return
    }

    await window.api.personas.save(result.data)
    await Promise.all([store.refreshPersonas(), store.refreshChats()])
    router.push({ name: 'settings' })
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Failed to save persona'
  } finally {
    saving.value = false
  }
}

const deletePersona = async () => {
  if (isNew.value) return
  if (!confirm(`Delete "${form.value.name}"? Chats using this persona will be reassigned.`)) return

  try {
    await window.api.personas.delete(form.value.id)
    await Promise.all([store.refreshPersonas(), store.refreshChats()])
    router.push({ name: 'settings' })
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Failed to delete persona'
  }
}

const exportPersona = async () => {
  if (isNew.value) return
  await window.api.personas.export(form.value.id)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
    <div class="mx-auto w-full max-w-2xl space-y-6">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-xl font-semibold">{{ isNew ? 'New persona' : 'Edit persona' }}</h2>
          <p class="text-sm ui-text-subtle">Define who you are in roleplay chats.</p>
        </div>
        <button
          type="button"
          class="ui-btn-ghost text-sm"
          @click="router.push({ name: 'settings' })"
        >
          Close
        </button>
      </div>

      <p v-if="loading" class="text-sm ui-text-muted">Loading...</p>
      <p v-if="loadError" class="text-sm text-red-600 dark:text-red-400">{{ loadError }}</p>

      <template v-if="!loading && !loadError">
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="ui-btn-outline px-3 py-1.5 text-sm"
            @click="toggleRawMode"
          >
            {{ rawMode ? 'Apply form mode' : 'JSON mode' }}
          </button>
          <button
            v-if="!isNew"
            type="button"
            class="ui-btn-outline px-3 py-1.5 text-sm"
            @click="exportPersona"
          >
            Export JSON
          </button>
        </div>

        <textarea
          v-if="rawMode"
          v-model="rawJson"
          rows="16"
          class="ui-input w-full p-3 font-mono text-sm"
        />

        <div v-else class="space-y-4">
          <label class="block">
            <span class="mb-1 block text-sm ui-text-muted">Name</span>
            <input
              v-model="form.name"
              class="ui-input w-full px-3 py-2 text-sm"
              placeholder="Sam"
            />
          </label>

          <label class="block">
            <span class="mb-1 block text-sm ui-text-muted">Description</span>
            <textarea
              v-model="form.description"
              rows="8"
              class="ui-input w-full px-3 py-2 text-sm"
              placeholder="Describe your personality, role, or perspective in chats..."
            />
          </label>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="ui-btn-primary px-4 py-2 text-sm disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            Save persona
          </button>
          <button
            v-if="!isNew"
            type="button"
            class="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
            @click="deletePersona"
          >
            Delete
          </button>
          <span v-if="saveError" class="text-sm text-red-600 dark:text-red-400">{{ saveError }}</span>
        </div>
      </template>
    </div>
  </div>
</template>
