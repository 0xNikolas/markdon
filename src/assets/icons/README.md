# Icon assets

These SVGs are vendored from [Lucide](https://lucide.dev) via the
`lucide-static` npm package (a `devDependency`) and committed here so the app
ships only the glyphs it actually uses — no runtime import of the full package.

## License

Lucide is **ISC-licensed** (Copyright © Lucide Icons and Contributors); a subset
of icons is additionally MIT (derived from Feather, © Cole Bemis). Both permit
redistribution with attribution. Full text: `node_modules/lucide-static/LICENSE`.

## How to regenerate

```
bun run vendor:icons   # scripts/vendor-icons.mjs
```

The script copies each named glyph, strips lucide's `class`/`width`/`height`
attributes and license comment, and rewrites a single-line `<svg>` opening tag.
The 24×24 viewBox is kept: lucide's 2px stroke is calibrated for 24px, so at our
14–16px render sizes it scales to the intended ~1.2–1.3px (the fix for the old
Figma exports, which carried `stroke-width="2"` on 14–16px viewBoxes → ~2× too
heavy). `src/lib/icons.test.ts` is the regression gate for this contract.

## Currently vendored (consumed by the UI)

`chevron-down`, `chevron-right`, `file-code`, `file-pen`, `file-plus`,
`file-text`, `file-up`, `folder`, `folder-open`, `keyboard`, `layout-grid`,
`settings`, `split-square-vertical`.

Sidebar file-type mapping (`src/lib/workspace.ts`'s `fileIcon`): markdown
files get `file-code` (matches the design's Icon Set); every other file
shown for context gets the generic `file-text` so it doesn't read as code.
Folder rows swap `folder` / `folder-open` on expand via `folderIcon`.

To add one: append its lucide name to the `ICONS` array in
`scripts/vendor-icons.mjs`, re-run `bun run vendor:icons`, add the import +
entry in `src/Icon.svelte`, and extend `EXPECTED` in `src/lib/icons.test.ts`.
Do not vendor glyphs nothing consumes (YAGNI — no dead assets).

## Brand-identity icon set — reserved for future markdown actions

The brand-identity Figma page (Icon Set section 04) defines a toolbar glyph set
for future markdown-editing actions. When those actions are built, vendor the
matching lucide names below (all confirmed present in `lucide-static`):

| Design action        | Lucide name                     |
| -------------------- | ------------------------------- |
| Bold                 | `bold`                          |
| Italic               | `italic`                        |
| Link                 | `link-2`                        |
| Heading              | `heading`                       |
| List                 | `list`                          |
| Preview / visibility | `eye`                           |
| Open external        | `arrow-up-right-from-square` / `square-arrow-out-up-right` |
| Type / outline       | `type-outline`                  |

These are intentionally **not** shipped yet (nothing consumes them).
