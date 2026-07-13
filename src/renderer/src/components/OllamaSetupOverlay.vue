<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { DEFAULT_OLLAMA_URL } from '@browser/llm/ollama'
import { useAppStore } from '@renderer/stores/app'

const props = defineProps<{
  previewProduction?: boolean
}>()

const router = useRouter()
const store = useAppStore()
const checking = ref(false)
const showSetup = ref(false)
const platformTab = ref<'windows' | 'macos'>('windows')

const continueToSetup = () => {
  showSetup.value = true
}

const isDev = import.meta.env.DEV
const showProductionSetup = computed(() => !isDev || props.previewProduction)
const PRODUCTION_APP_URL = 'https://opencharui.github.io/web'
const PRODUCTION_OLLAMA_ORIGIN = 'https://opencharui.github.io'

const macLaunchAgentPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencharui.ollama-origins</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string>
    <string>setenv</string>
    <string>OLLAMA_ORIGINS</string>
    <string>${PRODUCTION_OLLAMA_ORIGIN}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`

const retry = async () => {
  checking.value = true
  try {
    await store.refreshLlm()
  } finally {
    checking.value = false
  }
}

const openSettings = () => {
  router.push({ name: 'settings' })
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
    <div
      class="ui-surface max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-xl sm:p-8"
    >
      <p
        v-if="previewProduction"
        class="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
      >
        Dev preview: production setup. Remove
        <code class="text-amber-900 dark:text-amber-100">?setup=production</code>
        from the URL to return to the dev overlay.
      </p>

      <template v-if="!showSetup">
        <div class="text-center">
          <div
            class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900/5 text-3xl dark:bg-neutral-100/10"
            aria-hidden="true"
          >
            👋
          </div>
          <h2 class="text-2xl font-semibold tracking-tight">Welcome to OpenCharUI</h2>
          <p class="mx-auto mt-3 max-w-sm text-sm leading-relaxed ui-text-muted">
            Chat with AI characters privately on your own machine — no cloud, no subscriptions.
          </p>
          <p class="mx-auto mt-3 max-w-sm text-sm leading-relaxed ui-text-muted">
            To get started, we need to connect to
            <a
              href="https://ollama.com"
              target="_blank"
              rel="noopener noreferrer"
              class="font-medium text-neutral-800 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-500 dark:text-neutral-200 dark:decoration-neutral-600 dark:hover:decoration-neutral-400"
              >Ollama</a
            >, the local engine that runs your models. It only takes a few minutes.
          </p>
          <button
            type="button"
            class="ui-btn-primary mt-8 w-full px-5 py-2.5 text-sm sm:w-auto"
            @click="continueToSetup"
          >
            Continue with setup
          </button>
        </div>
      </template>

      <template v-else>
        <div class="mb-6 flex items-start gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-900/5 text-neutral-700 dark:bg-neutral-100/10 dark:text-neutral-300"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-5 w-5"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
              />
            </svg>
          </div>
          <div>
            <h2 class="text-lg font-semibold">Let's get you set up</h2>
            <p class="mt-1 text-sm ui-text-muted">
              <template v-if="showProductionSetup">
                Follow these steps to connect OpenCharUI at
                <a
                  :href="PRODUCTION_APP_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-neutral-800 underline dark:text-neutral-200"
                  >{{ PRODUCTION_APP_URL }}</a
                >
                to Ollama on your computer.
              </template>
              <template v-else>
                Follow these quick steps to connect Ollama on your machine.
              </template>
            </p>
          </div>
        </div>

        <ol class="space-y-4 text-sm">
        <li class="flex gap-3">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold dark:bg-neutral-800"
            >1</span
          >
          <div>
            <p class="font-medium">Install Ollama</p>
            <p class="mt-1 ui-text-muted">
              Download and install
              <a
                href="https://ollama.com"
                target="_blank"
                rel="noopener noreferrer"
                class="text-neutral-800 underline dark:text-neutral-200"
                >Ollama</a
              >
              for your operating system, then start the Ollama app or service.
            </p>
          </div>
        </li>

        <li class="flex gap-3">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold dark:bg-neutral-800"
            >2</span
          >
          <div>
            <p class="font-medium">Pull a model (optional)</p>
            <p class="mt-1 ui-text-muted">
              Open a terminal and run:
            </p>
            <code
              class="mt-2 block rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900"
              >ollama pull llama3.2</code
            >
            <p class="mt-2 text-xs ui-text-subtle">
              Browse more models at
              <a
                href="https://ollama.com/library"
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
                >ollama.com/library</a
              >. You can also download models later from Models settings in the app.
            </p>
          </div>
        </li>

        <li class="flex gap-3">
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-semibold dark:bg-neutral-800"
            >3</span
          >
          <div>
            <p class="font-medium">Allow browser access</p>
            <template v-if="!showProductionSetup">
              <p class="mt-1 ui-text-muted">
                In development, OpenCharUI proxies Ollama at
                <code class="text-neutral-700 dark:text-neutral-300">/ollama</code> — no extra
                configuration is needed as long as Ollama is running on
                <code class="text-neutral-700 dark:text-neutral-300">{{ DEFAULT_OLLAMA_URL }}</code
                >.
              </p>
            </template>
            <template v-else>
              <p class="mt-1 ui-text-muted">
                This app runs in your browser at
                <code class="text-neutral-700 dark:text-neutral-300">{{ PRODUCTION_APP_URL }}</code
                >. Ollama runs on your machine, so you must allow that origin to call your local
                Ollama API.
              </p>
              <p class="mt-2 ui-text-muted">
                Create a user variable named
                <code class="text-neutral-700 dark:text-neutral-300">OLLAMA_ORIGINS</code>
                with this value:
              </p>
              <code
                class="mt-2 block rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900"
                >{{ PRODUCTION_OLLAMA_ORIGIN }}</code
              >
              <p class="mt-2 text-xs ui-text-subtle">
                Use the site origin above (not the
                <code class="text-neutral-700 dark:text-neutral-300">/web</code> path). For local
                testing only, you can use
                <code class="text-neutral-700 dark:text-neutral-300">*</code>
                instead.
              </p>

              <div class="mt-4 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
                <p class="text-xs font-medium uppercase tracking-wide ui-text-subtle">
                  Make it permanent
                </p>

                <div
                  class="mt-3 flex gap-1 rounded-lg border border-neutral-200 bg-neutral-100/80 p-1 dark:border-neutral-800 dark:bg-neutral-900/50"
                  role="tablist"
                  aria-label="Platform setup"
                >
                  <button
                    type="button"
                    role="tab"
                    class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                    :class="
                      platformTab === 'windows'
                        ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                        : 'ui-text-muted hover:text-neutral-900 dark:hover:text-neutral-200'
                    "
                    :aria-selected="platformTab === 'windows'"
                    @click="platformTab = 'windows'"
                  >
                    Windows
                  </button>
                  <button
                    type="button"
                    role="tab"
                    class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                    :class="
                      platformTab === 'macos'
                        ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                        : 'ui-text-muted hover:text-neutral-900 dark:hover:text-neutral-200'
                    "
                    :aria-selected="platformTab === 'macos'"
                    @click="platformTab = 'macos'"
                  >
                    macOS
                  </button>
                </div>

                <div v-show="platformTab === 'windows'" role="tabpanel" class="mt-3">
                  <ol class="list-decimal space-y-1 pl-4 ui-text-muted">
                    <li>Quit Ollama from the taskbar tray icon.</li>
                    <li>
                      Open Start and search for
                      <span class="text-neutral-800 dark:text-neutral-200"
                        >Edit environment variables for your account</span
                      >.
                    </li>
                    <li>
                      Click <span class="text-neutral-800 dark:text-neutral-200">New…</span>,
                      set name to
                      <code class="text-neutral-700 dark:text-neutral-300">OLLAMA_ORIGINS</code>
                      and value to
                      <code class="text-neutral-700 dark:text-neutral-300">{{
                        PRODUCTION_OLLAMA_ORIGIN
                      }}</code
                      >.
                    </li>
                    <li>Click OK, then start Ollama again from the Start menu.</li>
                  </ol>
                  <p class="mt-2 text-xs ui-text-subtle">
                    Or run in an Administrator terminal:
                    <code class="text-neutral-700 dark:text-neutral-300"
                      >setx OLLAMA_ORIGINS "{{ PRODUCTION_OLLAMA_ORIGIN }}" /M</code
                    >
                    then restart Ollama.
                  </p>
                </div>

                <div v-show="platformTab === 'macos'" role="tabpanel" class="mt-3">
                  <p class="ui-text-muted">
                    Save this LaunchAgent so the variable is restored on every login:
                  </p>
                  <code
                    class="mt-2 block overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2 text-xs whitespace-pre dark:border-neutral-800 dark:bg-neutral-900"
                    >{{ macLaunchAgentPlist }}</code
                  >
                  <ol class="mt-2 list-decimal space-y-1 pl-4 ui-text-muted">
                    <li>
                      Save the file as
                      <code class="text-neutral-700 dark:text-neutral-300"
                        >~/Library/LaunchAgents/com.opencharui.ollama-origins.plist</code
                      >.
                    </li>
                    <li>
                      Run
                      <code class="text-neutral-700 dark:text-neutral-300"
                        >launchctl load ~/Library/LaunchAgents/com.opencharui.ollama-origins.plist</code
                      >.
                    </li>
                    <li>Quit and reopen the Ollama app.</li>
                  </ol>
                  <p class="mt-2 text-xs ui-text-subtle">
                    Quick test until reboot:
                    <code class="text-neutral-700 dark:text-neutral-300"
                      >launchctl setenv OLLAMA_ORIGINS "{{ PRODUCTION_OLLAMA_ORIGIN }}"</code
                    >
                    then restart Ollama.
                  </p>
                </div>
              </div>
            </template>
          </div>
        </li>
        </ol>

        <div
          class="mt-6 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-5 dark:border-neutral-800"
        >
          <button
            type="button"
            class="ui-btn-primary px-4 py-2 text-sm"
            :disabled="checking"
            @click="retry"
          >
            {{ checking ? 'Checking…' : 'Check connection' }}
          </button>
          <button type="button" class="ui-btn-outline px-4 py-2 text-sm" @click="openSettings">
            Open Settings
          </button>
          <span class="text-sm ui-text-muted">
            Status:
            <span class="text-amber-600 dark:text-amber-400">Waiting for Ollama</span>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
