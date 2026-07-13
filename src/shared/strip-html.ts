const BLOCK_BREAK = /<\/?(?:p|div|h[1-6]|li|tr)(?:\s[^>]*)?>/gi
const LINE_BREAK = /<br\s*\/?>/gi
const TAG = /<[^>]+>/g

export const stripHtml = (value: string): string => {
  if (!/[<&]/.test(value)) {
    return value.trim()
  }

  let text = value.replace(LINE_BREAK, '\n').replace(BLOCK_BREAK, '\n')

  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    text = doc.body.textContent ?? ''
  } else {
    text = text.replace(TAG, '')
  }

  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
