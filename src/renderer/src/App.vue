<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import { loadRuntimeConfig } from '@browser/runtime-config'

// Umami analytics, configured per deployment rather than baked into the bundle:
// the Docker image writes UMAMI_URL / UMAMI_WEBSITE_ID into config.json at
// container start, so a self-hoster points the app at their own instance
// without rebuilding it. Both refs stay null when the config says nothing,
// which is the default — no config, no third-party request.
const umamiSrc = ref<string | null>(null)
const umamiWebsiteId = ref<string | null>(null)

// After mount, so fetching the config never sits in front of first paint.
onMounted(async () => {
  const { umami } = await loadRuntimeConfig()
  if (!umami) return
  umamiSrc.value = `${umami.url.replace(/\/$/, '')}/script.js`
  umamiWebsiteId.value = umami.websiteId
})
</script>

<template>
  <div class="min-h-full">
    <RouterView />
    <!--
      `<component :is="'script'">` rather than a plain <script> tag: Vue's SFC
      compiler strips script and style tags out of client templates ("tags with
      side effect are ignored"), so a literal one would render nothing at all.
      Routing it through :is builds the element with the runtime renderer
      instead, and a script element inserted into the document that way runs.

      data-exclude-hash strips the hash route from the tracked URL. This app
      uses hash routing, so Umami sees the initial page load and never which
      chat or character the user opened.
    -->
    <component
      :is="'script'"
      v-if="umamiSrc"
      :src="umamiSrc"
      :data-website-id="umamiWebsiteId"
      data-exclude-hash="true"
      defer
    />
  </div>
</template>
