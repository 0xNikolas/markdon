import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  workspaceTree,
  openFilesStrip,
  stripRows,
  editor,
  emptyPage,
  calls,
  emitTauri,
  STUB,
  ROOT,
} from './support/workspaceFixture.ts'

/**
 * Whole-tab-set persistence (sprint-4 item 2): a workspace's ui.json stores
 * the entire Open Files strip ({tabs,preview,active}), and reopening the
 * workspace rebuilds every row — LAZILY, so only the active file reads from
 * disk while the other rows stay bare paths until first clicked. Restore drops
 * any persisted path that no longer validates (deleted, or outside the root)
 * without breaking the rest, and never opens outside the workspace. The stub's
 * __TAURI_WORKSPACE_UI__ map backs save/load_workspace_ui with the same
 * containment + existence validation the Rust side applies.
 */

type Strip = { tabs: string[]; preview: string | null; active: string | null }

/** Seed the standard /ws fixture plus a v2 strip entry for it. */
async function seedWithStrip(
  page: import('@playwright/test').Page,
  strip: Strip,
  overrides?: Record<string, unknown>,
): Promise<void> {
  await seedWorkspace(page, overrides ? { overrides } : {})
  await page.addInitScript(
    ({ root, s }) => {
      window.__TAURI_WORKSPACE_UI__ = { [root]: s }
    },
    { root: ROOT, s: strip },
  )
}

const reads = async (page: import('@playwright/test').Page): Promise<string[]> =>
  (await calls(page, 'read_file')).map((c) => c.args.path as string)

test('a multi-tab strip is rebuilt in order at boot; only the active file loads', async ({
  page,
}) => {
  await seedWithStrip(page, {
    tabs: [`${ROOT}/notes.md`, `${ROOT}/ideas.md`, `${ROOT}/guide.md`],
    preview: null,
    active: `${ROOT}/notes.md`,
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // All three pinned rows come back, in stored order (top = tabs[0]).
  await expect(stripRows(page)).toHaveCount(3)
  await expect(stripRows(page).nth(0)).toContainText('notes.md')
  await expect(stripRows(page).nth(1)).toContainText('ideas.md')
  await expect(stripRows(page).nth(2)).toContainText('guide.md')

  // The active file rendered and is the current row…
  await expect(editor(page)).toContainText('hello notes')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')

  // …and ONLY it was read from disk — the other rows are lazy (bare paths).
  expect(await reads(page)).toEqual([`${ROOT}/notes.md`])
  // The restore pre-stamped the write-through guard: no echo-save fired back.
  expect(await calls(page, 'save_workspace_ui')).toHaveLength(0)

  // Clicking a bare row loads it from disk on demand (buffer-cache miss).
  await openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }).click()
  await expect(editor(page)).toContainText('idea one')
  expect(await reads(page)).toContain(`${ROOT}/ideas.md`)
})

