import { test, expect } from '@playwright/test'
import type { Page, Locator } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  openFilesStrip,
  stripRows,
  editor,
  makeDirty,
  pinFile,
  switchTo,
  closeStripRow,
  calls,
  emptyPage,
} from './support/workspaceFixture.ts'

/**
 * Open-files management bundle: Reopen Closed File (Cmd+Shift+T over the
 * per-window closed stack), strip keyboard navigation (roving tabindex +
 * arrows, Enter as native activation), and the strip-row context menu (Close
 * variants with skip-dirty semantics, Copy Path, Reveal in Finder).
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

/** Pin the three fixture files, landing active on guide.md. */
async function pinThree(page: Page): Promise<void> {
  await pinFile(page, 'notes.md')
  await pinFile(page, 'ideas.md')
  await pinFile(page, 'guide.md')
}

/** Right-click `name`'s strip row, returning the opened context menu. */
async function openRowMenu(page: Page, name: string): Promise<Locator> {
  await stripRows(page).filter({ hasText: name }).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Open file actions' })
  await expect(menu).toBeVisible()
  return menu
}

// -- Reopen Closed File -------------------------------------------------------

test('Cmd+Shift+T reopens the closed row PINNED at its old index, re-read from disk', async ({
  page,
}) => {
  await pinThree(page)
  await closeStripRow(page, 'ideas.md') // clean background close (guide stays active)
  await expect(stripRows(page)).toHaveCount(2)

  // The close evicted ideas.md's cache entry, so a reopen must re-read the
  // file — change it on "disk" to prove the content comes from there.
  await page.evaluate(() => {
    window.__TAURI_FS__!['/ws/ideas.md'] = '# Ideas\n\nreopened from disk\n'
  })

  await page.keyboard.press('Meta+Shift+T')
  await expect(stripRows(page)).toHaveCount(3)
  // Back at its old position (index 1, between notes and guide), pinned (no
  // italic preview row), and active — reopen is a real switch.
  await expect(stripRows(page).nth(1)).toContainText('ideas.md')
  await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(editor(page)).toContainText('reopened from disk')
})

test('reopen silently skips an entry whose file was deleted since the close', async ({ page }) => {
  await pinThree(page)
  await closeStripRow(page, 'notes.md')
  await closeStripRow(page, 'ideas.md') // newest close — the first pop candidate
  await expect(stripRows(page)).toHaveCount(1)

  // ideas.md vanishes from disk while it sits on the closed stack.
  await page.evaluate(() => {
    delete window.__TAURI_FS__!['/ws/ideas.md']
  })

  await page.keyboard.press('Meta+Shift+T')
  // The deleted entry is skipped SILENTLY (no error banner) and the next
  // stack entry (notes.md, closed from index 0) reopens in its place.
  await expect(stripRows(page)).toHaveCount(2)
  await expect(stripRows(page).nth(0)).toContainText('notes.md')
  await expect(stripRows(page).filter({ hasText: 'ideas.md' })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(editor(page)).toContainText('hello notes')
})

// -- strip keyboard navigation ------------------------------------------------

test('strip rows are arrow-navigable via a roving tabindex; Enter activates a row', async ({
  page,
}) => {
  await pinThree(page)

  // Exactly one row button is tabbable — the active row is the initial anchor.
  const tabbable = openFilesStrip(page).locator('.open-file-main[tabindex="0"]')
  await expect(tabbable).toHaveCount(1)
  await expect(tabbable).toHaveText(/guide\.md/)

  await openFilesStrip(page).getByRole('button', { name: 'guide.md', exact: true }).focus()
  await page.keyboard.press('Home')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toBeFocused()

  await page.keyboard.press('ArrowDown')
  const ideas = openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true })
  await expect(ideas).toBeFocused()
  // The roving anchor follows keyboard focus (still exactly one tab stop).
  await expect(tabbable).toHaveCount(1)
  await expect(tabbable).toHaveText(/ideas\.md/)

  await page.keyboard.press('End')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'guide.md', exact: true }),
  ).toBeFocused()
  // Clamped at the last row — no wrap (wrapping is Ctrl+Tab's job).
  await page.keyboard.press('ArrowDown')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'guide.md', exact: true }),
  ).toBeFocused()

  // Enter = native button activation: the focused row opens.
  await page.keyboard.press('ArrowUp')
  await expect(ideas).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(ideas).toHaveAttribute('aria-current', 'true')
  await expect(editor(page)).toContainText('idea one')
})

// -- strip row context menu ---------------------------------------------------

test('Close Others closes clean rows, keeps dirty background rows, and notices', async ({
  page,
}) => {
  await pinThree(page)
  await switchTo(page, 'notes.md')
  await makeDirty(page)
  await switchTo(page, 'guide.md') // notes.md's dirty buffer stashes into the cache

  const menu = await openRowMenu(page, 'guide.md')
  await menu.getByRole('menuitem', { name: 'Close Others', exact: true }).click()

  // ideas.md (clean background) closed; notes.md (dirty background) kept with
  // its dot; guide.md (the target, active) kept. One notice, no prompt chain.
  await expect(stripRows(page)).toHaveCount(2)
  await expect(stripRows(page).filter({ hasText: 'ideas.md' })).toHaveCount(0)
  await expect(stripRows(page).filter({ hasText: 'notes.md' })).toHaveCount(1)
  await expect(
    openFilesStrip(page).getByRole('img', { name: 'Unsaved changes' }),
  ).toBeVisible()
  await expect(page.getByText('1 file with unsaved changes was kept open')).toBeVisible()
})

test('Close All closes every clean row including the active one (empty page)', async ({
  page,
}) => {
  await pinFile(page, 'notes.md')
  await pinFile(page, 'ideas.md') // active

  const menu = await openRowMenu(page, 'notes.md')
  await menu.getByRole('menuitem', { name: 'Close All', exact: true }).click()

  await expect(stripRows(page)).toHaveCount(0)
  await expect(emptyPage(page)).toBeVisible()
})

test('Copy Path puts the row\'s absolute path on the clipboard; Close Others disabled on a lone row', async ({
  page,
}) => {
  await pinFile(page, 'notes.md')
  // Spy on the async clipboard API: WebKit gates real clipboard reads behind
  // user activation, so the override records what the app handed it.
  await page.evaluate(() => {
    window.__COPIED__ = null
    navigator.clipboard.writeText = (text: string) => {
      window.__COPIED__ = text
      return Promise.resolve()
    }
  })

  const menu = await openRowMenu(page, 'notes.md')
  // Single row: nothing "other" to close.
  await expect(menu.getByRole('menuitem', { name: 'Close Others', exact: true })).toBeDisabled()
  await menu.getByRole('menuitem', { name: 'Copy Path', exact: true }).click()

  await expect.poll(() => page.evaluate(() => window.__COPIED__)).toBe('/ws/notes.md')
  await expect(stripRows(page)).toHaveCount(1) // copying never closes anything
})

test('Reveal in Finder invokes reveal_path with the row\'s path', async ({ page }) => {
  await pinFile(page, 'notes.md')

  const menu = await openRowMenu(page, 'notes.md')
  await menu.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).click()

  await expect.poll(async () => (await calls(page, 'reveal_path')).length).toBe(1)
  expect((await calls(page, 'reveal_path'))[0].args).toEqual({ path: '/ws/notes.md' })
  await expect(menu).toBeHidden() // the menu dismissed on activation
})
