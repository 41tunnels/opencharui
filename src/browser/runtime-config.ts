import { z } from 'zod'

/**
 * Deployment-time settings the app reads at startup from `config.json`, served
 * next to `index.html`.
 *
 * The app ships as a static bundle, so anything an operator needs to vary per
 * deployment cannot be a build-time constant — it has to arrive as a file the
 * browser fetches. The Docker image writes this file on container start from
 * its environment (see `docker/40-write-config.sh`); every other build ships
 * the empty `{}` from `src/renderer/public/config.json`.
 */
const runtimeConfigSchema = z.object({
  umami: z
    .object({
      /** Base URL of the Umami instance, e.g. `https://umami.example.com`. */
      url: z.string().url(),
      websiteId: z.string().min(1)
    })
    .optional()
})

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

/**
 * Fetches and validates `config.json`.
 *
 * Never throws and never rejects: a missing, unreachable or malformed config
 * yields `{}`, which turns every optional feature off. A self-hosted
 * deployment with a typo in its analytics settings should render an app
 * without analytics, not a blank page.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' })
    if (!res.ok) return {}
    const parsed = runtimeConfigSchema.safeParse(await res.json())
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}
