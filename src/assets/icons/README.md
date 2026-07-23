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

`app-window`, `bold`, `chevron-down`, `chevron-right`, `ellipsis`,
`file-code`, `file-pen`, `file-plus`, `file-text`, `file-up`, `folder`,
`folder-open`, `history`, `image`, `italic`, `keyboard`, `layout-grid`,
`link-2`, `moon`, `settings`, `split-square-vertical`, `sun`, `x`.

`ellipsis` is the sidebar "File operations" more-actions button (opens
`FileOpsMenu.svelte`).

`app-window` is the Settings modal's General tab (task 21, open-destination
preference). `x` is the sidebar's Open Files list close affordance.

Sidebar file-type mapping (`src/lib/workspace.ts`'s `fileIcon`): markdown
files get `file-code` (matches the design's Icon Set), image files get
`image`, and every other file shown for context gets the generic `file-text`
so it doesn't read as code. Folder rows swap `folder` / `folder-open` on
expand via `folderIcon`. `moon` / `sun` are the header light/dark toggle;
`history` is the File History affordance.

`bold` / `italic` / `link-2` are the brand Icon Set's formatting glyphs; they
override the Crepe selection toolbar's built-in bold/italic/link icons (see
`src/Editor.svelte`, wired via `Crepe`'s `featureConfigs`) rather than going
through `src/Icon.svelte` — the toolbar consumes each as a raw SVG string
(`?raw` import) instead of an `<Icon name>` component instance.

To add one: append its lucide name to the `ICONS` array in
`scripts/vendor-icons.mjs`, re-run `bun run vendor:icons`, wire it into its
consumer (`src/Icon.svelte` for inline UI glyphs, or a raw `?raw` import for
library-level overrides like the Crepe toolbar), and extend `EXPECTED` in
`src/lib/icons.test.ts`. Do not vendor glyphs nothing consumes (YAGNI — no
dead assets).

## Brand-identity icon set — reserved for future markdown actions

The brand-identity Figma page (Icon Set section 04) defines a toolbar glyph set
for markdown-editing actions. `bold`, `italic`, and `link-2` are now shipped
(see above — they override the Crepe selection toolbar's icons). The
remaining glyphs below have no current UI counterpart; vendor them when their
actions are built (all confirmed present in `lucide-static`):

| Design action        | Lucide name                     |
| -------------------- | ------------------------------- |
| Heading              | `heading`                       |
| List                 | `list`                          |
| Preview / visibility | `eye`                           |
| Open external        | `arrow-up-right-from-square` / `square-arrow-out-up-right` |
| Type / outline       | `type-outline`                  |

These are intentionally **not** shipped yet (nothing consumes them).
