import { defineConfig, devices } from '@playwright/test'

// Smoke-tests the REAL production bundle: the webServer builds dist/ via
// `vite build` and serves it with `vite preview` — never the dev server, so
// dev/release divergence (tree-shaken plugins, prod-only minification) is what
// gets exercised. WebKit only: the shipped app runs in WKWebView. A future
// component-test suite adds its own entry to `projects` and reuses this
// webServer plus e2e/support/tauriInternals.js.
export default defineConfig({
  testDir: 'e2e',
  webServer: {
    command: 'bun run build && bunx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    // Local runs keep a warm preview server between invocations (mind that a
    // stale one serves a stale dist/); CI always builds fresh.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // covers the cold vite build
  },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
})
