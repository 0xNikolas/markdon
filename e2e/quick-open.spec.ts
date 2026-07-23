import { test, expect, type Page } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  openFilesStrip,
  emptyPage,
  editor,
  treeRow,
  closeStripRow,
  discardDialog,
  calls,
  emitTauri,
  makeDirty,
  pinFile,
  STUB,
} from './support/workspaceFixture.ts'

/**
 * The ⌘P Quick Open palette: opens via the keyboard fallback and the native
 * menu event, lists only the workspace's markdown files in two sections —
 * 'Open Files' (the strip's rows, most recently loaded first, ACTIVE file
 * last on the empty query) then 'Workspace' (everything else, session
 * recency first, tree order for never-loaded files). Typing fuzzy-filters
 * within each section (a section with no matches hides, header included),
 * arrows move the selection across sections, Enter opens the pick PINNED in
 * place (never a preview, never a new window), and Escape /
 * Backspace-on-empty / outside click dismiss. Without a workspace there is
 * nothing to list, so ⌘P does nothing at all.
 */

const MARKER = 'edited-by-e2e'

/** The palette dialog (aria-label "Quick Open"). */
function palette(page: Page) {
  return page.getByRole('dialog', { name: 'Quick Open' })
}

/** Every result row's basename, in rendered order (headers carry no .name). */
function rowNames(page: Page) {
  return palette(page).getByRole('option').locator('.name')
}

/** The non-interactive section headers, in rendered order. */
function sectionLabels(page: Page) {
  return palette(page).locator('.section-label')
}

/** ⌘P (mac) / Ctrl+P (elsewhere) — the handleWindowKeydown fallback path. */
async function pressQuickOpen(page: Page) {
  await page.keyboard.press('ControlOrMeta+p')
}

