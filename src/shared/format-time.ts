/** Formats a timestamp as relative time in the user's locale (e.g. "5 minutes ago"). */
export const formatRelativeTime = (timestamp: number, now = Date.now()): string => {
  const secondsAgo = Math.round((now - timestamp) / 1000)

  if (secondsAgo < 45) return 'just now'

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' })

  const minutesAgo = Math.round(secondsAgo / 60)
  if (minutesAgo < 60) return rtf.format(-minutesAgo, 'minute')

  const hoursAgo = Math.round(minutesAgo / 60)
  if (hoursAgo < 24) return rtf.format(-hoursAgo, 'hour')

  const daysAgo = Math.round(hoursAgo / 24)
  if (daysAgo < 7) return rtf.format(-daysAgo, 'day')

  const weeksAgo = Math.round(daysAgo / 7)
  if (weeksAgo < 5) return rtf.format(-weeksAgo, 'week')

  const monthsAgo = Math.round(daysAgo / 30)
  if (monthsAgo < 12) return rtf.format(-monthsAgo, 'month')

  const yearsAgo = Math.round(daysAgo / 365)
  return rtf.format(-yearsAgo, 'year')
}
