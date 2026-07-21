import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression gate for the vendored lucide-static icon set: every committed icon
// must be a bare recolorable lucide glyph — a 24x24 viewBox (so lucide's 2px
// stroke scales down correctly at our 14-16px sizes), no fixed pixel
// width/height, no hardcoded colors, stroke via currentColor, fill none.
const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '../assets/icons')

const EXPECTED = [
  'bold.svg',
  'chevron-down.svg',
  'chevron-right.svg',
  'file-code.svg',
  'file-pen.svg',
  'file-plus.svg',
  'file-text.svg',
  'file-up.svg',
  'folder-open.svg',
  'folder.svg',
  'italic.svg',
  'keyboard.svg',
  'layout-grid.svg',
  'link-2.svg',
  'settings.svg',
  'split-square-vertical.svg',
]

describe('icon assets', () => {
  it('contains exactly the vendored lucide glyphs', () => {
    expect(readdirSync(iconsDir).filter((f) => f.endsWith('.svg')).sort()).toEqual(EXPECTED)
  })

  for (const file of EXPECTED) {
    it(`${file} is a recolorable 24px lucide glyph`, () => {
      const svg = readFileSync(join(iconsDir, file), 'utf8')
      // lucide's calibrated 24x24 viewBox — the source of the correct stroke weight
      expect(svg).toMatch(/^<svg viewBox="0 0 24 24"/)
      // no fixed pixel size on the svg element (Icon.svelte sizes it via CSS)
      expect(svg).not.toMatch(/<svg[^>]*\swidth="/)
      expect(svg).not.toMatch(/<svg[^>]*\sheight="/)
      // recolorable: stroke via currentColor, transparent fill, no hardcoded hex
      expect(svg).toContain('fill="none"')
      expect(svg).toContain('stroke="currentColor"')
      expect(svg).not.toMatch(/fill="#/)
      expect(svg).not.toMatch(/stroke="(?!currentColor")/)
      // no leftover lucide class attribute
      expect(svg).not.toContain('class=')
    })
  }
})
