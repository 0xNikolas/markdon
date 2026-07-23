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
//
// fill="none" is also stamped onto every child shape explicitly (not just the
// root <svg>), rather than relying on inheritance. A consumer's own CSS can
// target the <svg> element and set `fill` there (e.g. Crepe's toolbar.css
// sets `.toolbar-item svg { fill: var(--crepe-color-outline) }` for its own
// built-in icons, which our raw-SVG toolbar overrides also match) — that
// beats the `fill="none"` presentation attribute on the same <svg> element,
// and the resolved color then inherits into every child. For an open
// (unclosed) <path> that's meant to render as a hollow stroke glyph, SVG's
// implicit-fill-closure rule fills the enclosed area with that inherited
// color, turning the icon into a solid blob. Declaring fill="none" on each
// child directly gives it its own specified value, which wins over
// inheritance from the ancestor regardless of what CSS does to the <svg>.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '../node_modules/lucide-static/icons')
const outDir = join(here, '../src/assets/icons')

// Only the glyphs consumed by the app (Header, SettingsModal, Sidebar). Keep
// names aligned with the brand design system.
const ICONS = [
  'app-window',
  'bold',
  'chevron-down',
  'chevron-right',
  'ellipsis',
  'file-code',
  'file-pen',
  'file-plus',
  'file-text',
  'file-up',
  'folder',
  'folder-open',
  'history',
  'image',
  'italic',
  'keyboard',
  'layout-grid',
  'moon',
  'link-2',
  'settings',
  'sun',
  'split-square-vertical',
  'x',
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
    .map((l) => {
      const trimmed = l.trim()
      if (!trimmed) return trimmed
      // Stamp fill="none" onto the shape itself — see the fill="none" comment
      // above for why this can't be left to inherit from the <svg> element.
      return `  ${trimmed.replace(/^<(\w+)/, '<$1 fill="none"')}`
    })
    .join('\n')
  return `${OPEN}\n${children}\n</svg>\n`
}

for (const name of ICONS) {
  const raw = readFileSync(join(srcDir, `${name}.svg`), 'utf8')
  writeFileSync(join(outDir, `${name}.svg`), normalize(raw))
}

console.log(`Vendored ${ICONS.length} icons from lucide-static into src/assets/icons/`)
