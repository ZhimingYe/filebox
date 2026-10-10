import { describe, expect, it } from 'vitest'
import { MD_PREVIEW_MAX_BYTES, formatBytes, trimToLastLine } from './textPreview'

describe('text preview helpers', () => {
  it('trims a partial trailing line', () => {
    expect(trimToLastLine('a\nb\nc')).toBe('a\nb\n')
    expect(trimToLastLine('no newline')).toBe('no newline')
  })
  it('caps markdown well below the 5 MB text cap', () => {
    expect(MD_PREVIEW_MAX_BYTES).toBeLessThan(5 * 1024 * 1024)
  })
  it('formats sizes', () => {
    expect(formatBytes(8_388_700)).toBe('8.0 MB')
    expect(formatBytes(262144)).toBe('256 KB')
  })
})
