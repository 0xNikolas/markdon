import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  workspaceTree,
  openFilesStrip,
  stripRows,
  editor,
  calls,
  bootPreviewRow,
  STUB,
  ROOT,
} from './support/workspaceFixture.ts'

/**
 * Boot auto-preview: a window that boots with a restored workspace but no
 * document auto-opens the FIRST markdown file of the tree (depth-first render
 * order — dirs sort before files, so the fixture's sub/nested.md) as a
 * PREVIEW instead of landing on a useless untitled scratch. Startup file
 * hand-offs (window assignment / drained Finder-open queue) claim the window
 * and suppress it, and a workspace with no markdown files keeps the scratch.
 */

test('an unclaimed boot auto-opens the first markdown file (depth-first) as the preview row', async ({
  page,
}) => {
  await seedWorkspace(page)
  await gotoApp(page) // waits for the auto-preview row itself

  // Exactly one strip row: the italic preview of sub/nested.md — the first
  // file of the FIRST folder, not the alphabetically-first root file.
  await expect(stripRows(page)).toHaveCount(1)
  await expect(stripRows(page).first()).toHaveClass(/preview/)
  await expect(bootPreviewRow(page)).toHaveAttribute('aria-current', 'true')

  // The document actually rendered — this is a real preview open, not a row.
  await expect(editor(page)).toContainText('nested body')
  await expect(page.locator('.filename')).toHaveText('nested.md')
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).toContain(`${ROOT}/sub/nested.md`)
})

test('a window-assigned file suppresses the auto-preview (assignment wins)', async ({ page }) => {
  await seedWorkspace(page, {
    overrides: { take_window_file: { path: `${ROOT}/notes.md`, readonly: false } },
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // The assigned file is the doc (pinned — assignments are real opens)…
  await expect(editor(page)).toContainText('hello notes')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // …and no auto-preview fired: no italic row, nested.md never read.
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).not.toContain(`${ROOT}/sub/nested.md`)
})

test('a drained startup (Finder/argv) file suppresses the auto-preview', async ({ page }) => {
  await seedWorkspace(page, {
    overrides: { take_opened_files: [{ path: `${ROOT}/guide.md`, readonly: false }] },
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  await expect(editor(page)).toContainText('guide body')
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).not.toContain(`${ROOT}/sub/nested.md`)
})

test('a workspace with no markdown files keeps the untitled scratch', async ({ page }) => {
  await page.addInitScript({ path: STUB })
  await page.addInitScript((root) => {
    window.__TAURI_WORKSPACE_ROOT__ = root
    window.__TAURI_FS__ = { [`${root}/readme.txt`]: 'plain text, not markdown\n' }
  }, ROOT)
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // Nothing to auto-open: the scratch stays, and nothing was ever read.
  await expect(page.locator('.filename')).toHaveText('Untitled')
  await expect(stripRows(page)).toHaveCount(0)
  expect(await calls(page, 'read_file')).toHaveLength(0)
})