test('the persisted preview row is rebuilt italic when it was the active glance', async ({
  page,
}) => {
  await seedWithStrip(page, {
    tabs: [`${ROOT}/notes.md`],
    preview: `${ROOT}/ideas.md`,
    active: `${ROOT}/ideas.md`,
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // The preview renders as an italic row at the TOP (above the pinned note),
  // is the active row, and its content loaded.
  await expect(stripRows(page)).toHaveCount(2)
  await expect(stripRows(page).first()).toHaveClass(/preview/)
  await expect(editor(page)).toContainText('idea one')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // The pinned note stayed lazy; only the active preview was read.
  expect(await reads(page)).toEqual([`${ROOT}/ideas.md`])
})

test('active=null with pinned tabs restores a scratch showing over the rows', async ({ page }) => {
  await seedWithStrip(page, {
    tabs: [`${ROOT}/notes.md`, `${ROOT}/ideas.md`],
    preview: null,
    active: null,
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // The pinned rows are back, but the editor shows a fresh untitled scratch
  // (no row active) and nothing was read from disk.
  await expect(stripRows(page)).toHaveCount(2)
  await expect(page.locator('.filename')).toHaveText('Untitled')
  await expect(emptyPage(page)).toHaveCount(0)
  await expect(openFilesStrip(page).locator('.open-file-row[aria-current="true"]')).toHaveCount(0)
  expect(await reads(page)).toHaveLength(0)
})

test('a deleted persisted tab is dropped on restore; the rest survive', async ({ page }) => {
  // gone.md is in the persisted strip but not in the FS map.
  await seedWithStrip(page, {
    tabs: [`${ROOT}/notes.md`, `${ROOT}/gone.md`, `${ROOT}/ideas.md`],
    preview: null,
    active: `${ROOT}/notes.md`,
  })
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // Only the two surviving rows come back; the dead one leaves no dead row.
  await expect(stripRows(page)).toHaveCount(2)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'gone.md', exact: true }),
  ).toHaveCount(0)
  await expect(editor(page)).toContainText('hello notes')
  // The vanished path was never read.
  expect(await reads(page)).not.toContain(`${ROOT}/gone.md`)
})

test('NEGATIVE: a persisted path outside the root is never restored or read', async ({ page }) => {
  // A tampered ui.json lists a file OUTSIDE the workspace among the tabs (and
  // as the active). Restore must drop it — never a row, never a read, never an
  // escape — while the one in-root tab still restores.
  await page.addInitScript({ path: STUB })
  await page.addInitScript((root) => {
    window.__TAURI_WORKSPACE_ROOT__ = root
    window.__TAURI_FS__ = {
      [`${root}/notes.md`]: '# Notes\n\nhello notes\n',
      '/outside/secret.md': '# secret\n\ntop secret\n',
    }
    window.__TAURI_WORKSPACE_UI__ = {
      [root]: {
        tabs: [`${root}/notes.md`, '/outside/secret.md'],
        preview: null,
        active: '/outside/secret.md',
      },
    }
  }, ROOT)
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()

  // The outside path is dropped from the strip entirely; the in-root tab
  // survives. active was outside the root, so it dropped to a scratch over the
  // one restored row.
  await expect(stripRows(page)).toHaveCount(1)
  await expect(stripRows(page).first()).toContainText('notes.md')
  await expect(page.locator('.filename')).toHaveText('Untitled')
  // The secret file was NEVER read — the containment boundary held.
  expect(await reads(page)).not.toContain('/outside/secret.md')
  await expect(editor(page)).not.toContainText('top secret')
})

test('a mid-session Open Recent adopt rebuilds the target workspace’s whole strip', async ({
  page,
}) => {
  // Folder-less boot; /ws2 exists only in the FS map + its persisted strip.
  await page.addInitScript({ path: STUB })
  await page.addInitScript(() => {
    window.__TAURI_FS__ = {
      '/ws2/a.md': '# A\n\nalpha body\n',
      '/ws2/b.md': '# B\n\nbeta body\n',
    }
    window.__TAURI_WORKSPACE_UI__ = {
      '/ws2': { tabs: ['/ws2/a.md', '/ws2/b.md'], preview: null, active: '/ws2/a.md' },
    }
  })
  await page.goto('/')
  await expect(emptyPage(page)).toBeVisible()

  // The empty page is an unclaimed window, so the mid-session adopt rebuilds
  // the whole strip (not just the active file).
  await emitTauri(page, 'menu:open_recent', { target: 'main', root: '/ws2' })
  await expect(workspaceTree(page)).toBeVisible()
  await expect(emptyPage(page)).toHaveCount(0)
  await expect(stripRows(page)).toHaveCount(2)
  await expect(editor(page)).toContainText('alpha body')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'a.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  // Lazy again: only the active file of the adopted workspace was read.
  expect((await reads(page)).filter((p) => p.startsWith('/ws2/'))).toEqual(['/ws2/a.md'])
})
