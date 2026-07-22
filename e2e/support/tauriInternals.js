// Browser-side Tauri IPC stub: installs the `window.__TAURI_INTERNALS__`
// surface that the production bundle's @tauri-apps/api dereferences at
// runtime, so the REAL `vite build` output boots in a plain browser. Same
// philosophy as src/lib/test-support/tauriMocks.ts (stub the IPC boundary,
// run the real frontend), moved from vi.mock'd modules to the window global.
// A dependency-free classic script (no imports/exports) so it loads both via
// Playwright's `page.addInitScript({ path })` and as a side-effect script in
// a future component-test suite.
//
// PARITY DISCIPLINE (deliberate, not flakiness): any app command this stub
// doesn't know REJECTS. A new startup IPC call added to the app breaks the
// smoke test loudly until it gets an explicit default in the table below —
// exactly the dev/release divergence this suite exists to catch.
//
// Test hooks (readable/seedable from specs; overrides via a later init script):
//   window.__TAURI_IPC_CALLS__      every { cmd, args } the bundle invoked
//   window.__TAURI_FS__             path -> contents backing `read_file`
//   window.__TAURI_IPC_OVERRIDES__  cmd -> static resolved value (wins over
//                                   the built-in table; values, not functions,
//                                   so they serialize through addInitScript)
//   window.__tauriEmit(event, payload)  fire registered event listeners
//                                   (drives listenScoped menu events later)
;(() => {
  if (window.__TAURI_INTERNALS__) return

  let nextCallbackId = 1
  const callbacks = new Map()

  let nextEventId = 1
  /** event name -> Map<eventId, callbackId> */
  const listeners = new Map()

  window.__TAURI_IPC_CALLS__ = []

  // Defaults for every app command the boot + smoke flow invokes, shaped like
  // the Rust handlers' replies (see src-tauri/src/lib.rs / fileops).
  const commands = {
    take_window_file: () => null,
    take_opened_files: () => [],
    take_startup_workspace: () => ({ workspace: null, suppress_restore: false }),
    restore_workspace: () => null,
    set_readonly_menu_state: () => null,
    watch_file: () => null,
    unwatch: () => null,
    record_history: () => null,
    read_file: (args) => {
      const fs = window.__TAURI_FS__ || {}
      if (typeof fs[args.path] !== 'string') {
        throw new Error('[tauri-stub] no such file: ' + args.path)
      }
      return fs[args.path]
    },
    // Mirrors fileops::save_pasted_image's contract: writes
    // `<doc stem>-pasted-<n>.<ext>` next to the doc and returns the BARE
    // relative name (always -1 here; the stub never persists anything).
    save_pasted_image: (args) => {
      const base = args.docPath.slice(args.docPath.lastIndexOf('/') + 1)
      const stem = base.replace(/\.[^.]*$/, '')
      return stem + '-pasted-1.' + args.ext
    },
  }

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
      windows: [{ label: 'main' }],
      webviews: [{ label: 'main' }],
    },
    plugins: { path: { sep: '/', delimiter: ':' } },
    transformCallback(callback, once = false) {
      const id = nextCallbackId++
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id)
        callback(payload)
      })
      return id
    },
    unregisterCallback(id) {
      callbacks.delete(id)
    },
    convertFileSrc(path, protocol = 'asset') {
      // Same shape as tauriMocks' convertFileSrc / macOS asset protocol.
      return protocol + '://localhost/' + path
    },
    async invoke(cmd, args = {}) {
      window.__TAURI_IPC_CALLS__.push({ cmd, args })
      const overrides = window.__TAURI_IPC_OVERRIDES__
      if (overrides && cmd in overrides) return overrides[cmd]
      if (cmd === 'plugin:event|listen') {
        const eventId = nextEventId++
        if (!listeners.has(args.event)) listeners.set(args.event, new Map())
        listeners.get(args.event).set(eventId, args.handler)
        return eventId
      }
      if (cmd === 'plugin:event|unlisten') {
        const regs = listeners.get(args.event)
        if (regs) regs.delete(args.eventId)
        return null
      }
      // Remaining plugin surface the bundle touches is fire-and-forget
      // (plugin:log|log, plugin:window|set_theme / set_title): absorb it.
      if (cmd.startsWith('plugin:')) return null
      const handler = commands[cmd]
      if (!handler) throw new Error('[tauri-stub] unhandled command: ' + cmd)
      return handler(args)
    },
  }

  window.__tauriEmit = (event, payload) => {
    const regs = listeners.get(event)
    if (!regs) return
    for (const [eventId, callbackId] of regs) {
      const cb = callbacks.get(callbackId)
      if (cb) cb({ event, id: eventId, payload })
    }
  }
})()
