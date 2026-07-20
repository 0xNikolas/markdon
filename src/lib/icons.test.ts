import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression gate for the Figma icon cleanup pipeline: every committed icon
// must be a bare recolorable glyph — no frame/background rects, no hardcoded
// colors, strokes on currentColor, square viewBox, no fixed width/height.
const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '../assets/icons')

const EXPECTED = [
  'chevron-down.svg',
  'chevron-right.svg',
  'file-code.svg',
  'file-pen.svg',
  'file-plus.svg',
  'file-up.svg',
  'folder.svg',
  'keyboard.svg',
  'layout-grid.svg',
  'settings.svg',
  'split-square-vertical.svg',
  'x-circle.svg',
]

describe('icon assets', () => {
  it('contains exactly the 12 cleaned icons', () => {
    expect(readdirSync(iconsDir).filter((f) => f.endsWith('.svg')).sort()).toEqual(EXPECTED)
  })

  for (const file of EXPECTED) {
    it(`${file} is a cleaned recolorable glyph`, () => {
      const svg = readFileSync(join(iconsDir, file), 'utf8')
      // square viewBox, no exported width/height on the svg element
      expect(svg).toMatch(/^<svg viewBox="0 0 (10|12|14|16) (10|12|14|16)" fill="none"/)
      const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!
      expect(w).toBe(h)
      // no leftover frame/background/button rects (also bans clipPath rects)
      expect(svg).not.toContain('<rect')
      expect(svg).not.toContain('<g ')
      // no hardcoded colors: strokes only via currentColor, no hex fills
      expect(svg).not.toMatch(/fill="#/)
      expect(svg).not.toMatch(/stroke="(?!currentColor")/)
      expect(svg).toContain('stroke="currentColor"')
    })
  }
})
