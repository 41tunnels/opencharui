import { describe, expect, it } from 'vitest'
import { parseMessageSegments } from '../../src/shared/message-format'

describe('parseMessageSegments', () => {
  it('keeps existing thought and quote parsing', () => {
    expect(parseMessageSegments('Hi *waves* "hello"')).toEqual([
      { type: 'text', value: 'Hi ' },
      { type: 'thought', value: 'waves' },
      { type: 'text', value: ' ' },
      { type: 'quote', value: 'hello' }
    ])
  })

  it('marks [] and {} as instructions with delimiters kept', () => {
    expect(parseMessageSegments('a [OOC: slow down] b {aside}')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'instruction', value: '[OOC: slow down]' },
      { type: 'text', value: ' b ' },
      { type: 'instruction', value: '{aside}' }
    ])
  })

  it('leaves {{macros}} alone', () => {
    expect(parseMessageSegments('Hello {{user}}, I am {{char}}.')).toEqual([
      { type: 'text', value: 'Hello {{user}}, I am {{char}}.' }
    ])
  })

  it('styles an unclosed [ or { while streaming', () => {
    expect(parseMessageSegments('ok [System: be')).toEqual([
      { type: 'text', value: 'ok ' },
      { type: 'instruction', value: '[System: be' }
    ])
    expect(parseMessageSegments('ok {no')).toEqual([
      { type: 'text', value: 'ok ' },
      { type: 'instruction', value: '{no' }
    ])
    expect(parseMessageSegments('ok {{us')).toEqual([{ type: 'text', value: 'ok {{us' }])
  })

  it('does not split a bracket inside a thought', () => {
    expect(parseMessageSegments('*thinks [quietly]*')).toEqual([
      { type: 'thought', value: 'thinks [quietly]' }
    ])
  })
})
