import { describe, expect, it } from 'vitest'
import {
  CODE_PREVIEW_MAX_BYTES,
  extToLang,
  isCodeExt,
  langForExt,
  previewExt,
} from './codeLang'
import { MD_PREVIEW_MAX_BYTES } from './textPreview'
import { QUARTO_EXTENSIONS, QUARTO_LANGUAGE_ID } from '../monaco/quartoLanguage'

describe('code preview routing', () => {
  it('routes Quarto / R Markdown through the quarto language', () => {
    for (const ext of ['qmd', 'rmd', 'rmarkdown']) {
      expect(isCodeExt(ext)).toBe(true)
      expect(langForExt(ext)).toBe(QUARTO_LANGUAGE_ID)
    }
    for (const ext of QUARTO_EXTENSIONS) {
      expect(extToLang[ext.replace(/^\./, '').toLowerCase()]).toBe(QUARTO_LANGUAGE_ID)
    }
  })

  it('does not claim types handled by other frames', () => {
    for (const ext of ['pdf', 'html', 'csv', 'md', 'png', 'ipynb']) {
      expect(isCodeExt(ext)).toBe(false)
    }
  })

  it('derives the routing extension from the basename', () => {
    expect(previewExt('/a/b/main.RS')).toBe('rs')
    expect(previewExt('/home/u/.Rprofile')).toBe('rprofile')
    expect(previewExt('/x/Dockerfile')).toBe('dockerfile')
    expect(langForExt(previewExt('/x/Dockerfile'))).toBe('dockerfile')
    expect(langForExt('zzz')).toBe('plaintext')
  })

  it('starts at the same cap as markdown', () => {
    expect(CODE_PREVIEW_MAX_BYTES).toBe(MD_PREVIEW_MAX_BYTES)
  })
})
