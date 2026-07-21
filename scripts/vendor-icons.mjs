// Vendor the icon set from lucide-static (ISC) into src/assets/icons/ as
// committed, recolorable glyphs consumed via Icon.svelte's `?raw` pipeline.
//
// Why vendor instead of runtime-importing lucide-static: we only ship the
// handful of glyphs actually consumed (YAGNI, no dead assets, no whole-package
// bundle). Re-run `bun run vendor:icons` to refresh after bumping the dep.
//
// Normalisation strips lucide's `class`, `width`, and `height` attributes so
// the svg has no fixed pixel size — Icon.svelte sizes it via CSS width/height,
// and the 24x24 viewBox makes lucide's 2px stroke scale to ~1.2-1.3px at our
// 14-16px render sizes (the fix for the too-thick Figma exports).
//
// currentColor recoloring: lucide sets stroke="currentColor" + fill="none" on
// the svg element, so every child inherits it and CSS `color` on any ancestor
// recolors the glyph per theme.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../node_modules/lucide-static/icons')
const outDir = join(here, '../src/assets/icons')

// Only the glyphs consumed by the app (Header, SettingsModal, Sidebar). Keep
// names aligned with the brand design system.
const ICONS = [
  'bold',
  'chevron-down',
  'chevron-right',
  'file-code',
  'file-pen',
  'file-plus',
  'file-text',
  'file-up',
  'folder',
  'folder-open',
  'italic',
  'keyboard',
  'layout-grid',
  'link-2',
  'settings',
  'split-square-vertical',
]

// Stable single-line opening tag (viewBox first) — no fixed width/height, no
// lucide class, no license comment (attribution lives in README.md).
const OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
  ' stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">'

function normalize(raw) {
  const inner = raw
    .replace(/<!--[\s\S]*?-->/g, '') // drop the license comment
    .replace(/<svg[\s\S]*?>/, '') // drop lucide's svg opening tag
    .replace(/<\/svg>/, '')
    .trim()
  const children = inner
    .split('\n')
    .map((l) => `  ${l.trim()}`)
    .join('\n')
  return `${OPEN}\n${children}\n</svg>\n`
}

for (const name of ICONS) {
  const raw = readFileSync(join(srcDir, `${name}.svg`), 'utf8')
  writeFileSync(join(outDir, `${name}.svg`), normalize(raw))
}

console.log(`Vendored ${ICONS.length} icons from lucide-static into src/assets/icons/`)
