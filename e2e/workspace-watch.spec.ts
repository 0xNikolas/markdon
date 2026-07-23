import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  calls,
  emitTauri,
  ROOT,
} from './support/workspaceFixture.ts'

/**
 * Workspace-root watcher wiring: the frontend installs a Rust-side recursive
 * watcher for the adopted root (watch_workspace) and refreshes the sidebar
 * tree when its debounced 'workspace:changed' event arrives — external
 * changes (git checkout, mv) appear without refocusing the window. The stub
 * stands in for Rust: specs mutate the in-memory FS and fire the event.
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

test('adopting the restored root installs the Rust watcher for it', async ({ page }) => {
  await expect.poll(() => calls(page, 'watch_workspace')).toHaveLength(1)
  expect((await calls(page, 'watch_workspace'))[0].args).toEqual({ root: ROOT })
})

test('workspace:changed re-lists the tree: an externally created file appears', async ({
  page,
}) => {
  await expect(treeRow(page, 'external.md')).toHaveCount(0)

  // An "external" change: mutate the backing FS map directly (no fileops IPC,
  // exactly like another process writing into the folder), then deliver the
  // debounced watcher event Rust would emit.
  await page.evaluate((root) => {
    window.__TAURI_FS__![`${root}/external.md`] = '# External\n'
  }, ROOT)
  await emitTauri(page, 'workspace:changed', { target: 'main' })

  await expect(treeRow(page, 'external.md')).toBeVisible()
})

test("an event targeted at another window's label does not refresh", async ({ page }) => {
  const listsBefore = (await calls(page, 'list_workspace')).length
  await page.evaluate((root) => {
    window.__TAURI_FS__![`${root}/other-window.md`] = '# Other\n'
  }, ROOT)

  // listenScoped drops deliveries naming a foreign label outright.
  await emitTauri(page, 'workspace:changed', { target: 'doc-2' })
  await expect
    .poll(async () => (await calls(page, 'list_workspace')).length)
    .toBe(listsBefore)
  await expect(treeRow(page, 'other-window.md')).toHaveCount(0)

  // Ordering proof: the same payload aimed at THIS window does refresh.
  await emitTauri(page, 'workspace:changed', { target: 'main' })
  await expect(treeRow(page, 'other-window.md')).toBeVisible()
})
