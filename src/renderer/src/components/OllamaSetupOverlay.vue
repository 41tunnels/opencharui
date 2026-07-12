<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { DEFAULT_OLLAMA_URL } from '@browser/llm/ollama'
import { useAppStore } from '@renderer/stores/app'

const router = useRouter()
const store = useAppStore()
const checking = ref(false)

const isDev = import.meta.env.DEV
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
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div
      class="ui-surface max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-6 shadow-xl"
    >
      <div class="mb-5 flex items-start gap-3">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500"
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
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-semibold">Set up OpenCharUI</h2>
          <p class="mt-1 text-sm ui-text-muted">
            <template v-if="!isDev">
              Ollama is not connected. Follow these steps to use OpenCharUI at
              <a
                :href="PRODUCTION_APP_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="text-neutral-800 underline dark:text-neutral-200"
                >{{ PRODUCTION_APP_URL }}</a
              >.
            </template>
            <template v-else>
              Ollama is not connected. Follow these steps to get started locally.
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
            <template v-if="isDev">
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

              <div class="mt-4 space-y-4 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
                <p class="text-xs font-medium uppercase tracking-wide ui-text-subtle">
                  Make it permanent
                </p>

                <div>
                  <p class="font-medium">Windows</p>
                  <ol class="mt-2 list-decimal space-y-1 pl-4 ui-text-muted">
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

                <div>
                  <p class="font-medium">macOS</p>
                  <p class="mt-1 ui-text-muted">
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
          <span class="text-red-600 dark:text-red-400">Not connected</span>
        </span>
      </div>
    </div>
  </div>
</template>
