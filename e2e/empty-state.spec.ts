import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  workspaceTree,
  stripRows,
  closeStripRow,
  editor,
  emptyPage,
  calls,
  emitTauri,
  STUB,
  ROOT,
} from './support/workspaceFixture.ts'

/**
 * The no-document empty page (EmptyState.svelte): shown when a boot finds
 * nothing to open and when the last open file closes, replacing the old
 * untitled-scratch fallback. Cmd+N / the "New file" row still yields the
 * editable scratch; document-shaped menu actions no-op while it is up; the
 * Recent rows route through the stubbed open_recent_workspace flow.
 */

test('an unclaimed boot with no workspace shows the empty page with its actions', async ({
  page,
}) => {
  await page.addInitScript({ path: STUB })
  await page.goto('/')

  const empty = emptyPage(page)
  await expect(empty).toBeVisible()
  for (const name of ['New file', 'Open file…', 'Open folder…', 'Settings']) {
    await expect(empty.getByRole('button', { name, exact: true })).toBeVisible()
  }
  // No editor mounted, and no Recent section without seeded recents.
  await expect(editor(page)).toHaveCount(0)
  await expect(empty.getByText('Recent')).toHaveCount(0)
})

test('the New file row opens the editable untitled scratch', async ({ page }) => {
  await page.addInitScript({ path: STUB })
  await page.goto('/')
  await emptyPage(page).getByRole('button', { name: 'New file', exact: true }).click()

  await expect(emptyPage(page)).toHaveCount(0)
  await expect(page.locator('.filename')).toHaveText('Untitled')
  const pm = editor(page)
  await expect(pm).toBeVisible()
  await pm.click()
  await page.keyboard.type('scratch-works')
  await expect(pm).toContainText('scratch-works')
})

test('closing the last open file lands on the empty page, workspace intact', async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page) // boots on the auto-previewed nested.md

  await closeStripRow(page, 'nested.md')

  await expect(emptyPage(page)).toBeVisible()
  await expect(stripRows(page)).toHaveCount(0)
  await expect(editor(page)).toHaveCount(0)
  // The folder stays open — only the document went away.
  await expect(workspaceTree(page)).toBeVisible()
})

test('the Recent section lists other roots (current excluded) and a row opens one', async ({
  page,
}) => {
  await seedWorkspace(page) // /ws is the OPEN workspace…
  await page.addInitScript((root) => {
    // …and also sits in the MRU, alongside a genuinely different root.
    window.__TAURI_RECENT__ = [root, '/home/other-notes']
  }, ROOT)
  await gotoApp(page)
  await closeStripRow(page, 'nested.md') // -> empty page, workspace still open

  const empty = emptyPage(page)
  await expect(empty).toBeVisible()
  await expect(empty.getByText('Recent')).toBeVisible()
  // Exactly one row: the open workspace (/ws) is filtered out of its own list.
  await expect(empty.locator('.recent')).toHaveCount(1)
  await expect(empty.getByText('other-notes')).toBeVisible()

  // Clicking the row rides the same openRecentWorkspace flow as the menu
  // item: with a folder open, Rust decides (stub default: spawn -> null).
  await empty.locator('.recent').click()
  await expect
    .poll(async () => (await calls(page, 'open_recent_workspace')).map((c) => c.args))
    .toEqual([{ root: '/home/other-notes', currentRoot: ROOT }])
})

test('a recent row on a folder-less boot adopts the workspace in place', async ({ page }) => {
  await page.addInitScript({ path: STUB })
  await page.addInitScript(() => {
    window.__TAURI_RECENT__ = ['/ws2']
    window.__TAURI_IPC_OVERRIDES__ = {
      open_recent_workspace: {
        root: '/ws2',
        tree: {
          name: 'ws2',
          path: '/ws2',
          dirs: [],
          files: [{ name: 'hello.md', path: '/ws2/hello.md' }],
          truncated: false,
        },
      },
    }
  })
  await page.goto('/')

  const empty = emptyPage(page)
  await expect(empty.getByText('Recent')).toBeVisible()
  await empty.getByRole('button', { name: /ws2/ }).click()

  await expect(workspaceTree(page)).toBeVisible()
  await expect(workspaceTree(page).getByRole('treeitem', { name: 'hello.md' })).toBeVisible()
  expect((await calls(page, 'open_recent_workspace')).map((c) => c.args)).toEqual([
    { root: '/ws2', currentRoot: null },
  ])
  // The freshly adopted root leaves the Recent list (current-root filter).
  await expect(empty.locator('.recent')).toHaveCount(0)
})

test('document menu actions no-op while the empty page is shown (save, split)', async ({
  page,
}) => {
  await page.addInitScript({ path: STUB })
  await page.goto('/')
  await expect(emptyPage(page)).toBeVisible()

  // Save / Save As: gated — no Save As dialog for a document that doesn't
  // exist, and nothing written.
  await emitTauri(page, 'menu:save')
  await emitTauri(page, 'menu:save_as')
  expect(await calls(page, 'save_file_dialog')).toHaveLength(0)
  expect(await calls(page, 'write_file')).toHaveLength(0)

  // Split Preview (Header toggle): a bare preference flip — the empty page
  // stays, and no source pane mounts.
  await page.getByRole('button', { name: 'Split Preview' }).click()
  await expect(emptyPage(page)).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCount(0)

  // Cmd+N still leaves the page — and honors the flipped split preference,
  // proving the toggle was a no-op only visually, not swallowed.
  await emitTauri(page, 'menu:new')
  await expect(emptyPage(page)).toHaveCount(0)
  await expect(page.locator('.cm-editor')).toBeVisible()
})
