const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type PngTextChunk = {
  keyword: string
  text: string
}

const readUint32Be = (bytes: Uint8Array, offset: number): number => {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

export const isPngBuffer = (bytes: Uint8Array): boolean => {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

const decodeBase64ToUtf8 = (value: string): string => {
  const binary = atob(value.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

const decodeCardPayload = (text: string): unknown => {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('Character card PNG is missing embedded data')
  }

  try {
    return JSON.parse(decodeBase64ToUtf8(trimmed))
  } catch {
    return JSON.parse(trimmed)
  }
}

const inflateZtxtPayload = async (compressed: Uint8Array): Promise<string> => {
  if (compressed.length < 6) {
    throw new Error('Invalid compressed character card chunk')
  }

  const rawDeflate = compressed.subarray(2, compressed.length - 4)
  const stream = new Blob([Uint8Array.from(rawDeflate)]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  return new TextDecoder('utf-8').decode(buffer)
}

const readNullTerminatedAscii = (
  bytes: Uint8Array,
  offset: number
): { value: string; nextOffset: number } => {
  let end = offset
  while (end < bytes.length && bytes[end] !== 0) {
    end++
  }
  const value = new TextDecoder('latin1').decode(bytes.subarray(offset, end))
  return { value, nextOffset: end + 1 }
}

const parseTextChunkData = (data: Uint8Array): PngTextChunk => {
  const { value: keyword, nextOffset } = readNullTerminatedAscii(data, 0)
  const text = new TextDecoder('utf-8').decode(data.subarray(nextOffset))
  return { keyword, text }
}

const parseZtxtChunkData = async (data: Uint8Array): Promise<PngTextChunk> => {
  const { value: keyword, nextOffset } = readNullTerminatedAscii(data, 0)
  const compressionMethod = data[nextOffset]
  if (compressionMethod !== 0) {
    throw new Error(`Unsupported PNG compression method: ${compressionMethod}`)
  }

  const text = await inflateZtxtPayload(data.subarray(nextOffset + 1))
  return { keyword, text }
}

const parseItxtChunkData = (data: Uint8Array): PngTextChunk => {
  const { value: keyword, nextOffset: afterKeyword } = readNullTerminatedAscii(data, 0)
  const compressionFlag = data[afterKeyword]
  const compressionMethod = data[afterKeyword + 1]
  let offset = afterKeyword + 2

  const readField = (): string => {
    const { value, nextOffset } = readNullTerminatedAscii(data, offset)
    offset = nextOffset
    return value
  }

  readField()
  readField()

  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      throw new Error(`Unsupported PNG compression method: ${compressionMethod}`)
    }
    throw new Error('Compressed iTXt character card chunks are not supported')
  }

  const text = new TextDecoder('utf-8').decode(data.subarray(offset))
  return { keyword, text }
}

export const readPngTextChunks = async (bytes: Uint8Array): Promise<PngTextChunk[]> => {
  if (!isPngBuffer(bytes)) {
    throw new Error('File is not a valid PNG image')
  }

  const chunks: PngTextChunk[] = []
  let offset = PNG_SIGNATURE.length

  while (offset + 8 <= bytes.length) {
    const length = readUint32Be(bytes, offset)
    const type = new TextDecoder('ascii').decode(bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length

    if (dataEnd + 4 > bytes.length) {
      throw new Error('Invalid PNG structure')
    }

    const data = bytes.subarray(dataStart, dataEnd)

    if (type === 'tEXt') {
      chunks.push(parseTextChunkData(data))
    } else if (type === 'zTXt') {
      chunks.push(await parseZtxtChunkData(data))
    } else if (type === 'iTXt') {
      chunks.push(parseItxtChunkData(data))
    } else if (type === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  return chunks
}

const pickCharacterCardChunk = (chunks: PngTextChunk[]): PngTextChunk | null => {
  const ccv3 = chunks.find((chunk) => chunk.keyword === 'ccv3')
  if (ccv3) return ccv3

  const chara = chunks.find((chunk) => chunk.keyword === 'chara')
  return chara ?? null
}

export const extractCharacterCardJsonFromPng = async (bytes: Uint8Array): Promise<unknown> => {
  const chunks = await readPngTextChunks(bytes)
  const cardChunk = pickCharacterCardChunk(chunks)

  if (!cardChunk) {
    throw new Error('PNG does not contain a character card (missing chara or ccv3 metadata)')
  }

  return decodeCardPayload(cardChunk.text)
}

export const pngBufferToDataUrl = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return `data:image/png;base64,${btoa(binary)}`
}
