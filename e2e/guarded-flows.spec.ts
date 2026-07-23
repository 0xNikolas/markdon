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
  closeStripRow,
} from './support/workspaceFixture.ts'

/**
 * Dirty-doc guard flows under the buffer cache (App.svelte `guarded` /
 * `switchGuarded`): switching between pathed docs stashes and NEVER prompts;
 * the discard-confirm modal survives only where a buffer is actually
 * destroyed — closing a tab, closing the window, and switching away from a
 * dirty untitled scratch — all driven through the real modal DOM and the
 * stubbed menu/window events.
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

test('switching between pathed docs never prompts: the dirty buffer stashes and restores', async ({
  page,
}) => {
  await openDirtyNotes(page)

  // The switch is instant — no discard dialog, ideas.md renders.
  await treeRow(page, 'ideas.md').click()
  await expect(editor(page)).toContainText('idea one')
  await expect(discardDialog(page)).toHaveCount(0)
  // ideas.md IS read from disk (cache miss for a first open)…
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).toContain('/ws/ideas.md')
  // …but nothing was written: the dirty buffer moved to the cache, not disk.
  expect(await calls(page, 'write_file')).toHaveLength(0)

  // Switching back restores the stashed buffer: edits AND the Edited badge.
  await treeRow(page, 'notes.md').click()
  await expect(editor(page)).toContainText(MARKER)
  await expect(page.locator('.badge.edited')).toBeVisible()
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  expect(await calls(page, 'write_file')).toHaveLength(0)
})

test("closing a dirty tab prompts: Don't Save discards without writing", async ({ page }) => {
  await pinFile(page, 'ideas.md')
  await openDirtyNotes(page)

  await closeStripRow(page, 'notes.md')
  const dialog = discardDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: "Don't Save" }).click()

  // Row gone, nothing written, the neighbour (ideas.md) is active again.
  // Prefix regex, NOT an exact name: a dirty row's dot span (aria-label
  // "Unsaved changes") joins the button's accessible name, so an exact-name
  // toHaveCount(0) would pass vacuously against a resurrected DIRTY row —
  // exactly the regression this spec pins (Don't-Save close re-stashing the
  // discarded buffer via stashActive).
  await expect(
    openFilesStrip(page).getByRole('button', { name: /^notes\.md/ }),
  ).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(editor(page)).toContainText('idea one')
  expect(await calls(page, 'write_file')).toHaveLength(0)
})

test('closing a dirty tab prompts: Save writes the buffer, then the row closes', async ({
  page,
}) => {
  await pinFile(page, 'ideas.md')
  await openDirtyNotes(page)

  await closeStripRow(page, 'notes.md')
  await discardDialog(page).getByRole('button', { name: 'Save', exact: true }).click()

  // Prefix regex for the same reason as the Don't-Save spec above: an
  // exact-name locator is blind to a lingering DIRTY row.
  await expect(
    openFilesStrip(page).getByRole('button', { name: /^notes\.md/ }),
  ).toHaveCount(0)
  await expect(editor(page)).toContainText('idea one')
  const writes = await calls(page, 'write_file')
  expect(writes).toHaveLength(1)
  expect(writes[0].args.path).toBe('/ws/notes.md')
  expect(String(writes[0].args.contents)).toContain(MARKER)
})

test('tree dblclick racing the discard overlay still pins (backdrop upgrade)', async ({
  page,
}) => {
  // Only a dirty UNTITLED scratch still defers a switch behind the discard
  // overlay (pathed docs stash silently) — and a fresh-workspace boot lands
  // exactly on that scratch (gotoApp asserts it), so just dirty it.
  await makeDirty(page, MARKER)

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

test('window close with a clean active doc but a dirty CACHED tab prompts; Save writes it', async ({
  page,
}) => {
  await openDirtyNotes(page)
  // Switch away: notes.md's dirty buffer now lives only in the cache, and
  // the ACTIVE doc (ideas.md preview) is clean.
  await treeRow(page, 'ideas.md').click()
  await expect(editor(page)).toContainText('idea one')

  await emitTauri(page, 'window:close-requested')
  const dialog = discardDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  // saveAllDirty wrote the CACHED path's content, then the window closed.
  await expect(async () => {
    const writes = await calls(page, 'write_file')
    expect(writes).toHaveLength(1)
    expect(writes[0].args.path).toBe('/ws/notes.md')
    expect(String(writes[0].args.contents)).toContain(MARKER)
    expect(await calls(page, 'plugin:window|destroy')).toHaveLength(1)
  }).toPass()
})
