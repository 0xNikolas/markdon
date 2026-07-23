import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  workspaceTree,
  openFilesStrip,
  stripRows,
  editor,
  calls,
  pinFile,
} from './support/workspaceFixture.ts'

/**
 * File-operations menu wiring: creation via NameModal, honest enablement,
 * the Open in New Tab/Window/Instance trio, delete semantics (confirm rules
 * + open-doc detach notice), cut/paste, and Close Folder.
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

function headerMenuButton(page: import('@playwright/test').Page) {
  return page.getByRole('button', { name: 'File operations' })
}

test('New File: NameModal preselects the stem, creates, and the tree refreshes', async ({
  page,
}) => {
  await headerMenuButton(page).click()
  await page.getByRole('menuitem', { name: 'New File' }).click()

  const input = page.locator('#name-modal-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('untitled.md')
  const selection = await input.evaluate((el: HTMLInputElement) => [
    el.selectionStart,
    el.selectionEnd,
  ])
  expect(selection).toEqual([0, 8]) // "untitled" preselected, ".md" kept

  await input.fill('new.md')
  await page.getByRole('button', { name: 'Create' }).click()

  // The row rendering proves refreshWorkspace re-listed the mutated tree.
  await expect(treeRow(page, 'new.md')).toBeVisible()
  const creates = await calls(page, 'create_file')
  expect(creates).toHaveLength(1)
  expect(creates[0].args).toEqual({ dir: '/ws', name: 'new.md' })
})

test('enablement is honest: non-markdown rows and an empty clipboard disable items', async ({
  page,
}) => {
  await treeRow(page, 'readme.txt').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Open in New Tab' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Open in New Window' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Open in New Instance' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Paste' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeEnabled()
  await page.keyboard.press('Escape')

  await treeRow(page, 'notes.md').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Open in New Tab' })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Open in New Window' })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Open in New Instance' })).toBeEnabled()
})

test('Open in New Tab pins in THIS window and never spawns', async ({ page }) => {
  await treeRow(page, 'notes.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in New Tab' }).click()

  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // notes.md landed PINNED, not previewed. (The unrelated boot auto-preview
  // keeps its own italic row — a pinned open doesn't evict other previews.)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true }),
  ).toHaveCount(0)
  await expect(editor(page)).toContainText('hello notes')
  expect(await calls(page, 'open_document_window')).toHaveLength(0)
})

test('Open in New Window / New Instance hand off without touching this window', async ({
  page,
}) => {
  await treeRow(page, 'notes.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in New Window' }).click()
  await expect
    .poll(async () => (await calls(page, 'open_document_window')).length)
    .toBe(1)
  expect((await calls(page, 'open_document_window'))[0].args).toEqual({
    path: '/ws/notes.md',
    readonly: false,
  })

  await treeRow(page, 'notes.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in New Instance' }).click()
  await expect
    .poll(async () => (await calls(page, 'open_file_new_instance')).length)
    .toBe(1)
  expect((await calls(page, 'open_file_new_instance'))[0].args).toEqual({
    path: '/ws/notes.md',
  })

  // The active doc never changed: the boot auto-preview is still the only
  // strip row (and still the active doc), and notes.md was never read here.
  await expect(stripRows(page)).toHaveCount(1)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'nested.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  expect((await calls(page, 'read_file')).map((c) => c.args.path)).not.toContain('/ws/notes.md')
})

test('Delete: single file goes straight to Trash, a folder asks first', async ({ page }) => {
  await treeRow(page, 'guide.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  // No confirm for a single file (recoverable, Finder-style).
  await expect(treeRow(page, 'guide.md')).toHaveCount(0)
  const deletes = await calls(page, 'delete_entries')
  expect(deletes).toHaveLength(1)
  expect(deletes[0].args).toEqual({ paths: ['/ws/guide.md'] })

  await treeRow(page, 'sub').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog').filter({ hasText: 'to the Trash?' })
  await expect(confirm).toContainText('Move sub to the Trash?')
  await confirm.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(treeRow(page, 'sub')).toHaveCount(0)
})

test('deleting the open file detaches it with a notice and drops its strip row', async ({
  page,
}) => {
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText('hello notes')

  await treeRow(page, 'notes.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()

  await expect(page.locator('.banner[role="status"]')).toContainText(
    'moved to Trash — it is now an unsaved document',
  )
  await expect(stripRows(page)).toHaveCount(0)
  await expect(treeRow(page, 'notes.md')).toHaveCount(0)
  // The buffer itself survives the detach (nothing on screen is lost).
  await expect(editor(page)).toContainText('hello notes')
})

test('Cut dims the row; Paste moves it into the focused folder and clears the cut', async ({
  page,
}) => {
  const notes = treeRow(page, 'notes.md')
  await notes.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cut' }).click()
  await expect(notes).toHaveClass(/cut/)

  const sub = treeRow(page, 'sub')
  await sub.click() // focus anchor for Paste (also collapses the folder)
  await headerMenuButton(page).click()
  await page.getByRole('menuitem', { name: 'Paste' }).click()

  await expect(treeRow(page, 'notes.md')).toHaveCount(0) // gone from the root level
  const moves = await calls(page, 'move_entry')
  expect(moves).toHaveLength(1)
  expect(moves[0].args).toEqual({ src: '/ws/notes.md', destDir: '/ws/sub' })

  await sub.click() // expand: the moved row is inside
  await expect(treeRow(page, 'notes.md')).toBeVisible()
  await expect(workspaceTree(page).locator('.cut')).toHaveCount(0)
})

test('Close Folder keeps the open document and its strip row', async ({ page }) => {
  await pinFile(page, 'notes.md')
  await expect(editor(page)).toContainText('hello notes')

  await headerMenuButton(page).click()
  await page.getByRole('menuitem', { name: 'Close Folder' }).click()

  const closes = await calls(page, 'close_workspace')
  expect(closes).toHaveLength(1)
  expect(closes[0].args).toEqual({ root: '/ws' })
  // Tree replaced by the quiet Open Folder row (a doc is still open)…
  await expect(workspaceTree(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open Folder…' })).toBeVisible()
  // …and the Open Files strip survives (VS Code behavior).
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})
