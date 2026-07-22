import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'

/**
 * Production-bundle smoke test: boots the real `vite build` output in WebKit
 * with the browser-side Tauri stub, walks the seeded open-file pipeline, and
 * exercises the two things a dev/release divergence has actually broken
 * before — editor mount (schema self-check) and image paste.
 */

const DOC_PATH = '/e2e/hello.md'
const STUB = fileURLToPath(new URL('./support/tauriInternals.js', import.meta.url))

// 1x1 transparent PNG.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let pageErrors: Error[]

test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e))
  await page.addInitScript({ path: STUB })
  // Runs after the stub (init scripts run in order): seed the fake FS and
  // hand the app one opened file, as if the OS launched it with a document.
  await page.addInitScript((docPath) => {
    window.__TAURI_FS__ = { [docPath]: '# Hello smoke\n\nfixture body\n' }
    window.__TAURI_IPC_OVERRIDES__ = {
      take_opened_files: [{ path: docPath, readonly: false }],
    }
  }, DOC_PATH)
})

function editor(page: Page) {
  return page.locator('.editor [contenteditable="true"]')
}

test('production bundle boots, accepts typing, renders a pasted image', async ({ page }) => {
  await page.goto('/')

  // Crepe mounted its ProseMirror view inside Editor.svelte's .editor div.
  const pm = editor(page)
  await expect(pm).toBeVisible()

  // The seeded open-file pipeline ran end-to-end:
  // take_opened_files -> guarded openPath -> read_file -> openDoc -> editor.
  await expect(pm).toContainText('Hello smoke')

  // The schema self-check passed in this build: no error banner. (The
  // conflict/readonly bars use different classes, so no false match.)
  const errorBanner = page.locator('.banner[role="alert"]')
  await expect(errorBanner).toHaveCount(0)

  // Typing reaches the document.
  await pm.click()
  await page.keyboard.type('typed-by-smoke')
  await expect(pm).toContainText('typed-by-smoke')

  // Synthetic image paste. Milkdown's upload plugin handles it via
  // ProseMirror handlePaste reading event.clipboardData.files — it must carry
  // NO text/html entry, or the plugin bails. This drives the app's custom
  // uploader: save_pasted_image over IPC, bare relative name into the doc.
  await pm.evaluate(async (el, png) => {
    const blob = await (await fetch(png)).blob()
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'tiny.png', { type: 'image/png' }))
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, TINY_PNG)

  // The image node rendered through the full pipeline: uploader ->
  // save_pasted_image -> 'hello-pasted-1.png' -> proxyDomURL/resolveImageSrc
  // -> convertFileSrc.
  await expect(page.locator('.milkdown-image-block img')).toHaveAttribute(
    'src',
    'asset://localhost//e2e/hello-pasted-1.png',
    { timeout: 10_000 },
  )

  // The IPC call really carried the bytes.
  const saveCall = await page.evaluate(() =>
    window.__TAURI_IPC_CALLS__.find((c) => c.cmd === 'save_pasted_image'),
  )
  expect(saveCall).toBeDefined()
  expect(saveCall!.args.docPath).toBe(DOC_PATH)
  expect(saveCall!.args.ext).toBe('png')
  expect(typeof saveCall!.args.dataB64).toBe('string')
  expect((saveCall!.args.dataB64 as string).length).toBeGreaterThan(0)

  // Still no error banner, and nothing threw uncaught in the page.
  await expect(errorBanner).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
