<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { DEFAULT_OLLAMA_URL } from '@browser/llm/ollama'
import { useAppStore } from '@renderer/stores/app'
import PairingPanel from './PairingPanel.vue'

const props = defineProps<{
  previewProduction?: boolean
}>()

const router = useRouter()
const store = useAppStore()
const checking = ref(false)
const platformTab = ref<'windows' | 'macos'>('windows')
const showDirectSetup = ref(false)

const isDev = import.meta.env.DEV
const showProductionSetup = computed(() => !isDev || props.previewProduction)
const PRODUCTION_APP_URL = 'https://opencharui.github.io/web'
const PRODUCTION_OLLAMA_ORIGIN = 'https://opencharui.github.io'
const macCopied = ref<'temporary' | 'permanent' | null>(null)

const macTemporaryCommand = `launchctl setenv OLLAMA_ORIGINS "${PRODUCTION_OLLAMA_ORIGIN}" && osascript -e 'quit app "Ollama"' 2>/dev/null; sleep 1; open -a Ollama`

const macPermanentScript = `ORIGIN="${PRODUCTION_OLLAMA_ORIGIN}"
PLIST="$HOME/Library/LaunchAgents/com.opencharui.ollama-origins.plist"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
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
    <string>$ORIGIN</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

# Apply for this login session and keep it across reboots
launchctl setenv OLLAMA_ORIGINS "$ORIGIN"
launchctl bootout "gui/$(id -u)/com.opencharui.ollama-origins" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

# Restart Ollama so it picks up the new value
osascript -e 'quit app "Ollama"' 2>/dev/null || true
sleep 1
open -a Ollama

echo "Done. OLLAMA_ORIGINS=$ORIGIN (permanent). Ollama was restarted."`

const copyMacText = async (text: string, kind: 'temporary' | 'permanent') => {
  try {
    await navigator.clipboard.writeText(text)
    macCopied.value = kind
    setTimeout(() => {
      if (macCopied.value === kind) macCopied.value = null
    }, 2000)
  } catch {
    macCopied.value = null
  }
}

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

      <div class="mb-5">
        <h2 class="text-xl font-semibold tracking-tight">Connect from anywhere with amallo</h2>
        <p class="mt-2 text-sm leading-relaxed ui-text-muted">
          Install
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium text-neutral-800 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-500 dark:text-neutral-200 dark:decoration-neutral-600 dark:hover:decoration-neutral-400"
            >Ollama</a
          >
          and amallo, then scan or paste the pairing code from amallo's tray menu — no
          <code class="text-neutral-700 dark:text-neutral-300">OLLAMA_ORIGINS</code> setup needed.
        </p>
      </div>

      <PairingPanel />

      <div class="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          class="text-sm font-medium text-neutral-600 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-500 dark:text-neutral-400 dark:decoration-neutral-600"
          @click="showDirectSetup = !showDirectSetup"
        >
          {{ showDirectSetup ? 'Hide' : 'Or connect directly on your network' }}
        </button>
      </div>

      <template v-if="showDirectSetup">
      <template v-if="!showProductionSetup">
        <div class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p class="text-sm font-medium">Development connection</p>
          <p class="mt-1 text-sm ui-text-muted">
            OpenCharUI proxies Ollama at
            <code class="text-neutral-700 dark:text-neutral-300">/ollama</code>
            — no
            <code class="text-neutral-700 dark:text-neutral-300">OLLAMA_ORIGINS</code>
            setup is needed as long as Ollama is running on
            <code class="text-neutral-700 dark:text-neutral-300">{{ DEFAULT_OLLAMA_URL }}</code>.
          </p>
        </div>
      </template>

      <template v-else>
        <div>
          <p class="text-sm font-medium">Allow this site to reach Ollama</p>
          <p class="mt-1 text-sm ui-text-muted">
            OpenCharUI runs in your browser at
            <a
              :href="PRODUCTION_APP_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="text-neutral-800 underline dark:text-neutral-200"
              >{{ PRODUCTION_APP_URL }}</a
            >. Ollama runs on your machine, so you must allow that origin to call your local Ollama
            API.
          </p>
          <p class="mt-3 text-sm ui-text-muted">
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
            <code class="text-neutral-700 dark:text-neutral-300">/web</code>
            path). For local testing only, you can use
            <code class="text-neutral-700 dark:text-neutral-300">*</code>
            instead.
          </p>

          <div class="mt-4 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            <p class="text-xs font-medium uppercase tracking-wide ui-text-subtle">
              Setup guide
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
              <ol class="list-decimal space-y-1 pl-4 text-sm ui-text-muted">
                <li>Quit Ollama from the taskbar tray icon.</li>
                <li>
                  Open Start and search for
                  <span class="text-neutral-800 dark:text-neutral-200"
                    >Edit environment variables for your account</span
                  >.
                </li>
                <li>
                  Click <span class="text-neutral-800 dark:text-neutral-200">New…</span>, set name
                  to
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

            <div v-show="platformTab === 'macos'" role="tabpanel" class="mt-3 space-y-4">
              <div>
                <p class="text-sm font-medium">Temporary (until reboot)</p>
                <p class="mt-1 text-sm ui-text-muted">
                  Paste this one command into Terminal, then press Return:
                </p>
                <div class="relative mt-2">
                  <code
                    class="block overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2 pr-20 text-xs dark:border-neutral-800 dark:bg-neutral-900"
                    >{{ macTemporaryCommand }}</code
                  >
                  <button
                    type="button"
                    class="ui-btn-outline absolute top-2 right-2 px-2 py-1 text-xs"
                    @click="copyMacText(macTemporaryCommand, 'temporary')"
                  >
                    {{ macCopied === 'temporary' ? 'Copied' : 'Copy' }}
                  </button>
                </div>
              </div>

              <div>
                <p class="text-sm font-medium">Permanent</p>
                <p class="mt-1 text-sm ui-text-muted">
                  Paste this script into Terminal to keep the setting across reboots:
                </p>
                <div class="relative mt-2">
                  <code
                    class="block max-h-48 overflow-auto rounded-lg border border-neutral-200 bg-neutral-100 px-3 py-2 pr-20 text-xs whitespace-pre dark:border-neutral-800 dark:bg-neutral-900"
                    >{{ macPermanentScript }}</code
                  >
                  <button
                    type="button"
                    class="ui-btn-outline absolute top-2 right-2 px-2 py-1 text-xs"
                    @click="copyMacText(macPermanentScript, 'permanent')"
                  >
                    {{ macCopied === 'permanent' ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <p class="mt-2 text-xs ui-text-subtle">
                  Writes a LaunchAgent, applies
                  <code class="text-neutral-700 dark:text-neutral-300">OLLAMA_ORIGINS</code>
                  for this session, and restarts Ollama.
                </p>
              </div>
            </div>
          </div>
        </div>
      </template>
      </template>

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
          <span v-if="store.llmStatus.unauthorized" class="text-amber-600 dark:text-amber-400">
            Unauthorized — check the API key in Settings
          </span>
          <span v-else class="text-amber-600 dark:text-amber-400">Waiting for Ollama</span>
        </span>
      </div>
    </div>
  </div>
</template>
