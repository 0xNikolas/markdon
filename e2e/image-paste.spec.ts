import { test, expect, type Page } from '@playwright/test'
import { seedWorkspace, gotoApp, treeRow, editor, calls } from './support/workspaceFixture.ts'

/**
 * Image paste-to-file (the c2d47cb production bug area): the Editor.svelte
 * uploader override must route a pasted image through save_pasted_image for a
 * saved doc, fall back to a session blob: URL on an untitled doc, and degrade
 * gracefully (banner + blob:) when the backend write fails.
 */

// 1x1 transparent PNG.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Dispatch a synthetic image paste on the ProseMirror surface (no text/html
 * entry, or Milkdown's upload plugin bails). */
async function pasteImage(page: Page): Promise<void> {
  await editor(page).evaluate(async (el, png) => {
    const blob = await (await fetch(png)).blob()
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'pasted.png', { type: 'image/png' }))
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, TINY_PNG)
}

const image = (page: Page) => page.locator('.milkdown-image-block img')

test('pasting into a saved doc writes next to it and renders via the asset protocol', async ({
  page,
}) => {
  await seedWorkspace(page)
  await gotoApp(page)
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText('hello notes')

  await pasteImage(page)

  await expect(image(page)).toHaveAttribute(
    'src',
    'asset://localhost//ws/notes-pasted-1.png',
    { timeout: 10_000 },
  )
  const saves = await calls(page, 'save_pasted_image')
  expect(saves).toHaveLength(1)
  expect(saves[0].args.docPath).toBe('/ws/notes.md')
  expect(saves[0].args.ext).toBe('png')
})

test('pasting into an untitled doc stays a session blob: URL, no backend write', async ({
  page,
}) => {
  await seedWorkspace(page)
  await gotoApp(page)
  await expect(editor(page)).toBeVisible() // boot doc is untitled

  await pasteImage(page)

  await expect(image(page)).toHaveAttribute('src', /^blob:/, { timeout: 10_000 })
  expect(await calls(page, 'save_pasted_image')).toHaveLength(0)
})

test('a failed backend write surfaces the error and falls back to blob:', async ({ page }) => {
  await seedWorkspace(page, { errors: { save_pasted_image: 'disk full (stub)' } })
  await gotoApp(page)
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText('hello notes')

  await pasteImage(page)

  await expect(page.locator('.banner[role="alert"]')).toContainText(
    'Could not save pasted image: disk full (stub)',
  )
  await expect(image(page)).toHaveAttribute('src', /^blob:/, { timeout: 10_000 })
})
