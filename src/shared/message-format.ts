export type MessageSegment = { type: 'text' | 'thought' | 'quote'; value: string }

const CLOSED_SEGMENT_PATTERN =
  /\*\*([\s\S]+?)\*\*|\*(?!\*)([\s\S]+?)(?<!\*)\*(?!\*)|"([^"]*)"/g

const OPEN_DELIMITER_PATTERN = /\*\*|\*(?!\*)|"/

/**
 * Parses roleplay message segments:
 * - *text* or **text** → thoughts
 * - "text" → quotes
 * - everything else → normal spoken text
 *
 * An unclosed trailing opener (*, **, or ") is styled immediately (for streaming).
 */
export const parseMessageSegments = (content: string): MessageSegment[] => {
  const segments: MessageSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  const pattern = new RegExp(CLOSED_SEGMENT_PATTERN.source, 'g')
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) })
    }

    if (match[3] !== undefined) {
      segments.push({ type: 'quote', value: match[3] })
    } else {
      segments.push({ type: 'thought', value: match[1] ?? match[2] ?? '' })
    }

    lastIndex = match.index + match[0].length
  }

  const remainder = content.slice(lastIndex)
  if (remainder) {
    const openMatch = remainder.match(OPEN_DELIMITER_PATTERN)
    if (openMatch && openMatch.index !== undefined) {
      const beforeOpen = remainder.slice(0, openMatch.index)
      if (beforeOpen) {
        segments.push({ type: 'text', value: beforeOpen })
      }
      const delimiter = openMatch[0]
      const openContent = remainder.slice(openMatch.index + delimiter.length)
      segments.push({ type: delimiter === '"' ? 'quote' : 'thought', value: openContent })
    } else {
      segments.push({ type: 'text', value: remainder })
    }
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: content }]
}
