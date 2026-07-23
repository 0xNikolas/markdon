import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  openFilesStrip,
  editor,
  discardDialog,
  calls,
  makeDirty,
  pinFile,
  switchTo,
} from './support/workspaceFixture.ts'

/**
 * The buffer cache proper: dirty buffers survive tab switches without a
 * prompt or a write, external changes to a CACHED file surface on restore
 * through the ordinary classifier (conflict bar when dirty, silent adopt when
 * clean), background dirtiness is visible as a strip-row dot, and
 * cursor/scroll restore round-trips (split/source mode, via the status bar).
 */

const MARKER = 'edited-by-e2e'

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

/** Overwrite a seeded file's on-disk (stub FS) content out from under the app. */
function mutateDisk(page: import('@playwright/test').Page, path: string, contents: string) {
  return page.evaluate(
    ([p, c]) => {
      ;(window.__TAURI_FS__ ||= {})[p] = c
    },
    [path, contents] as const,
  )
}

test('dirty buffer round-trips a switch: no dialog, no write, edits and badge restored', async ({
  page,
}) => {
  await pinFile(page, 'notes.md')
  await makeDirty(page, MARKER)

  await switchTo(page, 'ideas.md')
  await expect(editor(page)).toContainText('idea one')
  await expect(discardDialog(page)).toHaveCount(0)

  await switchTo(page, 'notes.md')
  await expect(editor(page)).toContainText(MARKER)
  await expect(page.locator('.badge.edited')).toBeVisible()
  expect(await calls(page, 'write_file')).toHaveLength(0)
})

test('external change to a DIRTY cached file: conflict bar on switch-back, buffer kept', async ({
  page,
}) => {
  await pinFile(page, 'notes.md')
  await makeDirty(page, MARKER)
  await switchTo(page, 'ideas.md')
  await expect(editor(page)).toContainText('idea one')

  await mutateDisk(page, '/ws/notes.md', '# Notes\n\nchanged externally\n')

  // The restore is instant (stashed buffer, MARKER intact); the background
  // reconcile then sees dirty-vs-changed and raises the conflict bar.
  await switchTo(page, 'notes.md')
  await expect(editor(page)).toContainText(MARKER)
  const bar = page.locator('.reload-bar')
  await expect(bar).toBeVisible()

  // "Keep mine" dismisses without touching the buffer or disk.
  await bar.getByRole('button', { name: 'Keep mine' }).click()
  await expect(bar).toHaveCount(0)
  await expect(editor(page)).toContainText(MARKER)
  expect(await calls(page, 'write_file')).toHaveLength(0)
})

test('external change to a CLEAN cached file: silently adopted on switch-back', async ({
  page,
}) => {
  await pinFile(page, 'notes.md')
  await switchTo(page, 'ideas.md')
  await expect(editor(page)).toContainText('idea one')

  await mutateDisk(page, '/ws/notes.md', '# Notes\n\nchanged externally\n')

  await switchTo(page, 'notes.md')
  await expect(editor(page)).toContainText('changed externally')
  await expect(page.locator('.reload-bar')).toHaveCount(0)
  await expect(page.locator('.badge.edited')).toHaveCount(0)
})

test('a dirty background row shows the dirty dot; restoring clears it', async ({ page }) => {
  await pinFile(page, 'notes.md')
  await makeDirty(page, MARKER)
  await switchTo(page, 'ideas.md')

  const notesRow = openFilesStrip(page).locator('.open-file-row').filter({ hasText: 'notes.md' })
  await expect(notesRow.locator('.dirty-dot')).toBeVisible()
  // The clean ideas.md rows never show one.
  await expect(
    openFilesStrip(page)
      .locator('.open-file-row')
      .filter({ hasText: 'ideas.md' })
      .locator('.dirty-dot'),
  ).toHaveCount(0)

  // Switching back consumes the cache entry — the buffer is live again and
  // its dirtiness is the Header badge's job, not the dot's.
  await switchTo(page, 'notes.md')
  await expect(notesRow.locator('.dirty-dot')).toHaveCount(0)
})

test('cursor position round-trips a switch in split (source) mode', async ({ page }) => {
  await pinFile(page, 'notes.md')
  await page.getByRole('button', { name: 'Split Preview' }).click()
  const cm = page.locator('.cm-content')
  await expect(cm).toBeVisible()

  // Park the caret on the body line and read the status bar's Ln/Col.
  await page.locator('.cm-line', { hasText: 'hello notes' }).click()
  await page.keyboard.press('End')
  const lnCol = page.getByText(/^Ln \d+, Col \d+$/)
  await expect(lnCol).toHaveText(/Col (?!0\b)\d+/) // a real, non-zero column
  const stashed = await lnCol.textContent()

  await switchTo(page, 'ideas.md')
  await expect(page.locator('.cm-content')).toContainText('idea one')

  await switchTo(page, 'notes.md')
  await expect(page.locator('.cm-content')).toContainText('hello notes')
  await expect(page.getByText(/^Ln \d+, Col \d+$/)).toHaveText(stashed!)
})
