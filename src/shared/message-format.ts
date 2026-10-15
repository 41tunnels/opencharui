export type MessageSegment = { type: 'text' | 'thought' | 'quote' | 'instruction'; value: string }

// `{` only counts when it is a single brace, so `{{char}}` / `{{user}}`
// macros left in a message never read as an instruction.
const SINGLE_OPEN_BRACE = '(?<!\\{)\\{(?!\\{)'

const CLOSED_SEGMENT_PATTERN = new RegExp(
  [
    /\*\*([\s\S]+?)\*\*/.source,
    /\*(?!\*)([\s\S]+?)(?<!\*)\*(?!\*)/.source,
    /"([^"]*)"/.source,
    `(\\[[^\\[\\]]*\\]|${SINGLE_OPEN_BRACE}[^{}]*\\}(?!\\}))`
  ].join('|'),
  'g'
)

const OPEN_DELIMITER_PATTERN = new RegExp(`\\*\\*|\\*(?!\\*)|"|\\[|${SINGLE_OPEN_BRACE}`)

/**
 * Parses roleplay message segments:
 * - *text* or **text** → thoughts
 * - "text" → quotes
 * - [text] or {text} → instructions (delimiters kept in the value)
 * - everything else → normal spoken text
 *
 * An unclosed trailing opener (*, **, ", [ or {) is styled immediately (for streaming).
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

    if (match[4] !== undefined) {
      segments.push({ type: 'instruction', value: match[4] })
    } else if (match[3] !== undefined) {
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
      if (delimiter === '[' || delimiter === '{') {
        segments.push({ type: 'instruction', value: remainder.slice(openMatch.index) })
      } else {
        const openContent = remainder.slice(openMatch.index + delimiter.length)
        segments.push({ type: delimiter === '"' ? 'quote' : 'thought', value: openContent })
      }
    } else {
      segments.push({ type: 'text', value: remainder })
    }
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: content }]
}
