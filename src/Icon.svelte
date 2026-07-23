<script lang="ts" module>
  import appWindow from './assets/icons/app-window.svg?raw'
  import chevronDown from './assets/icons/chevron-down.svg?raw'
  import chevronRight from './assets/icons/chevron-right.svg?raw'
  import ellipsis from './assets/icons/ellipsis.svg?raw'
  import fileCode from './assets/icons/file-code.svg?raw'
  import filePen from './assets/icons/file-pen.svg?raw'
  import filePlus from './assets/icons/file-plus.svg?raw'
  import fileText from './assets/icons/file-text.svg?raw'
  import fileUp from './assets/icons/file-up.svg?raw'
  import folder from './assets/icons/folder.svg?raw'
  import folderOpen from './assets/icons/folder-open.svg?raw'
  import history from './assets/icons/history.svg?raw'
  import keyboard from './assets/icons/keyboard.svg?raw'
  import layoutGrid from './assets/icons/layout-grid.svg?raw'
  import moon from './assets/icons/moon.svg?raw'
  import settings from './assets/icons/settings.svg?raw'
  import sun from './assets/icons/sun.svg?raw'
  import splitSquareVertical from './assets/icons/split-square-vertical.svg?raw'
  import x from './assets/icons/x.svg?raw'

  const icons = {
    'app-window': appWindow,
    'chevron-down': chevronDown,
    'chevron-right': chevronRight,
    ellipsis,
    'file-code': fileCode,
    'file-pen': filePen,
    'file-plus': filePlus,
    'file-text': fileText,
    'file-up': fileUp,
    folder,
    'folder-open': folderOpen,
    history,
    keyboard,
    'layout-grid': layoutGrid,
    moon,
    settings,
    sun,
    'split-square-vertical': splitSquareVertical,
    x,
  } as const

  export type IconName = keyof typeof icons
</script>

<script lang="ts">
  // Inline-SVG icon: assets are vendored lucide-static glyphs (ISC — see
  // assets/icons/README.md) that stroke with currentColor, so CSS `color` on
  // any ancestor recolors them per theme. Each glyph has a 24x24 viewBox and no
  // fixed width/height, so the CSS below scales it to `size` px while lucide's
  // 2px stroke renders as the intended ~1.2-1.3px at our 14-16px sizes.
  interface Props {
    name: IconName
    size?: number
  }
  let { name, size = 14 }: Props = $props()
</script>

<span class="icon" style="width:{size}px;height:{size}px" aria-hidden="true">
  {@html icons[name]}
</span>

<style>
  .icon {
    display: inline-flex;
    flex-shrink: 0;
  }
  .icon :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
