// zod schemas for every /extended/v1 response — the old device-sync.ts cast
// `res.json()` straight to a TS interface with no runtime validation
// (device-sync.ts:217's `as SyncResponse`). Parsing here means a shape
// mismatch (a protocol drift, a proxy mangling the body) surfaces as a
// clear "This amallo version does not support sync"-style error instead of
// an undefined-is-not-a-function crash three calls deep.
import { z } from 'zod'

export const recordWireSchema = z.object({
  namespace: z.string(),
  key: z.string(),
  seq: z.number(),
  hash: z.string(),
  updatedAt: z.number(),
  deleted: z.boolean(),
  data: z.unknown().optional()
})
export type RecordWire = z.infer<typeof recordWireSchema>

export const pullResponseSchema = z.object({
  storeId: z.string(),
  head: z.number(),
  reapFloor: z.number(),
  cursor: z.number(),
  more: z.boolean(),
  records: z.array(recordWireSchema)
})
export type PullResponse = z.infer<typeof pullResponseSchema>

export const pushStatusSchema = z.enum(['applied', 'duplicate', 'superseded', 'missingBlobs', 'rejected'])
export type PushStatus = z.infer<typeof pushStatusSchema>

export const pushResultSchema = z.object({
  namespace: z.string(),
  key: z.string(),
  status: pushStatusSchema,
  seq: z.number(),
  hash: z.string(),
  missingBlobs: z.array(z.string()).optional().default([]),
  message: z.string().optional()
})
export type PushResult = z.infer<typeof pushResultSchema>

export const pushResponseSchema = z.object({
  storeId: z.string(),
  head: z.number(),
  results: z.array(pushResultSchema)
})
export type PushResponse = z.infer<typeof pushResponseSchema>

export const infoResponseSchema = z.object({
  protocol: z.number(),
  storeId: z.string(),
  head: z.number(),
  reapFloor: z.number(),
  serverTime: z.number()
})
export type InfoResponse = z.infer<typeof infoResponseSchema>

export const blobCheckResponseSchema = z.object({ missing: z.array(z.string()) })
export type BlobCheckResponse = z.infer<typeof blobCheckResponseSchema>

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  reapFloor: z.number().optional()
})
export type ApiError = z.infer<typeof apiErrorSchema>
