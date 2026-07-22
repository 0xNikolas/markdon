import { vi } from 'vitest'

/**
 * Shared Tauri mocks, loaded globally via vitest.config.ts's `setupFiles`.
 * Most test files need `@tauri-apps/api/core`'s `invoke` and/or a stub for
 * `@tauri-apps/api/window` (several modules under test call
 * `getCurrentWindow()` at import time, e.g. for `onFocusChanged`) — this
 * covers the common case so a new test file doesn't need to repeat either
 * `vi.mock` boilerplate.
 *
 * `invoke` is exported so a test can drive it directly (`invoke.mockResolvedValue(...)`)
 * without needing its own `vi.mock('@tauri-apps/api/core', ...)`.
 *
 * A test file that needs different behavior — a stateful window label
 * (windowing.test.ts), event listeners, etc. — declares its OWN `vi.mock` for
 * that specifier as usual; per-file `vi.mock` calls override this file's
 * (verified by windowing.test.ts, which stubs `@tauri-apps/api/window`
 * itself and still gets its own factory, not this one).
 */
export const invoke = vi.fn()

/**
 * `convertFileSrc` mirrors the real macOS/Linux shape (`asset://localhost/`
 * + the path) closely enough for imagePaste.test.ts to assert on, and is
 * exported as a spy so tests can also assert what path it was handed.
 */
export const convertFileSrc = vi.fn((path: string) => `asset://localhost/${path}`)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  convertFileSrc: (path: string) => convertFileSrc(path),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}))
