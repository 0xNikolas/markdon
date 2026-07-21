<script lang="ts">
  import { onMount } from 'svelte'
  import { getVersion } from '@tauri-apps/api/app'
  import Icon from './Icon.svelte'
  import { closeSettings } from './lib/ui'
  import { settings, updateSetting, type Settings } from './lib/settings'
  import { APP_SHORTCUTS } from './lib/shortcuts'
  import { focusTrap } from './lib/focusTrap'

  type TabId = 'editor' | 'appearance' | 'export' | 'shortcuts'
  const TABS: { id: TabId; label: string; icon: 'file-pen' | 'layout-grid' | 'file-up' | 'keyboard' }[] = [
    { id: 'editor', label: 'Editor', icon: 'file-pen' },
    { id: 'appearance', label: 'Appearance', icon: 'layout-grid' },
    { id: 'export', label: 'Export Options', icon: 'file-up' },
    { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  ]

  let activeTab = $state<TabId>('editor')
  let version = $state('')
  let tabRefs: (HTMLButtonElement | undefined)[] = []

  onMount(() => {
    getVersion().then((v) => (version = v))
  })

  function selectTab(id: TabId) {
    activeTab = id
  }

  // Roving-focus arrow navigation across the tablist (wraps both directions).
  function onTablistKeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = TABS.findIndex((t) => t.id === activeTab)
    const next = e.key === 'ArrowDown' ? (i + 1) % TABS.length : (i - 1 + TABS.length) % TABS.length
    activeTab = TABS[next].id
    tabRefs[next]?.focus()
  }

  // Esc on the dialog element (not window): stops propagation so the find
  // bar's window-level Esc handler doesn't also fire.
  function onDialogKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSettings()
    }
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) closeSettings()
  }

  const FONT_FAMILIES: { value: Settings['fontFamily']; label: string }[] = [
    { value: 'geist', label: 'Geist' },
    { value: 'geist-mono', label: 'Geist Mono' },
    { value: 'system', label: 'System' },
  ]
  const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18]
  const LINE_HEIGHTS = [1.4, 1.5, 1.6, 1.7, 1.8]
  const THEMES: { value: Settings['theme']; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ]
  const EXPORT_FORMATS: { value: Settings['exportFormat']; label: string }[] = [
    { value: 'html', label: 'HTML' },
    { value: 'md', label: 'Markdown' },
  ]
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- Backdrop click-to-close (design decision); Esc is the keyboard path,
     handled on the dialog element below. -->
