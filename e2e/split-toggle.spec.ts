import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  openFilesStrip,
  editor,
} from './support/workspaceFixture.ts'

/**
 * Split Preview toggle: WYSIWYG <-> CodeMirror round trip with the edit
 * preserved, source-edit preview promotion, the long-line freeze guard
 * (c2d47cb bug area 1), and the stale-FindBar force close.
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

function splitButton(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: 'Split Preview' })
}

test('round trip: split mounts CodeMirror + live preview, edits survive the switch back', async ({
  page,
}) => {
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText('hello notes')

  await splitButton(page).click()
  await expect(splitButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.cm-editor')).toBeVisible()
  await expect(page.locator('.pane.preview')).toContainText('hello notes')
  // The WYSIWYG editor is unmounted (only the read-only preview — itself
  // Milkdown-rendered — and the CodeMirror source remain editors on screen).
  await expect(editor(page)).toHaveCount(0)
  // The toggle persisted (per-context localStorage; fresh per test).
  expect(await page.evaluate(() => localStorage.getItem('markdon.split'))).toBe('true')

  // CodeMirror edits flow into the live preview…
  await page.locator('.cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' splitedit')
  await expect(page.locator('.pane.preview')).toContainText('splitedit')

  // …and back into the WYSIWYG editor on toggle-off.
  await splitButton(page).click()
  await expect(splitButton(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.cm-editor')).toHaveCount(0)
  await expect(editor(page)).toContainText('splitedit')
})

test('a source edit promotes a previewed doc to a pinned row', async ({ page }) => {
  await treeRow(page, 'ideas.md').click() // preview
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(1)
  await expect(editor(page)).toContainText('idea one')

  await splitButton(page).click()
  await page.locator('.cm-content').click()
  await page.keyboard.type('promoted')

  // CodeMirror is byte-accurate (no adoptNormalization dance): the first
  // keystroke dirties the doc and pins the preview.
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})

test('long-line guard: split refuses to mount CodeMirror, preview stays live', async ({
  page,
}) => {
  await treeRow(page, 'huge.md').click()
  await expect(editor(page)).toContainText('Huge')

  await splitButton(page).click()
  await expect(page.getByRole('heading', { name: 'Source view unavailable' })).toBeVisible()
  await expect(page.locator('.source-fallback')).toContainText('line over 100,000 characters')
  await expect(page.locator('.cm-editor')).toHaveCount(0) // the WebKit freeze guard
  await expect(page.locator('.pane.preview')).toContainText('Huge')

  // Only CodeMirror is guarded: toggling off restores the WYSIWYG editor.
  await splitButton(page).click()
  await expect(editor(page)).toBeVisible()
})

test('entering split force-closes a stale WYSIWYG FindBar', async ({ page }) => {
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText('hello notes')

  await page.keyboard.press('Control+f')
  await expect(page.getByRole('search')).toBeVisible()

  await splitButton(page).click()
  // Entering split unmounts the WYSIWYG editor; a FindBar left open would be a
  // permanently unresponsive overlay (shouldForceCloseFind).
  await expect(page.getByRole('search')).toHaveCount(0)
  await expect(page.locator('.cm-editor')).toBeVisible()
})
