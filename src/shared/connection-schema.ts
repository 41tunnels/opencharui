import { z } from 'zod'

/**
 * Connection blob copied from amallo's tray menu ("Copy Connection (JSON)"):
 * `{ "url": "https://...", "api_key": "<token>" }`. Extra keys are ignored.
 */
export const connectionSchema = z.object({
  url: z.string().trim().min(1, 'url must not be empty'),
  api_key: z.string().trim().min(1, 'api_key must not be empty')
})

export interface ConnectionInput {
  url: string
  apiKey: string
}

export const parseConnectionJson = (raw: string): ConnectionInput => {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('Not valid JSON')
  }

  const result = connectionSchema.safeParse(data)
  if (!result.success) {
    throw new Error('Expected JSON with "url" and "api_key" fields')
  }

  return { url: result.data.url, apiKey: result.data.api_key }
}
