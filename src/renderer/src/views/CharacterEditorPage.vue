<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Character } from '@shared/types'
import { useAppStore } from '@renderer/stores/app'
import NumberInput from '@renderer/components/NumberInput.vue'

type CharacterForm = Character & {
  personality: NonNullable<Character['personality']>
  defaultParams: NonNullable<Character['defaultParams']>
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

const emptyCharacter = (): CharacterForm => ({
  id: crypto.randomUUID(),
  name: '',
  description: '',
  personality: { traits: [], speakingStyle: '' },
  scenario: '',
  greeting: '',
  defaultParams: { temperature: 0.85, topP: 0.9, maxTokens: 512 }
})

const normalizeCharacter = (character: Character): CharacterForm => {
  return {
    ...character,
    description: character.description ?? '',
    scenario: character.scenario ?? '',
    greeting: character.greeting ?? '',
    personality: {
      traits: character.personality?.traits ?? [],
      speakingStyle: character.personality?.speakingStyle ?? ''
    },
    defaultParams: {
      temperature: character.defaultParams?.temperature ?? 0.85,
      topP: character.defaultParams?.topP ?? 0.9,
      maxTokens: character.defaultParams?.maxTokens ?? 512
    }
  }
}

const cloneCharacter = (character: Character): CharacterForm => {
  return JSON.parse(JSON.stringify(normalizeCharacter(character))) as CharacterForm
}

const form = ref<CharacterForm>(emptyCharacter())

const isNew = computed(() => route.name === 'character-new')

const loadCharacter = async () => {
  loading.value = true
  loadError.value = null
  saveError.value = null
  rawMode.value = false

  try {
    if (isNew.value) {
      form.value = cloneCharacter(emptyCharacter())
    } else {
      const id = route.params.id as string
      if (!id) {
        loadError.value = 'Character not found'
        return
      }
      const character = await window.api.characters.get(id)
      form.value = cloneCharacter(character)
    }
    rawJson.value = JSON.stringify(form.value, null, 2)
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load character'
  } finally {
    loading.value = false
  }
}

onMounted(loadCharacter)

const syncRawFromForm = () => {
  rawJson.value = JSON.stringify(form.value, null, 2)
}

const toggleRawMode = () => {
  if (rawMode.value) {
    applyRawJson()
  } else {
    syncRawFromForm()
  }
  rawMode.value = !rawMode.value
}

const applyRawJson = () => {
  try {
    form.value = cloneCharacter(JSON.parse(rawJson.value) as Character)
    saveError.value = null
    syncRawFromForm()
  } catch {
    saveError.value = 'Invalid JSON'
  }
}

const save = async () => {
  saving.value = true
  saveError.value = null
  try {
    if (rawMode.value) applyRawJson()
    await window.api.characters.save(cloneCharacter(form.value))
    await store.refreshCharacters()
    router.push({ name: 'home' })
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

const remove = async () => {
  if (!confirm('Delete this character?')) return
  await window.api.characters.delete(form.value.id)
  await store.refreshCharacters()
  router.push({ name: 'home' })
}

const exportChar = async () => {
  await window.api.characters.export(form.value.id)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
    <div class="mx-auto w-full max-w-2xl">
      <div class="mb-6 flex items-center justify-between">
        <h2 class="ui-text-strong text-[21px] font-medium tracking-tight">
          {{ isNew ? 'New Character' : 'Edit Character' }}
        </h2>
        <button class="ui-btn-ghost text-sm" @click="toggleRawMode">
          {{ rawMode ? 'Form mode' : 'JSON mode' }}
        </button>
      </div>

      <p v-if="loading" class="mb-4 text-sm ui-text-muted">Loading character...</p>
      <p v-if="loadError" class="mb-4 text-sm ui-text-accent">{{ loadError }}</p>

      <div v-if="!loading && !loadError && rawMode" class="space-y-4">
        <textarea v-model="rawJson" rows="24" class="ui-input ui-input-mono w-full p-4 text-xs" />
        <button class="ui-btn-outline px-4 py-2 text-sm" @click="applyRawJson">Apply JSON</button>
      </div>

      <div v-else-if="!loading && !loadError" :key="form.id" class="space-y-4">
        <label class="block">
          <span class="ui-eyebrow mb-1.5 block">Name</span>
          <input v-model="form.name" type="text" class="ui-input w-full px-3 py-2 text-sm" />
        </label>
        <label class="block">
          <span class="ui-eyebrow mb-1.5 block">Description</span>
          <textarea
            v-model="form.description"
            rows="4"
            class="ui-input w-full px-3 py-2 text-sm"
            placeholder="Who is this character? Their role, background, and how they should behave."
          />
        </label>
        <label class="block">
          <span class="ui-eyebrow mb-1.5 block">Greeting</span>
          <textarea
            v-model="form.greeting"
            rows="3"
            class="ui-input w-full px-3 py-2 text-sm"
            placeholder="The first message this character sends when a new chat starts."
          />
          <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
            Shown automatically as the character&apos;s opening message in new chats.
          </p>
        </label>
        <label class="block">
          <span class="ui-eyebrow mb-1.5 block">Scenario</span>
          <textarea v-model="form.scenario" rows="2" class="ui-input w-full px-3 py-2 text-sm" />
        </label>
        <label class="block">
          <span class="ui-eyebrow mb-1.5 block">Personality and speaking style</span>
          <textarea
            v-model="form.personality.speakingStyle"
            rows="4"
            class="ui-input w-full px-3 py-2 text-sm"
          />
        </label>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Temperature</span>
            <NumberInput
              v-model.number="form.defaultParams.temperature"
              :step="0.05"
              :min="0"
              :max="2"
            />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              0.2 focused, 0.7 balanced, 1.2+ more surprising.
            </p>
          </label>
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Top P</span>
            <NumberInput v-model.number="form.defaultParams.topP" :step="0.05" :min="0" :max="1" />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              0.8 tighter, 0.9 common, 1.0 broadest.
            </p>
          </label>
          <label class="block">
            <span class="ui-eyebrow mb-1.5 block">Max tokens</span>
            <NumberInput v-model.number="form.defaultParams.maxTokens" :min="1" />
            <p class="ui-mono-sm ui-text-subtle mt-1.5 block">
              128 short, 512 moderate, 1024+ long replies.
            </p>
          </label>
        </div>
      </div>

      <p v-if="saveError" class="mt-4 text-sm ui-text-accent">{{ saveError }}</p>

      <div v-if="!loading && !loadError" class="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          class="ui-btn-primary px-4 py-2 text-sm disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          Save
        </button>
        <button
          v-if="!isNew"
          type="button"
          class="ui-btn-outline px-4 py-2 text-sm"
          @click="exportChar"
        >
          Export JSON
        </button>
        <button v-if="!isNew" type="button" class="ui-btn-danger px-4 py-2 text-sm" @click="remove">
          Delete
        </button>
        <button
          type="button"
          class="ui-btn-ghost px-4 py-2 text-sm"
          @click="router.push({ name: 'home' })"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>
