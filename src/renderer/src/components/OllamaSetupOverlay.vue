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
const mode = ref<'ollama' | 'amallo'>('ollama')

const isDev = import.meta.env.DEV
const showProductionSetup = computed(() => !isDev || props.previewProduction)
const PRODUCTION_APP_URL = 'https://41tunnels.github.io/opencharui'
const PRODUCTION_OLLAMA_ORIGIN = 'https://41tunnels.github.io'
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
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(14_17_19_/_0.55)] p-4 backdrop-blur-sm"
  >
    <div
      class="ui-card max-h-[90vh] w-full max-w-lg overflow-y-auto p-6 sm:p-7"
      style="box-shadow: var(--shadow-panel)"
    >
      <p v-if="previewProduction" class="ui-mono-sm ui-status ui-status-warn mb-5">
        <span class="ui-status-dot" />
        <span>
          dev preview: production setup — remove
          <code class="ui-text-strong">?setup=production</code>
          from the URL to return to the dev overlay.
        </span>
      </p>

      <div class="mb-5">
        <h2 class="ui-text-strong text-[21px] font-medium tracking-tight">
          {{ mode === 'amallo' ? 'Connect from anywhere with Amallo' : 'Connect to Ollama' }}
        </h2>
        <p v-if="mode === 'amallo'" class="mt-2 text-sm leading-relaxed ui-text-muted">
          Install
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noopener noreferrer"
            class="ui-text-accent underline underline-offset-2"
            >Ollama</a
          >
          and Amallo, then scan or paste the pairing code from Amallo's tray menu — no
          <code class="ui-mono-sm ui-text-strong">OLLAMA_ORIGINS</code> setup needed.
        </p>
        <p v-else class="mt-2 text-sm leading-relaxed ui-text-muted">
          Install
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noopener noreferrer"
            class="ui-text-accent underline underline-offset-2"
            >Ollama</a
          >
          and make sure it's running so OpenCharUI can reach it.
        </p>
      </div>

      <PairingPanel v-if="mode === 'amallo'" />

      <template v-else>
        <template v-if="!showProductionSetup">
          <div class="ui-card p-5">
            <p class="ui-text-strong text-[17px] font-semibold">Development connection</p>
            <p class="mt-1 text-sm ui-text-muted">
              OpenCharUI proxies Ollama at
              <code class="ui-mono-sm ui-text-strong">/ollama</code>
              — no
              <code class="ui-mono-sm ui-text-strong">OLLAMA_ORIGINS</code>
              setup is needed as long as Ollama is running on
              <code class="ui-mono-sm ui-text-strong">{{ DEFAULT_OLLAMA_URL }}</code
              >.
            </p>
          </div>
        </template>

        <template v-else>
          <div>
            <p class="ui-text-strong text-[17px] font-semibold">Allow this site to reach Ollama</p>
            <p class="mt-1 text-sm ui-text-muted">
              OpenCharUI runs in your browser at
              <a
                :href="PRODUCTION_APP_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="ui-text-accent"
                >{{ PRODUCTION_APP_URL }}</a
              >. Ollama runs on your machine, so you must allow that origin to call your local
              Ollama API.
            </p>
            <p class="mt-3 text-sm ui-text-muted">
              Create a user variable named
              <code class="ui-mono-sm ui-text-strong">OLLAMA_ORIGINS</code>
              with this value:
            </p>
            <code class="ui-code mt-2 block px-4 py-3">{{ PRODUCTION_OLLAMA_ORIGIN }}</code>
            <p class="mt-2 text-xs ui-text-subtle">
              Use the site origin above (not the
              <code class="ui-mono-sm ui-text-strong">/web</code>
              path). For local testing only, you can use
              <code class="ui-mono-sm ui-text-strong">*</code>
              instead.
            </p>

            <div class="ui-card mt-5 p-5">
              <p class="ui-eyebrow">setup guide</p>

              <div class="ui-inset mt-4 flex gap-1 p-1" role="tablist" aria-label="Platform setup">
                <button
                  type="button"
                  role="tab"
                  class="flex-1 px-3 py-1.5 text-sm font-medium transition-colors"
                  style="border-radius: var(--radius-1)"
                  :class="
                    platformTab === 'windows'
                      ? 'ui-raised bg-card text-strong'
                      : 'ui-text-muted hover:text-strong'
                  "
                  :aria-selected="platformTab === 'windows'"
                  @click="platformTab = 'windows'"
                >
                  Windows
                </button>
                <button
                  type="button"
                  role="tab"
                  class="flex-1 px-3 py-1.5 text-sm font-medium transition-colors"
                  style="border-radius: var(--radius-1)"
                  :class="
                    platformTab === 'macos'
                      ? 'ui-raised bg-card text-strong'
                      : 'ui-text-muted hover:text-strong'
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
                    <span class="ui-mono-sm ui-text-strong"
                      >Edit environment variables for your account</span
                    >.
                  </li>
                  <li>
                    Click <span class="ui-mono-sm ui-text-strong">New…</span>, set name to
                    <code class="ui-mono-sm ui-text-strong">OLLAMA_ORIGINS</code>
                    and value to
                    <code class="ui-mono-sm ui-text-strong">{{ PRODUCTION_OLLAMA_ORIGIN }}</code
                    >.
                  </li>
                  <li>Click OK, then start Ollama again from the Start menu.</li>
                </ol>
                <p class="mt-2 text-xs ui-text-subtle">
                  Or run in an Administrator terminal:
                  <code class="ui-mono-sm ui-text-strong"
                    >setx OLLAMA_ORIGINS "{{ PRODUCTION_OLLAMA_ORIGIN }}" /M</code
                  >
                  then restart Ollama.
                </p>
              </div>

              <div v-show="platformTab === 'macos'" role="tabpanel" class="mt-3 space-y-4">
                <div>
                  <p class="ui-text-strong text-[17px] font-semibold">Temporary (until reboot)</p>
                  <p class="mt-1 text-sm ui-text-muted">
                    Paste this one command into Terminal, then press Return:
                  </p>
                  <div class="relative mt-2">
                    <code class="ui-code block overflow-x-auto px-4 py-3 pr-20">{{
                      macTemporaryCommand
                    }}</code>
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
                  <p class="ui-text-strong text-[17px] font-semibold">Permanent</p>
                  <p class="mt-1 text-sm ui-text-muted">
                    Paste this script into Terminal to keep the setting across reboots:
                  </p>
                  <div class="relative mt-2">
                    <code
                      class="ui-code block max-h-48 overflow-auto px-4 py-3 pr-20 whitespace-pre"
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
                    <code class="ui-mono-sm ui-text-strong">OLLAMA_ORIGINS</code>
                    for this session, and restarts Ollama.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </template>
      </template>

      <div class="mt-5 border-t border-hairline pt-4">
        <button
          v-if="mode === 'ollama'"
          type="button"
          class="ui-text-accent text-sm font-medium underline underline-offset-2"
          @click="mode = 'amallo'"
        >
          Connect using Amallo
        </button>
        <button
          v-else
          type="button"
          class="ui-text-accent text-sm font-medium underline underline-offset-2"
          @click="mode = 'ollama'"
        >
          Use Ollama directly
        </button>
      </div>

      <div class="mt-6 flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
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
          <span v-if="store.llmStatus.unauthorized" class="ui-text-warn">
            Unauthorized — check the API key in Settings
          </span>
          <span v-else class="ui-text-warn">Waiting for Ollama</span>
        </span>
      </div>
    </div>
  </div>
</template>
