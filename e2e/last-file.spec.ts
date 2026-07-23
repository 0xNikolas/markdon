import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  workspaceTree,
  openFilesStrip,
  stripRows,
  treeRow,
  closeStripRow,
  editor,
  emptyPage,
  calls,
  emitTauri,
  pinFile,
  STUB,
  ROOT,
} from './support/workspaceFixture.ts'

/**
 * Last-open-file restore: opening a workspace (boot restore, Open Recent, a
 * mid-session adopt) reopens that workspace's remembered last file PINNED in
 * place; a fresh workspace — or one whose remembered file no longer
 * validates (vanished, outside the root) — lands on a fresh untitled
 * scratch instead. The empty page is reserved for a boot with NO workspace
 * at all (and closing the last tab). Startup file hand-offs still claim the
 * window and suppress the restore. The stub's __TAURI_WORKSPACE_UI__ map
 * backs save_workspace_ui/load_workspace_ui, validation included.
 */

/** Seed the standard /ws fixture plus a ui.json last-file entry for it. */
async function seedWithLastFile(
  page: import('@playwright/test').Page,
  lastFile: string,
  overrides?: Record<string, unknown>,
): Promise<void> {
  await seedWorkspace(page, overrides ? { overrides } : {})
  await page.addInitScript(
    ({ root, last }) => {
      window.__TAURI_WORKSPACE_UI__ = { [root]: last }
    },
    { root: ROOT, last: lastFile },
  )
}

test('a fresh workspace (nothing remembered) boots to the untitled scratch, not the empty page or a file', async ({
  page,
}) => {
  await seedWorkspace(page)
  await gotoApp(page) // itself asserts: tree up, lookup done, Untitled, no strip rows

  await expect(emptyPage(page)).toHaveCount(0)
  await expect(editor(page)).toBeVisible()
  // No workspace file was opened behind our back.
  expect(await calls(page, 'read_file')).toHaveLength(0)
})

test('a markdown-less workspace also boots to the scratch (empty page is no-workspace only)', async ({
  page,
}) => {
  await page.addInitScript({ path: STUB })
  await page.addInitScript((root) => {
    window.__TAURI_WORKSPACE_ROOT__ = root
    window.__TAURI_FS__ = { [`${root}/readme.txt`]: 'plain text, not markdown\n' }
  }, ROOT)
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  await expect(emptyPage(page)).toHaveCount(0)
  await expect(page.locator('.filename')).toHaveText('Untitled')
  await expect(editor(page)).toBeVisible()
  expect(await calls(page, 'read_file')).toHaveLength(0)
})

test('a remembered last file opens PINNED at boot (not a preview, not the scratch)', async ({
  page,
}) => {
  await seedWithLastFile(page, `${ROOT}/ideas.md`)
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // The document actually rendered, as the active PINNED strip row — a real
  // working file, not the old auto-preview's italic glance row.
  await expect(editor(page)).toContainText('idea one')
  await expect(page.locator('.filename')).toHaveText('ideas.md')
  await expect(stripRows(page)).toHaveCount(1)
  await expect(stripRows(page).first()).not.toHaveClass(/preview/)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).toContain(`${ROOT}/ideas.md`)
})

test.describe('an invalid remembered file falls back to the scratch', () => {
  for (const [label, lastFile] of [
    ['outside the root', '/other/escape.md'],
    ['nonexistent', `${ROOT}/gone.md`],
  ] as const) {
    test(label, async ({ page }) => {
      await seedWithLastFile(page, lastFile)
      await page.goto('/')
      await expect(workspaceTree(page)).toBeVisible()

      await expect.poll(async () => (await calls(page, 'load_workspace_ui')).length).toBe(1)
      await expect(page.locator('.filename')).toHaveText('Untitled')
      await expect(stripRows(page)).toHaveCount(0)
      await expect(emptyPage(page)).toHaveCount(0)
      expect(await calls(page, 'read_file')).toHaveLength(0)
    })
  }
})

test('a window-assigned startup file suppresses the last-file restore (assignment wins)', async ({
  page,
}) => {
  await seedWithLastFile(page, `${ROOT}/ideas.md`, {
    take_window_file: { path: `${ROOT}/notes.md`, readonly: false },
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // The assigned file is the doc…
  await expect(editor(page)).toContainText('hello notes')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // …and the remembered last file was never opened behind it.
  await expect(stripRows(page)).toHaveCount(1)
  const reads = (await calls(page, 'read_file')).map((c) => c.args.path)
  expect(reads).not.toContain(`${ROOT}/ideas.md`)
})

test('a mid-session Open Recent adopt opens the target workspace’s last file', async ({
  page,
}) => {
  // Folder-less boot; /ws2 exists only in the FS map + its ui.json entry.
  await page.addInitScript({ path: STUB })
  await page.addInitScript(() => {
    window.__TAURI_FS__ = { '/ws2/hello.md': '# Hello\n\nhello from ws2\n' }
    window.__TAURI_WORKSPACE_UI__ = { '/ws2': '/ws2/hello.md' }
  })
  await page.goto('/')
  await expect(emptyPage(page)).toBeVisible()

  // The stub's open_recent_workspace adopts in place when folder-less
  // (mirroring Rust resolve_recent), which is the root transition the
  // restore rides.
  await emitTauri(page, 'menu:open_recent', { target: 'main', root: '/ws2' })

  await expect(workspaceTree(page)).toBeVisible()
  await expect(editor(page)).toContainText('hello from ws2')
  await expect(emptyPage(page)).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'hello.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(stripRows(page).first()).not.toHaveClass(/preview/)
})

test('recording: pinning a file writes the whole strip to ui.json', async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page) // fresh workspace: scratch

  // Opening a file writes the whole {tabs,preview,active} strip through.
  await pinFile(page, 'notes.md')
  await expect
    .poll(async () => (await calls(page, 'save_workspace_ui')).map((c) => c.args))
    .toContainEqual({
      root: ROOT,
      tabs: [`${ROOT}/notes.md`],
      preview: null,
      active: `${ROOT}/notes.md`,
    })

  // Leave the workspace: close the tab (empty page), then Close Folder. Under
  // the v2 write-through, closing the last tab faithfully persists the EMPTY
  // strip — so the round-trip restore of a non-empty strip is exercised from a
  // pre-seeded boot in tab-persist.spec.ts instead.
  await closeStripRow(page, 'notes.md')
  await expect(emptyPage(page)).toBeVisible()
  await expect
    .poll(async () => {
      const saves = await calls(page, 'save_workspace_ui')
      return saves[saves.length - 1]?.args
    })
    .toEqual({ root: ROOT, tabs: [], preview: null, active: null })
})

test('switching away and back re-records the strip: the LATEST state wins', async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)

  await pinFile(page, 'notes.md')
  await treeRow(page, 'ideas.md').click() // preview counts: it IS the open doc
  await expect(editor(page)).toContainText('idea one')

  const strip = { tabs: [`${ROOT}/notes.md`], preview: `${ROOT}/ideas.md`, active: `${ROOT}/ideas.md` }
  await expect
    .poll(async () => {
      const saves = await calls(page, 'save_workspace_ui')
      return saves[saves.length - 1]?.args
    })
    .toEqual({ root: ROOT, ...strip })
  // The stub persisted it where the next boot's load will find it.
  expect(await page.evaluate(() => window.__TAURI_WORKSPACE_UI__)).toEqual({ [ROOT]: strip })
})
