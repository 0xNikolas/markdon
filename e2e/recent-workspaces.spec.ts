import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  workspaceTree,
  calls,
  emitTauri,
  ROOT,
  STUB,
} from './support/workspaceFixture.ts'

/**
 * File > Open Recent ("Reopen Recent Workspace") frontend routing: the
 * `menu:open_recent` event carries the root Rust resolved from its own MRU
 * snapshot, and openRecentWorkspace routes it — same-root no-op, folder-less
 * in-place adoption, folder-open spawn hand-off. The Rust MRU/menu mechanics
 * are covered by cargo tests; here the stubbed `open_recent_workspace` call
 * log is the assertion surface.
 */

test('with a folder open, a recent pick hands off to a new instance (currentRoot rides along)', async ({
  page,
}) => {
  await seedWorkspace(page)
  await gotoApp(page)

  await emitTauri(page, 'menu:open_recent', { target: 'main', root: '/other-ws' })
  await expect
    .poll(async () => (await calls(page, 'open_recent_workspace')).map((c) => c.args))
    .toEqual([{ root: '/other-ws', currentRoot: ROOT }])

  // The stub returned null (Rust spawned a new instance): this window's own
  // workspace stays untouched.
  await expect(workspaceTree(page)).toBeVisible()
})

test('reopening the already-open root is a local no-op (no invoke at all)', async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)

  await emitTauri(page, 'menu:open_recent', { target: 'main', root: ROOT })
  // A second, different-root pick IS invoked — proving the event route works
  // and the first emit was dropped by the same-root guard, not by wiring lag.
  await emitTauri(page, 'menu:open_recent', { target: 'main', root: '/other-ws' })
  await expect
    .poll(async () => (await calls(page, 'open_recent_workspace')).map((c) => c.args.root))
    .toEqual(['/other-ws'])
})

test('folder-less window adopts the reopened workspace in place', async ({ page }) => {
  // No __TAURI_WORKSPACE_ROOT__: the app boots folder-less; the override makes
  // open_recent_workspace return a Rust-shaped Workspace to adopt.
  await page.addInitScript({ path: STUB })
  await page.addInitScript(() => {
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
  await expect(page.locator('.filename')).toHaveText('Untitled')
  await expect(workspaceTree(page)).toHaveCount(0)

  await emitTauri(page, 'menu:open_recent', { target: 'main', root: '/ws2' })

  await expect(workspaceTree(page)).toBeVisible()
  await expect(workspaceTree(page).getByRole('treeitem', { name: 'hello.md' })).toBeVisible()
  const reopens = await calls(page, 'open_recent_workspace')
  expect(reopens.map((c) => c.args)).toEqual([{ root: '/ws2', currentRoot: null }])

  // A workspace adopted MID-SESSION must not trigger the boot auto-preview:
  // the untitled scratch stays and hello.md is never opened behind our back.
  await expect(page.locator('.filename')).toHaveText('Untitled')
  expect((await calls(page, 'read_file')).map((c) => c.args.path)).not.toContain('/ws2/hello.md')
})