test.describe('with a workspace', () => {
  test.beforeEach(async ({ page }) => {
    await seedWorkspace(page)
    await gotoApp(page)
  })

  test('⌘P opens the palette listing every markdown file; Escape closes it', async ({ page }) => {
    await pressQuickOpen(page)
    await expect(palette(page)).toBeVisible()
    // Only the 5 markdown files — readme.txt can't open in the editor and is
    // not listed. Tree order: dirs first (sub/nested.md), then root files.
    await expect(rowNames(page)).toHaveText([
      'nested.md',
      'guide.md',
      'huge.md',
      'ideas.md',
      'notes.md',
    ])
    // Nothing open yet: only the Workspace section (its header still shows).
    await expect(sectionLabels(page)).toHaveText(['Workspace'])
    // The nested row shows its workspace-relative parent, muted.
    await expect(
      palette(page).getByRole('option').filter({ hasText: 'nested.md' }).locator('.dir'),
    ).toHaveText('sub')
    await expect(palette(page).getByText('readme.txt')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(palette(page)).toHaveCount(0)
  })

  test('the native menu event opens it; Backspace on an empty input closes it', async ({
    page,
  }) => {
    await emitTauri(page, 'menu:quick_open', { target: 'main' })
    await expect(palette(page)).toBeVisible()
    await page.keyboard.press('Backspace')
    await expect(palette(page)).toHaveCount(0)
  })

  test('empty query: both sections, open files recency-first with the ACTIVE file LAST', async ({
    page,
  }) => {
    // Open A (notes) then B (ideas) then C (guide, still active): recency
    // desc within Open Files is C,B,A; the active file then yields the top
    // slots (VS Code parity) and moves last → B,A,C. The Workspace section
    // follows with the never-loaded files in tree order.
    await pinFile(page, 'notes.md')
    await pinFile(page, 'ideas.md')
    await pinFile(page, 'guide.md')
    await pressQuickOpen(page)
    await expect(sectionLabels(page)).toHaveText(['Open Files', 'Workspace'])
    await expect(rowNames(page)).toHaveText([
      'ideas.md', // B — most recent after the active file steps aside
      'notes.md', // A
      'guide.md', // C — active, last in its section
      'nested.md', // Workspace, tree order (dirs first)
      'huge.md',
    ])
  })

  test('typing filters WITHIN sections; a section with no matches hides its header', async ({
    page,
  }) => {
    await pinFile(page, 'notes.md')
    await pinFile(page, 'ideas.md')
    await pressQuickOpen(page)

    // 'id' matches in both sections — each keeps its header and its order.
    await page.keyboard.type('id')
    await expect(sectionLabels(page)).toHaveText(['Open Files', 'Workspace'])
    await expect(rowNames(page)).toHaveText(['ideas.md', 'guide.md'])

    // 'nest' matches nothing among the open files → that section (header
    // included) disappears; Enter still opens the pick PINNED.
    await palette(page).getByRole('combobox').fill('')
    await page.keyboard.type('nest')
    await expect(sectionLabels(page)).toHaveText(['Workspace'])
    await expect(rowNames(page)).toHaveText(['nested.md'])

    await page.keyboard.press('Enter')
    await expect(palette(page)).toHaveCount(0)
    await expect(
      openFilesStrip(page).getByRole('button', { name: 'nested.md', exact: true }),
    ).toHaveAttribute('aria-current', 'true')
  })

  test('typing fuzzy-filters; Enter opens the pick PINNED in place', async ({ page }) => {
    await pressQuickOpen(page)
    await page.keyboard.type('nest')
    await expect(rowNames(page)).toHaveText(['nested.md'])

    await page.keyboard.press('Enter')
    await expect(palette(page)).toHaveCount(0)
    await expect(editor(page)).toContainText('nested body')
    // Pinned, not previewed: the strip row is the plain name, no "(preview)".
    await expect(
      openFilesStrip(page).getByRole('button', { name: 'nested.md', exact: true }),
    ).toHaveAttribute('aria-current', 'true')
  })

  test('arrow keys move the selection (clamped at the ends); Enter opens it', async ({ page }) => {
    await pressQuickOpen(page)
    // Starts on the best match; ArrowUp at the top stays put.
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('nested.md')
    await page.keyboard.press('ArrowUp')
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('nested.md')

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('guide.md')

    await page.keyboard.press('Enter')
    await expect(editor(page)).toContainText('guide body')
  })

  test('clicking a row opens it; clicking outside closes without opening', async ({ page }) => {
    await pressQuickOpen(page)
    await palette(page).getByRole('option').filter({ hasText: 'ideas.md' }).click()
    await expect(palette(page)).toHaveCount(0)
    await expect(editor(page)).toContainText('idea one')

    await pressQuickOpen(page)
    await expect(palette(page)).toBeVisible()
    // Far below the top-anchored panel: lands outside it, dismissing.
    await page.mouse.click(15, 500)
    await expect(palette(page)).toHaveCount(0)
    await expect(editor(page)).toContainText('idea one') // doc unchanged
  })

  test('⌘P works from the empty page while the workspace is open (the way out)', async ({
    page,
  }) => {
    await treeRow(page, 'notes.md').click()
    await expect(editor(page)).toContainText('hello notes')
    await closeStripRow(page, 'notes.md')
    await expect(emptyPage(page)).toBeVisible()

    await pressQuickOpen(page)
    await expect(palette(page)).toBeVisible()
    await page.keyboard.type('ideas')
    await page.keyboard.press('Enter')

    await expect(emptyPage(page)).toHaveCount(0)
    await expect(editor(page)).toContainText('idea one')
    await expect(
      openFilesStrip(page).getByRole('button', { name: 'ideas.md', exact: true }),
    ).toHaveAttribute('aria-current', 'true')
  })

  test('a dirty doc stashes on a ⌘P switch — no prompt, edits intact on return', async ({
    page,
  }) => {
    await pinFile(page, 'notes.md')
    await makeDirty(page, MARKER)

    await pressQuickOpen(page)
    await page.keyboard.type('ideas')
    await page.keyboard.press('Enter')
    await expect(discardDialog(page)).toHaveCount(0)
    await expect(editor(page)).toContainText('idea one')

    await pressQuickOpen(page)
    await page.keyboard.type('notes')
    await page.keyboard.press('Enter')
    await expect(editor(page)).toContainText(MARKER)
    await expect(page.locator('.badge.edited')).toBeVisible()
    expect(await calls(page, 'write_file')).toHaveLength(0)
  })
})

test('without a workspace ⌘P and the menu item do nothing — no palette to open', async ({
  page,
}) => {
  await page.addInitScript({ path: STUB })
  await page.goto('/')
  await expect(emptyPage(page)).toBeVisible()

  await pressQuickOpen(page)
  await emitTauri(page, 'menu:quick_open', { target: 'main' })

  await expect(palette(page)).toHaveCount(0)
  await expect(emptyPage(page)).toBeVisible()
})
