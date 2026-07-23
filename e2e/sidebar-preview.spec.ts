import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  openFilesStrip,
  stripRows,
  editor,
  calls,
  makeDirty,
  pinFile,
} from './support/workspaceFixture.ts'

/**
 * Preview-tab vs pin semantics (VS Code model): a tree single click parks the
 * file in the single italic preview slot; dblclick / Enter / editing pins it
 * into the Open Files list. Covers the d36d448 close-active-preview neighbour
 * fix as well.
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

test('single-click previews, and a second preview replaces the first', async ({ page }) => {
  await treeRow(page, 'notes.md').click()

  const rows = stripRows(page)
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveClass(/preview/)
  const previewBtn = openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true })
  await expect(previewBtn).toHaveAttribute('aria-current', 'true')
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).toContain('/ws/notes.md')

  // VS Code slot semantics: the next single click REPLACES the preview.
  await treeRow(page, 'ideas.md').click()
  await expect(rows).toHaveCount(1)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})

test('dblclick pins: the preview row converts to a pinned one', async ({ page }) => {
  await pinFile(page, 'guide.md')
  await expect(stripRows(page)).toHaveCount(1)
  await expect(stripRows(page).first()).not.toHaveClass(/preview/)

  // Preview notes.md next to the pinned row, then dblclick it: the italic row
  // converts to pinned too (pinOpen vacates the preview slot).
  await treeRow(page, 'notes.md').click()
  await expect(stripRows(page)).toHaveCount(2)
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(1)
  await treeRow(page, 'notes.md').dblclick()
  await expect(stripRows(page)).toHaveCount(2)
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})

test('editing the buffer promotes the preview to a pinned row', async ({ page }) => {
  await treeRow(page, 'notes.md').click()
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(1)
  await expect(editor(page)).toContainText('hello notes')

  await makeDirty(page)

  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})

test('Enter on the active preview row pins it (keyboard promotion)', async ({ page }) => {
  await treeRow(page, 'notes.md').click()
  const previewBtn = openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true })
  await expect(previewBtn).toHaveAttribute('aria-current', 'true')

  await previewBtn.focus()
  await page.keyboard.press('Enter')

  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})

test('closing the active preview lands on the last pinned neighbour, not a blank doc', async ({
  page,
}) => {
  await pinFile(page, 'ideas.md')
  await treeRow(page, 'notes.md').click() // preview, active (ideas.md stashes)
  await expect(editor(page)).toContainText('hello notes')

  const previewRow = openFilesStrip(page).locator('.open-file-row.preview')
  await previewRow.hover()
  await previewRow.getByRole('button', { name: 'Close notes.md (preview)', exact: true }).click()

  // d36d448 fix: the preview renders as the LAST row, so its close neighbour
  // is the last pinned entry. With the buffer cache the neighbour restores
  // from its stashed buffer (a background disk reconcile follows) — asserting
  // the restored CONTENT decouples this from reconcile timing.
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(editor(page)).toContainText('idea one')
  await expect(previewRow).toHaveCount(0)
})