<div class="backdrop" onclick={onBackdropClick}>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    tabindex="-1"
    use:focusTrap
    onkeydown={onDialogKeydown}
  >
    <aside class="sidebar">
      <div class="badge-row">
        <span class="chip">m&gt;<span class="caret"></span></span>
        <div class="badge-text">
          <span class="pref-label">Preferences</span>
          <span class="version">v{version}</span>
        </div>
      </div>
      <div
        class="tablist"
        role="tablist"
        aria-orientation="vertical"
        tabindex="-1"
        onkeydown={onTablistKeydown}
      >
        {#each TABS as tab, i (tab.id)}
          <button
            bind:this={tabRefs[i]}
            role="tab"
            id="tab-{tab.id}"
            aria-selected={activeTab === tab.id}
            aria-controls="panel-{tab.id}"
            tabindex={activeTab === tab.id ? 0 : -1}
            class="tab-row"
            class:active={activeTab === tab.id}
            onclick={() => selectTab(tab.id)}
          >
            <Icon name={tab.icon} size={16} />
            <span>{tab.label}</span>
          </button>
        {/each}
      </div>
    </aside>

    <div class="content">
      <div class="content-header">
        <h2 id="settings-title">Preferences</h2>
        <button class="close" aria-label="Close settings" onclick={closeSettings}>
          <Icon name="x-circle" size={12} />
        </button>
      </div>

      {#if activeTab === 'editor'}
        <div id="panel-editor" role="tabpanel" aria-labelledby="tab-editor" class="panel">
          <section class="section">
            <h3>Typography</h3>
            <div class="field-row">
              <span class="label">Font Family</span>
              <div class="selector">
                <select
                  value={$settings.fontFamily}
                  onchange={(e) => updateSetting('fontFamily', e.currentTarget.value as Settings['fontFamily'])}
                >
                  {#each FONT_FAMILIES as f (f.value)}
                    <option value={f.value}>{f.label}</option>
                  {/each}
                </select>
                <span class="chev"><Icon name="chevron-down" size={10} /></span>
              </div>
            </div>
            <div class="field-row">
              <span class="label">Font Size</span>
              <div class="selector">
                <select
                  value={$settings.fontSize}
                  onchange={(e) => updateSetting('fontSize', Number(e.currentTarget.value))}
                >
                  {#each FONT_SIZES as size (size)}
                    <option value={size}>{size}px</option>
                  {/each}
                </select>
                <span class="chev"><Icon name="chevron-down" size={10} /></span>
              </div>
            </div>
            <div class="field-row">
              <span class="label">Line Height</span>
              <div class="selector">
                <select
                  value={$settings.lineHeight}
                  onchange={(e) => updateSetting('lineHeight', Number(e.currentTarget.value))}
                >
                  {#each LINE_HEIGHTS as lh (lh)}
                    <option value={lh}>{lh}</option>
                  {/each}
                </select>
                <span class="chev"><Icon name="chevron-down" size={10} /></span>
              </div>
            </div>
          </section>

          <section class="section">
            <h3>Formatting &amp; Rendering</h3>
            <div class="field-row">
              <span class="label">Soft Wrap</span>
              <button
                role="switch"
                aria-checked={$settings.softWrap}
                aria-label="Soft wrap"
                class="toggle"
                onclick={() => updateSetting('softWrap', !$settings.softWrap)}
              >
                <span class="thumb"></span>
              </button>
            </div>
            <div class="field-row">
              <span class="label">Tab Width</span>
              <div class="selector">
                <select
                  value={$settings.tabWidth}
                  onchange={(e) => updateSetting('tabWidth', Number(e.currentTarget.value) as 2 | 4)}
                >
                  <option value="2">2 spaces</option>
                  <option value="4">4 spaces</option>
                </select>
                <span class="chev"><Icon name="chevron-down" size={10} /></span>
              </div>
            </div>
            <div class="field-row">
              <span class="label">Auto-close Brackets</span>
              <button
                role="switch"
                aria-checked={$settings.autoCloseBrackets}
                aria-label="Auto-close brackets"
                class="toggle"
                onclick={() => updateSetting('autoCloseBrackets', !$settings.autoCloseBrackets)}
              >
                <span class="thumb"></span>
              </button>
            </div>
          </section>
        </div>
      {:else if activeTab === 'appearance'}
        <div id="panel-appearance" role="tabpanel" aria-labelledby="tab-appearance" class="panel">
          <section class="section">
            <h3>Theme</h3>
            <div class="field-row">
              <span class="label">Appearance</span>
              <div class="selector">
                <select
                  value={$settings.theme}
                  onchange={(e) => updateSetting('theme', e.currentTarget.value as Settings['theme'])}
                >
                  {#each THEMES as t (t.value)}
                    <option value={t.value}>{t.label}</option>
                  {/each}
                </select>
                <span class="chev"><Icon name="chevron-down" size={10} /></span>
              </div>
            </div>
          </section>
        </div>
      {:else if activeTab === 'export'}
        <div id="panel-export" role="tabpanel" aria-labelledby="tab-export" class="panel">
          <section class="section">
            <h3>Export</h3>
            <div class="field-row">
              <span class="label">Default Export Format</span>
              <div class="selector">
                <select
                  value={$settings.exportFormat}
                  onchange={(e) => updateSetting('exportFormat', e.currentTarget.value as Settings['exportFormat'])}
                >
                  {#each EXPORT_FORMATS as f (f.value)}
                    <option value={f.value}>{f.label}</option>
                  {/each}
                </select>
                <span class="chev"><Icon name="chevron-down" size={10} /></span>
              </div>
            </div>
          </section>
        </div>
      {:else}
        <div id="panel-shortcuts" role="tabpanel" aria-labelledby="tab-shortcuts" class="panel">
          <section class="section shortcuts">
            <h3>Keyboard Shortcuts</h3>
            {#each APP_SHORTCUTS as s (s.label)}
              <div class="shortcut-row">
                <span class="label">{s.label}</span>
                <span class="keys">
                  {#each s.keys as key (key)}
                    <kbd>{key}</kbd>
                  {/each}
                </span>
              </div>
            {/each}
          </section>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    display: flex;
    width: 820px;
    height: 520px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 40px);
    border-radius: 16px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .sidebar {
    width: 220px;
    flex-shrink: 0;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface-sunken);
    border-right: 1px solid var(--border);
  }
  .badge-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #0f1729;
    color: #ffffff;
    border-radius: 4px;
    padding: 4px 8px;
    font: 700 13px var(--font-mono);
    line-height: 1;
    flex-shrink: 0;
  }
  .caret {
    width: 4px;
    height: 14px;
    background: var(--accent);
    border-radius: 1px;
  }
  .badge-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .pref-label {
    font: 700 13px var(--font-ui);
    color: var(--fg-strong);
  }
  .version {
    font: 400 10px var(--font-mono);
    color: var(--fg-muted);
  }

  .tablist {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tab-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-radius: 6px;
    background: transparent;
    border: none;
    color: var(--fg-secondary);
    font: 600 13px var(--font-ui);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .tab-row:hover {
    background: var(--surface-hover);
    color: var(--fg-strong);
  }
  .tab-row:active {
    background: var(--surface-active);
  }
  .tab-row.active {
    background: var(--surface);
    color: var(--fg-strong);
  }
  .tab-row.active:hover {
    background: var(--surface-hover);
  }
  .tab-row.active:active {
    background: var(--surface-active);
  }

  .content {
    flex: 1;
    min-width: 0;
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    overflow-y: auto;
  }
  .content-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .content-header h2 {
    margin: 0;
    font: 700 23px var(--font-ui);
    color: var(--fg-strong);
  }
  .close {
    width: 28px;
    height: 28px;
    padding: 8px;
    border-radius: 9999px;
    background: var(--surface);
    border: none;
    color: var(--fg-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .close:hover {
    background: var(--surface-hover);
    color: var(--fg-strong);
  }
  .close:active {
    background: var(--surface-active);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .section.shortcuts {
    gap: 8px;
  }
  .section h3 {
    margin: 0;
    font: 700 11px var(--font-ui);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .field-row .label {
    font: 500 13px var(--font-ui);
    color: var(--fg);
  }

  .selector {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .selector select {
    appearance: none;
    -webkit-appearance: none;
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 6px;
    padding: 6px 26px 6px 12px;
    font: 600 12px var(--font-ui);
    color: var(--fg-strong);
    cursor: pointer;
    transition: background-color 0.1s ease;
  }
  .selector select:hover {
    background: var(--surface-hover);
  }
  .selector select:active {
    background: var(--surface-active);
  }
  .selector .chev {
    position: absolute;
    right: 10px;
    pointer-events: none;
    color: var(--fg-strong);
    display: inline-flex;
  }

  .toggle {
    width: 40px;
    height: 20px;
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--surface-border);
    position: relative;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }
  .toggle:hover {
    background: var(--surface-hover);
  }
  .toggle:active {
    background: var(--surface-active);
  }
  .toggle[aria-checked='true'] {
    background: var(--accent);
    border-color: transparent;
  }
  .toggle[aria-checked='true']:hover {
    background: var(--accent-hover);
  }
  .toggle[aria-checked='true']:active {
    background: var(--accent-active);
  }
  .toggle .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }
  .toggle[aria-checked='true'] .thumb {
    transform: translateX(20px);
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .shortcut-row .label {
    font: 400 13px var(--font-ui);
    color: var(--fg);
  }
  .shortcut-row .keys {
    display: flex;
    gap: 4px;
  }
  .shortcut-row kbd {
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 4px;
    padding: 3px 6px;
    font: 600 11px var(--font-mono);
    color: var(--fg-secondary);
  }
</style>
