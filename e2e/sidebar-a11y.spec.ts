import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  workspaceTree,
  openFilesStrip,
} from './support/workspaceFixture.ts'

/**
 * ARIA tree pattern + keyboard navigation for the workspace tree
 * (WorkspaceTree.svelte + treeNav.ts): role structure, aria-expanded/
 * aria-selected state, roving tabindex, and the arrow-key walk. The fixture
 * tree renders as (display order):
 *   sub/  nested.md  ·  guide.md  huge.md  ideas.md  notes.md  readme.txt
 * `sub` starts expanded (absent from the collapsed map = expanded).
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

test('exposes role=tree with treeitem rows and group children', async ({ page }) => {
  const tree = workspaceTree(page)
  await expect(tree).toHaveAttribute('role', 'tree')
  await expect(tree).toHaveAttribute('aria-label', 'Workspace files')
  // 1 folder + 1 nested file + 5 root files.
  await expect(tree.getByRole('treeitem')).toHaveCount(7)
  // The expanded folder's children live in a role=group container.
  await expect(
    tree.locator('[role="group"]').getByRole('treeitem', { name: 'nested.md', exact: true }),
  ).toBeVisible()
})

test('folder click toggles aria-expanded', async ({ page }) => {
  const sub = treeRow(page, 'sub')
  await expect(sub).toHaveAttribute('aria-expanded', 'true')
  await sub.click()
  await expect(sub).toHaveAttribute('aria-expanded', 'false')
  await expect(treeRow(page, 'nested.md')).toHaveCount(0)
  await sub.click()
  await expect(sub).toHaveAttribute('aria-expanded', 'true')
  await expect(treeRow(page, 'nested.md')).toBeVisible()
})

test('roving tabindex: exactly one row is tabbable and it follows focus', async ({ page }) => {
  const tabbable = workspaceTree(page).locator('[role="treeitem"][tabindex="0"]')
  // Before any interaction, the anchor is the first visible row.
  await expect(tabbable).toHaveCount(1)
  await expect(treeRow(page, 'sub')).toHaveAttribute('tabindex', '0')

  await treeRow(page, 'ideas.md').click()
  await expect(treeRow(page, 'ideas.md')).toHaveAttribute('tabindex', '0')
  await expect(tabbable).toHaveCount(1)
})

test('ArrowUp/ArrowDown/Home/End move focus and selection across visible rows', async ({
  page,
}) => {
  // readme.txt is non-markdown: clicking selects + focuses without opening a
  // document, so no row ever becomes the active (aria-current) one here.
  await treeRow(page, 'readme.txt').click()
  await expect(treeRow(page, 'readme.txt')).toBeFocused()
  await expect(treeRow(page, 'readme.txt')).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('ArrowUp')
  await expect(treeRow(page, 'notes.md')).toBeFocused()
  await expect(treeRow(page, 'notes.md')).toHaveAttribute('aria-selected', 'true')
  await expect(treeRow(page, 'readme.txt')).toHaveAttribute('aria-selected', 'false')

  await page.keyboard.press('ArrowDown')
  await expect(treeRow(page, 'readme.txt')).toBeFocused()
  // Clamped at the last row — no wrap.
  await page.keyboard.press('ArrowDown')
  await expect(treeRow(page, 'readme.txt')).toBeFocused()

  await page.keyboard.press('Home')
  await expect(treeRow(page, 'sub')).toBeFocused()
  // Clamped at the first row.
  await page.keyboard.press('ArrowUp')
  await expect(treeRow(page, 'sub')).toBeFocused()

  await page.keyboard.press('End')
  await expect(treeRow(page, 'readme.txt')).toBeFocused()
})

test('ArrowRight/ArrowLeft expand, step in, step out, and collapse', async ({ page }) => {
  const sub = treeRow(page, 'sub')
  // A click toggles the initially-expanded folder closed and focuses it.
  await sub.click()
  await expect(sub).toHaveAttribute('aria-expanded', 'false')
  await expect(sub).toBeFocused()

  await page.keyboard.press('ArrowRight') // collapsed folder: expand, keep focus
  await expect(sub).toHaveAttribute('aria-expanded', 'true')
  await expect(sub).toBeFocused()
  await expect(treeRow(page, 'nested.md')).toBeVisible()

  await page.keyboard.press('ArrowRight') // expanded folder: step into first child
  await expect(treeRow(page, 'nested.md')).toBeFocused()

  await page.keyboard.press('ArrowLeft') // child: step out to the parent
  await expect(sub).toBeFocused()

  await page.keyboard.press('ArrowLeft') // expanded folder: collapse, keep focus
  await expect(sub).toHaveAttribute('aria-expanded', 'false')
  await expect(sub).toBeFocused()
  await expect(treeRow(page, 'nested.md')).toHaveCount(0)
})

test('Enter on a keyboard-focused file row opens it PINNED', async ({ page }) => {
  await treeRow(page, 'readme.txt').click() // non-md: nothing opens
  await page.keyboard.press('ArrowUp') // notes.md
  await expect(treeRow(page, 'notes.md')).toBeFocused()

  await page.keyboard.press('Enter') // explicit open intent → pinned, not preview
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true }),
  ).toHaveCount(0)
})

test('Space on a keyboard-focused file row previews it', async ({ page }) => {
  await treeRow(page, 'readme.txt').click()
  await page.keyboard.press('ArrowUp') // notes.md
  await expect(treeRow(page, 'notes.md')).toBeFocused()

  await page.keyboard.press(' ') // native button activation → preview
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
})
