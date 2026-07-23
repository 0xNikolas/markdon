import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  editor,
  pinFile,
  makeDirty,
  discardDialog,
} from './support/workspaceFixture.ts'

/**
 * Image view (sprint-4 item 7): clicking an image row in the workspace tree
 * shows the file as a distinct non-editable view over the editor area, leaving
 * the live document (and its unsaved buffer) untouched underneath. Opening any
 * document dismisses the view.
 *
 * The asset:// scheme does not resolve in a plain Playwright browser, so the
 * <img> always fails to load here and the "Could not load image." fallback
 * shows — which doubles as the missing/deleted-image coverage. The <img>
 * element (with its asset:// src) stays in the DOM regardless, so the src is
 * still assertable.
 */

test.beforeEach(async ({ page }) => {
  // Seed the image row per-spec (extraFiles), NOT into the shared fixture:
  // other specs count the fixture's exact row set. The content is irrelevant —
  // the tree only lists the file; the view builds an asset:// URL via
  // convertFileSrc.
  await seedWorkspace(page, { extraFiles: { 'logo.png': 'binary-image-bytes-placeholder' } })
  await gotoApp(page)
})

const imageView = (page: import('@playwright/test').Page) => page.getByTestId('image-view')

test('clicking an image row shows the view: asset:// src, filename header, no badge', async ({
  page,
}) => {
  await treeRow(page, 'logo.png').click()

  await expect(imageView(page)).toBeVisible()
  // Built via convertFileSrc — the asset protocol (stub: asset://localhost/<path>).
  await expect(imageView(page).locator('img')).toHaveAttribute(
    'src',
    /^asset:\/\/localhost\/\/ws\/logo\.png$/,
  )
  // The header names the image; an image is not a document, so no Saved/Edited badge.
  await expect(page.locator('.filename')).toHaveText('logo.png')
  await expect(page.locator('.badge')).toHaveCount(0)
  // The tree row is highlighted as current, and no editor is mounted.
  await expect(treeRow(page, 'logo.png')).toHaveAttribute('aria-current', 'true')
  await expect(editor(page)).toHaveCount(0)
  // Fail-closed fallback (also the missing/deleted-image signal).
  await expect(imageView(page).getByText('Could not load image.')).toBeVisible()
})

test('opening a markdown file dismisses the image view', async ({ page }) => {
  await treeRow(page, 'logo.png').click()
  await expect(imageView(page)).toBeVisible()

  await treeRow(page, 'notes.md').click()

  await expect(imageView(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('hello notes')
  await expect(page.locator('.filename')).toHaveText('notes.md')
})

test('round trip: a dirty document survives being backgrounded by the image view', async ({
  page,
}) => {
  await pinFile(page, 'notes.md')
  await makeDirty(page, 'round-trip-marker')
  await expect(page.locator('.badge.edited')).toBeVisible()

  // View the image — no discard prompt (nothing is at risk; $doc stays live).
  await treeRow(page, 'logo.png').click()
  await expect(imageView(page)).toBeVisible()
  await expect(discardDialog(page)).toHaveCount(0)

  // Return to the document: the edited buffer is restored with no reload.
  await treeRow(page, 'notes.md').click()
  await expect(imageView(page)).toHaveCount(0)
  await expect(editor(page)).toContainText('round-trip-marker')
  await expect(page.locator('.badge.edited')).toBeVisible()
})

test('a non-image, non-markdown row stays inert (no view, no document change)', async ({
  page,
}) => {
  await treeRow(page, 'readme.txt').click()

  await expect(imageView(page)).toHaveCount(0)
  // The untitled scratch is untouched — the row is merely selected.
  await expect(page.locator('.filename')).toHaveText('Untitled')
})
