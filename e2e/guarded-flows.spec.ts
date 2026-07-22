import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  openFilesStrip,
  editor,
  discardDialog,
  calls,
  emitTauri,
  makeDirty,
  pinFile,
} from './support/workspaceFixture.ts'

/**
 * Dirty-doc guard flows (App.svelte `guarded`): the discard-confirm modal's
 * three resolutions, the backdrop-dblclick pin upgrade, the Cmd+W scratch
 * fallback, and window-close cancel — all driven through the real modal DOM
 * and the stubbed menu/window events.
 */

const MARKER = 'edited-by-e2e'

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

/** Open notes.md and dirty its buffer (the edit itself pins the preview). */
async function openDirtyNotes(page: import('@playwright/test').Page) {
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText('hello notes')
  await makeDirty(page, MARKER)
  // promotePreviewOnEdit pinned the row — assert it so later exact-name
  // strip lookups can't race the promotion.
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
}

test('Cancel is non-destructive: buffer, active doc, and no read of the target', async ({
  page,
}) => {
  await openDirtyNotes(page)

  await treeRow(page, 'ideas.md').click()
  const dialog = discardDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(editor(page)).toContainText(MARKER)
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).not.toContain('/ws/ideas.md')
})

test("Don't Save discards and opens the target without writing", async ({ page }) => {
  await openDirtyNotes(page)

  await treeRow(page, 'ideas.md').click()
  await discardDialog(page).getByRole('button', { name: "Don't Save" }).click()

  await expect(editor(page)).toContainText('idea one')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  expect(await calls(page, 'write_file')).toHaveLength(0)
})

test('Save writes the dirty buffer, then continues to the target', async ({ page }) => {
  await openDirtyNotes(page)

  await treeRow(page, 'ideas.md').click()
  await discardDialog(page).getByRole('button', { name: 'Save', exact: true }).click()

  await expect(editor(page)).toContainText('idea one')
  const writes = await calls(page, 'write_file')
  expect(writes).toHaveLength(1)
  expect(writes[0].args.path).toBe('/ws/notes.md')
  expect(String(writes[0].args.contents)).toContain(MARKER)
})

test('tree dblclick racing the discard overlay still pins (backdrop upgrade)', async ({
  page,
}) => {
  await openDirtyNotes(page)

  // Click #1 opens the discard overlay; click #2 and the dblclick land on the
  // modal backdrop that mounted in between — onBackdropDblClick upgrades the
  // deferred preview to a pinned in-place open (d36d448 fix).
  await treeRow(page, 'ideas.md').dblclick()
  const dialog = discardDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: "Don't Save" }).click()

  await expect(editor(page)).toContainText('idea one')
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})

test('Cmd+W on a dirty untitled scratch lands on the last pinned tab, window survives', async ({
  page,
}) => {
  await pinFile(page, 'ideas.md')
  await expect(editor(page)).toContainText('idea one')

  await emitTauri(page, 'menu:new') // clean doc -> immediate scratch buffer
  await expect(page.locator('.filename')).toHaveText('Untitled')
  await makeDirty(page, MARKER)

  await emitTauri(page, 'menu:close_tab')
  await discardDialog(page).getByRole('button', { name: "Don't Save" }).click()

  await expect(editor(page)).toContainText('idea one')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // d36d448 fix: closing the scratch "tab" must NOT destroy the window while
  // pinned entries are still alive.
  expect(await calls(page, 'plugin:window|destroy')).toHaveLength(0)
})

test('window close request on a dirty doc: Cancel keeps the window alive', async ({ page }) => {
  await openDirtyNotes(page)

  await emitTauri(page, 'window:close-requested')
  const dialog = discardDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(editor(page)).toContainText(MARKER)
  expect(await calls(page, 'plugin:window|destroy')).toHaveLength(0)
})
