import { describe, expect, it } from 'vitest'
import { isSameOriginPopout, popoutUrl } from './popout'

describe('popout url', () => {
  it('builds the shell url under the Vite base', () => {
    expect(popoutUrl('/neo/')).toBe('/neo/popout.html')
    expect(popoutUrl('/neo')).toBe('/neo/popout.html')
    expect(popoutUrl('/')).toBe('/popout.html')
  })

  it('only accepts same-origin popouts', () => {
    const origin = 'https://hub.example:3000'
    expect(isSameOriginPopout('/neo/popout.html', origin)).toBe(true)
    expect(isSameOriginPopout('https://hub.example:3000/neo/popout.html', origin)).toBe(true)
    expect(isSameOriginPopout('https://evil.example/neo/popout.html', origin)).toBe(false)
    expect(isSameOriginPopout('http://hub.example:3000/neo/popout.html', origin)).toBe(false)
  })
})
