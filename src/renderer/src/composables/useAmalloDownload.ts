import { computed, ref } from 'vue'

/**
 * Amallo's download surface for the setup overlay.
 *
 * The URLs here carry no version. They point at 41tunnels.com/amallo/dl/*,
 * which resolves the newest Amallo release server-side and redirects on
 * click — so cutting an Amallo release needs no change in this repo, and this
 * app can never hand someone a stale or 404ing installer. The website's own
 * download buttons use the same routes.
 *
 * Nothing is fetched here: these are hrefs, so no request leaves the app
 * until the user actually clicks one.
 */

const SITE_URL = 'https://www.41tunnels.com'

/** The product page — every build, checksums, and the macOS first-launch note. */
export const AMALLO_PAGE_URL = `${SITE_URL}/amallo`

const downloadUrl = (platform: 'win' | 'mac') => `${SITE_URL}/amallo/dl/${platform}/latest`

export type OsKey = 'mac' | 'windows' | 'linux' | 'other'

/**
 * The installer we offer per platform. macOS gets the Apple silicon build as
 * the default — Intel and everything else live on the product page.
 */
const ASSETS: Partial<Record<OsKey, { url: string; label: string; note: string }>> = {
  mac: {
    url: downloadUrl('mac'),
    label: 'Download Amallo for macOS',
    note: 'Apple silicon · menu bar — Intel build on the download page'
  },
  windows: {
    url: downloadUrl('win'),
    label: 'Download Amallo for Windows',
    note: 'Windows 10 and 11 · system tray'
  }
}

/**
 * Amallo is a desktop tray/menu-bar app, so a phone or tablet never gets a
 * download button. iPadOS's Safari spoofs "Macintosh" but exposes touch
 * points, which is what keeps it out of the Mac branch.
 */
const detectOs = (): OsKey => {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent || ''
  const isMobile =
    /iPhone|iPad|iPod|Android|Mobi/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  if (isMobile) return 'other'
  if (/Mac/i.test(ua)) return 'mac'
  if (/Win/i.test(ua)) return 'windows'
  if (/Linux/i.test(ua)) return 'linux'
  return 'other'
}

export function useAmalloDownload() {
  // No SSR here (Electron renderer / PWA), so this resolves on first render
  // rather than after mount the way the website's composable has to.
  const os = ref<OsKey>(detectOs())
  const asset = computed(() => ASSETS[os.value] ?? null)

  return { os, asset, pageUrl: AMALLO_PAGE_URL }
}
