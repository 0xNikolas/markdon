<script lang="ts" module>
  import chevronDown from './assets/icons/chevron-down.svg?raw'
  import chevronRight from './assets/icons/chevron-right.svg?raw'
  import fileCode from './assets/icons/file-code.svg?raw'
  import filePen from './assets/icons/file-pen.svg?raw'
  import filePlus from './assets/icons/file-plus.svg?raw'
  import fileUp from './assets/icons/file-up.svg?raw'
  import folder from './assets/icons/folder.svg?raw'
  import keyboard from './assets/icons/keyboard.svg?raw'
  import layoutGrid from './assets/icons/layout-grid.svg?raw'
  import settings from './assets/icons/settings.svg?raw'
  import splitSquareVertical from './assets/icons/split-square-vertical.svg?raw'
  import xCircle from './assets/icons/x-circle.svg?raw'

  const icons = {
    'chevron-down': chevronDown,
    'chevron-right': chevronRight,
    'file-code': fileCode,
    'file-pen': filePen,
    'file-plus': filePlus,
    'file-up': fileUp,
    folder,
    keyboard,
    'layout-grid': layoutGrid,
    settings,
    'split-square-vertical': splitSquareVertical,
    'x-circle': xCircle,
  } as const

  export type IconName = keyof typeof icons
</script>

<script lang="ts">
  // Inline-SVG icon: the cleaned assets stroke with currentColor, so CSS
  // `color` on any ancestor recolors them per theme.
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
