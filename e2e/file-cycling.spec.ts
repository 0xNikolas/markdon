import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  openFilesStrip,
  editor,
  discardDialog,
  makeDirty,
  pinFile,
  treeRow,
  stripRows,
} from './support/workspaceFixture.ts'

/**
 * Ctrl+Tab file cycling: next/previous over the Open Files strip in ROW
 * ORDER (the italic preview row on top, then the pinned rows newest-first),
 * wrapping at either end — deliberately a simple visible-order cycle, not VS
 * Code's MRU picker. 'next' walks DOWN from the active row. The bracket chords
 * (Cmd+Shift+]/[ here — WebKit on macOS reports a mac platform) drive the same
 * cycle. Switches ride the buffer cache: instant, no prompt, dirty edits
 * intact.
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

/** Assert `name`'s strip row (pinned or preview) is the active one. */
async function expectActive(page: Page, name: string): Promise<void> {
  await expect(
    openFilesStrip(page).getByRole('button', { name: new RegExp(`^${name}( \\(preview\\))?$`) }),
  ).toHaveAttribute('aria-current', 'true')
}

/**
 * Pin the three fixture files, landing active on guide.md. With newest-first
 * ordering the strip reads top-to-bottom [guide, ideas, notes] (guide is the
 * last — most recent — pin, so it sits at the top and is active).
 */
async function pinThree(page: Page): Promise<void> {
  await pinFile(page, 'notes.md')
  await pinFile(page, 'ideas.md')
  await pinFile(page, 'guide.md')
}

test('Ctrl+Tab cycles forward (down the strip) in row order, wrapping', async ({ page }) => {
  await pinThree(page)
  await expectActive(page, 'guide.md') // top row

  await page.keyboard.press('Control+Tab') // step down
  await expectActive(page, 'ideas.md')

  await page.keyboard.press('Control+Tab')
  await expectActive(page, 'notes.md')
  await expect(editor(page)).toContainText('hello notes')

  await page.keyboard.press('Control+Tab') // wrap off the last row back to the top
  await expectActive(page, 'guide.md')
})

test('Ctrl+Shift+Tab cycles backward (up the strip), wrapping off the first row', async ({
  page,
}) => {
  await pinThree(page)

  await page.keyboard.press('Control+Shift+Tab') // wrap off the top row to the bottom
  await expectActive(page, 'notes.md')

  await page.keyboard.press('Control+Shift+Tab')
  await expectActive(page, 'ideas.md')

  await page.keyboard.press('Control+Shift+Tab')
  await expectActive(page, 'guide.md')
})

test('Cmd+Shift+] and Cmd+Shift+[ drive the same cycle', async ({ page }) => {
  await pinThree(page)

  await page.keyboard.press('Meta+Shift+BracketRight')
  await expectActive(page, 'ideas.md')

  await page.keyboard.press('Meta+Shift+BracketRight')
  await expectActive(page, 'notes.md')

  await page.keyboard.press('Meta+Shift+BracketLeft')
  await expectActive(page, 'ideas.md')
})

test('the preview row joins the cycle as the top row and STAYS a preview', async ({ page }) => {
  await pinFile(page, 'notes.md')
  await pinFile(page, 'ideas.md')
  // Single click = preview: the italic row renders at the TOP, above the pinned
  // ones (a preview is the most recent open). Strip: [guide(preview), ideas, notes].
  await treeRow(page, 'guide.md').click()
  await expectActive(page, 'guide.md')
  await expect(stripRows(page)).toHaveCount(3)

  // Forward from the top preview steps down to the first pinned row...
  await page.keyboard.press('Control+Tab')
  await expectActive(page, 'ideas.md')
  // ...and the preview row is still in the strip (cycling away never closed it).
  await expect(stripRows(page)).toHaveCount(3)

  // Backward steps straight back up onto the preview row — still a preview, not pinned.
  await page.keyboard.press('Control+Shift+Tab')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'guide.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(stripRows(page)).toHaveCount(3)
})

test('dirty edits survive a cycle away and back (buffer cache), with no prompt', async ({
  page,
}) => {
  const MARKER = 'edited-by-e2e'
  await pinFile(page, 'notes.md')
  await pinFile(page, 'ideas.md')
  await page.keyboard.press('Control+Tab') // back onto notes.md
  await expectActive(page, 'notes.md')
  await makeDirty(page, MARKER)

  await page.keyboard.press('Control+Tab')
  await expectActive(page, 'ideas.md')
  await expect(editor(page)).toContainText('idea one')
  await expect(discardDialog(page)).toHaveCount(0)

  await page.keyboard.press('Control+Tab')
  await expectActive(page, 'notes.md')
  await expect(editor(page)).toContainText(MARKER)
  await expect(page.locator('.badge.edited')).toBeVisible()
})

test('no-op with a single strip row: the only row stays active', async ({ page }) => {
  await pinFile(page, 'notes.md')
  await expect(stripRows(page)).toHaveCount(1)

  await page.keyboard.press('Control+Tab')
  await page.keyboard.press('Control+Shift+Tab')
  await page.keyboard.press('Meta+Shift+BracketRight')

  await expectActive(page, 'notes.md')
  await expect(stripRows(page)).toHaveCount(1)
  await expect(editor(page)).toContainText('hello notes')
})
