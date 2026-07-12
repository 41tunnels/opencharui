const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes === 0) return '0 B'

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1
  )
  const value = bytes / 1024 ** exponent
  const formatted = value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)
  return `${formatted} ${BYTE_UNITS[exponent]}`
}

export const estimateTimeRemaining = (
  completed: number,
  total: number,
  startedAt: number,
  now = Date.now()
): string | null => {
  if (completed <= 0 || total <= completed) return null

  const elapsedMs = now - startedAt
  if (elapsedMs <= 0) return null

  const rate = completed / elapsedMs
  const remainingMs = (total - completed) / rate
  const seconds = Math.max(1, Math.round(remainingMs / 1000))

  if (seconds < 60) return `~${seconds} sec remaining`

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `~${minutes} min remaining`

  const hours = Math.round(minutes / 60)
  return `~${hours} hr remaining`
}
