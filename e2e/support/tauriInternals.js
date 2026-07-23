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
//   window.__TAURI_FS__             path -> contents backing `read_file` and
//                                   the fileops mutations below
//   window.__TAURI_DIRS__           extra (possibly empty) directory paths the
//                                   workspace tree derivation must include
//   window.__TAURI_WORKSPACE_ROOT__ when set, restore_workspace/list_workspace
//                                   derive a live Workspace tree from the two
//                                   maps above (unset -> no workspace, as before)
//   window.__TAURI_RECENT__         roots served by list_recent_workspaces
//                                   (unset -> empty; the Recent section hides)
//   window.__TAURI_IPC_ERRORS__     cmd -> message; invoke REJECTS with the raw
//                                   string, mirroring how Rust command errors
//                                   arrive (checked before overrides)
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

  // -- in-memory FS + workspace-tree derivation (fileops parity) --------------

  // Mirrors fileops.rs's no-clobber gate VERBATIM: performRename surfaces this
  // string in the error banner, and the rename-collision spec asserts it.
  const NO_CLOBBER = 'a file or folder with that name already exists'

  const fsMap = () => (window.__TAURI_FS__ ||= {})
  const dirList = () => (window.__TAURI_DIRS__ ||= [])
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1)
  const parentDir = (p) => p.slice(0, p.lastIndexOf('/'))
  const isUnder = (p, ancestor) => p === ancestor || p.startsWith(ancestor + '/')

  /** True when `path` exists as a file, a dir, or a prefix of either. */
  function entryExists(path) {
    if (Object.prototype.hasOwnProperty.call(fsMap(), path)) return true
    return (
      Object.keys(fsMap()).some((k) => k.startsWith(path + '/')) ||
      dirList().some((d) => isUnder(d, path))
    )
  }

  /** Move (or copy) a file/dir subtree — the shared engine behind rename/move/copy. */
  function transplant(oldPath, newPath, keepOriginal) {
    const fs = fsMap()
    for (const k of Object.keys(fs)) {
      if (!isUnder(k, oldPath)) continue
      fs[newPath + k.slice(oldPath.length)] = fs[k]
      if (!keepOriginal) delete fs[k]
    }
    const mapped = dirList().map((d) =>
      isUnder(d, oldPath) ? newPath + d.slice(oldPath.length) : d,
    )
    window.__TAURI_DIRS__ = keepOriginal
      ? [...new Set([...dirList(), ...mapped])]
      : mapped
  }

  function removeSubtree(path) {
    const fs = fsMap()
    for (const k of Object.keys(fs)) if (isUnder(k, path)) delete fs[k]
    window.__TAURI_DIRS__ = dirList().filter((d) => !isUnder(d, path))
  }

  /** Derive a Rust-shaped Workspace {root, tree} from the in-memory maps. */
  function buildWorkspace(root) {
    const node = (path) => ({
      name: baseName(path),
      path,
      dirs: [],
      files: [],
      truncated: false,
    })
    const rootNode = node(root)
    const byPath = new Map([[root, rootNode]])
    const ensureDir = (path) => {
      const existing = byPath.get(path)
      if (existing) return existing
      const n = node(path)
      ensureDir(parentDir(path)).dirs.push(n)
      byPath.set(path, n)
      return n
    }
    for (const d of dirList()) if (d.startsWith(root + '/')) ensureDir(d)
    for (const p of Object.keys(fsMap())) {
      if (!p.startsWith(root + '/')) continue
      ensureDir(parentDir(p)).files.push({ name: baseName(p), path: p })
    }
    const sortTree = (n) => {
      n.dirs.sort((a, b) => a.name.localeCompare(b.name))
      n.files.sort((a, b) => a.name.localeCompare(b.name))
      n.dirs.forEach(sortTree)
    }
    sortTree(rootNode)
    return { root, tree: rootNode }
  }

  // Defaults for every app command the boot + spec flows invoke, shaped like
  // the Rust handlers' replies (see src-tauri/src/lib.rs / fileops).
  const commands = {
    take_window_file: () => null,
    take_opened_files: () => [],
    take_startup_workspace: () => ({ workspace: null, suppress_restore: false }),
    restore_workspace: () => {
      const root = window.__TAURI_WORKSPACE_ROOT__
      return root ? buildWorkspace(root) : null
    },
    list_workspace: (args) => buildWorkspace(args.root),
    close_workspace: () => null,
    // Default: "nothing to adopt here" (specs override to return a Workspace
    // or assert the spawn-a-new-instance null path via the call log).
    open_recent_workspace: () => null,
    // Empty page's Recent section: seed roots via __TAURI_RECENT__ (default:
    // no recents, the section stays hidden).
    list_recent_workspaces: () => window.__TAURI_RECENT__ || [],
    set_readonly_menu_state: () => null,
    // Log-only, like the windowing hand-offs: the call log IS the assertion
    // surface (revealing a file in Finder has no browser-visible effect).
    reveal_log_file: () => null,
    watch_file: () => null,
    unwatch: () => null,
    watch_workspace: () => null,
    unwatch_workspace: () => null,
    record_history: () => null,
    list_history: () => [],
    load_prefs: () => null,
    save_prefs: () => null,
    // Windowing hand-offs: log-only (the call log IS the assertion surface).
    open_document_window: () => null,
    open_file_new_instance: () => null,
    pick_folder_new_instance: () => null,
    read_file: (args) => {
      const fs = window.__TAURI_FS__ || {}
      if (typeof fs[args.path] !== 'string') {
        throw new Error('[tauri-stub] no such file: ' + args.path)
      }
      return fs[args.path]
    },
    write_file: (args) => {
      fsMap()[args.path] = args.contents
      return null
    },
    // Fileops mutations: mirror src-tauri/src/fileops.rs semantics against the
    // in-memory maps; collisions reject with the exact Rust no-clobber string
    // (a bare string, like a real Rust command error — NOT an Error object).
    create_file: (args) => {
      const p = args.dir + '/' + args.name
      if (entryExists(p)) throw NO_CLOBBER
      fsMap()[p] = ''
      return p
    },
    create_folder: (args) => {
      const p = args.dir + '/' + args.name
      if (entryExists(p)) throw NO_CLOBBER
      dirList().push(p)
      return p
    },
    rename_entry: (args) => {
      const p = parentDir(args.path) + '/' + args.newName
      if (entryExists(p)) throw NO_CLOBBER
      transplant(args.path, p, false)
      return p
    },
    move_entry: (args) => {
      const p = args.destDir + '/' + baseName(args.src)
      if (p === args.src) return p
      if (entryExists(p)) throw NO_CLOBBER
      transplant(args.src, p, false)
      return p
    },
    copy_entry: (args) => {
      const p = args.destDir + '/' + baseName(args.src)
      if (entryExists(p)) throw NO_CLOBBER
      transplant(args.src, p, true)
      return p
    },
    duplicate_entry: (args) => {
      const base = baseName(args.path)
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      const dir = parentDir(args.path)
      for (let n = 1; ; n++) {
        const p = dir + '/' + stem + ' copy' + (n === 1 ? '' : ' ' + n) + ext
        if (!entryExists(p)) {
          transplant(args.path, p, true)
          return p
        }
      }
    },
    delete_entries: (args) => {
      for (const p of args.paths) removeSubtree(p)
      return null
    },
    // Mirrors commands::resolve_image_asset: resolve a doc-relative image ref
    // against the doc's parent dir (string normalization stands in for
    // canonicalize) and reject anything escaping that dir with a bare string,
    // like the Rust command. Returns the resolved absolute path.
    resolve_image_asset: (args) => {
      const dir = parentDir(args.docPath)
      const segs = dir.split('/').filter((s) => s !== '')
      for (const seg of args.rel.split('/')) {
        if (seg === '' || seg === '.') continue
        if (seg === '..') segs.pop()
        else segs.push(seg)
      }
      const resolved = '/' + segs.join('/')
      if (!resolved.startsWith(dir + '/') || resolved === dir) {
        throw "image path does not resolve inside the document's directory"
      }
      return resolved
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
      // Forced failures win over everything: rejects with the RAW string, the
      // shape a Rust command error reaches the frontend in.
      const errors = window.__TAURI_IPC_ERRORS__
      if (errors && cmd in errors) throw errors[cmd]
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
