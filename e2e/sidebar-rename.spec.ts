import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  treeRow,
  workspaceTree,
  openFilesStrip,
  calls,
} from './support/workspaceFixture.ts'
import { NO_CLOBBER } from './support/contract.ts'

/**
 * Inline rename (VS Code style, no modal): arming via the context menu,
 * Enter/blur commit, Escape/invalid cancel, the exact backend collision
 * message, retargeting of open rows, and the d36d448 collapsed-ancestor
 * auto-expand.
 */

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

/** Right-click `name` in the tree and choose Rename…; returns the input. */
async function armRename(page: Page, name: string): Promise<Locator> {
  await treeRow(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  return page.getByLabel(`Rename ${name}`)
}

test('Enter commits: stem preselected, backend called, tree re-rendered', async ({ page }) => {
  const input = await armRename(page, 'notes.md')
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  // The stem (before ".md") is preselected so typing replaces just the name.
  const selection = await input.evaluate((el: HTMLInputElement) => [
    el.selectionStart,
    el.selectionEnd,
  ])
  expect(selection).toEqual([0, 5])

  await input.fill('renamed.md')
  await input.press('Enter')

  await expect(treeRow(page, 'renamed.md')).toBeVisible()
  await expect(treeRow(page, 'notes.md')).toHaveCount(0)
  const renames = await calls(page, 'rename_entry')
  expect(renames).toHaveLength(1)
  expect(renames[0].args).toEqual({ path: '/ws/notes.md', newName: 'renamed.md' })
})

test('renaming the previewed open file retargets its strip row', async ({ page }) => {
  await treeRow(page, 'notes.md').click() // preview it first
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true }),
  ).toBeVisible()

  const input = await armRename(page, 'notes.md')
  await input.fill('renamed.md')
  await input.press('Enter')

  // retargetPreview + retargetPath followed the rename: same row, new name,
  // still the active doc.
  await expect(
    openFilesStrip(page).getByRole('button', { name: 'renamed.md (preview)', exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await expect(openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true })).toHaveCount(
    0,
  )
})

test('Escape cancels without touching the backend', async ({ page }) => {
  const input = await armRename(page, 'notes.md')
  await input.fill('discarded.md')
  await input.press('Escape')

  await expect(input).toHaveCount(0)
  await expect(treeRow(page, 'notes.md')).toBeVisible()
  expect(await calls(page, 'rename_entry')).toHaveLength(0)
})

test('blur commits the edit', async ({ page }) => {
  const input = await armRename(page, 'notes.md')
  await input.fill('blurred.md')
  await page.locator('.editor [contenteditable="true"]').click() // click away -> onblur -> commitRename

  await expect(treeRow(page, 'blurred.md')).toBeVisible()
  const renames = await calls(page, 'rename_entry')
  expect(renames).toHaveLength(1)
  expect(renames[0].args).toEqual({ path: '/ws/notes.md', newName: 'blurred.md' })
})

test('collision surfaces the exact backend error and keeps both rows', async ({ page }) => {
  const input = await armRename(page, 'notes.md')
  await input.fill('ideas.md')
  await input.press('Enter')

  await expect(page.locator('.banner[role="alert"]')).toContainText(
    `Could not rename: ${NO_CLOBBER}`,
  )
  await expect(treeRow(page, 'notes.md')).toBeVisible()
  await expect(treeRow(page, 'ideas.md')).toBeVisible()
})

test('an invalid name shows live feedback and commits as a cancel', async ({ page }) => {
  const input = await armRename(page, 'notes.md')
  await input.fill('a/b')
  await expect(input).toHaveClass(/invalid/)
  await input.press('Enter')

  await expect(input).toHaveCount(0)
  await expect(treeRow(page, 'notes.md')).toBeVisible()
  expect(await calls(page, 'rename_entry')).toHaveLength(0)
})

test('renaming a row hidden in a collapsed folder auto-expands its ancestors', async ({
  page,
}) => {
  // Cut notes.md, collapse sub, paste into it: the moved file is selected by
  // afterMutation but its row is hidden inside the collapsed folder.
  await treeRow(page, 'notes.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cut' }).click()

  const sub = treeRow(page, 'sub')
  await sub.click() // collapse (also focuses it as the paste anchor)
  await expect(sub).toHaveAttribute('aria-expanded', 'false')
  await expect(sub).toHaveClass(/selected/)

  await page.getByRole('button', { name: 'File operations' }).click()
  await page.getByRole('menuitem', { name: 'Paste' }).click()

  // Paste completed: the moved path is selected (sub row loses .selected) and
  // the root-level notes.md row is gone.
  await expect(sub).not.toHaveClass(/selected/)
  await expect(treeRow(page, 'notes.md')).toHaveCount(0)
  const moves = await calls(page, 'move_entry')
  expect(moves).toHaveLength(1)
  expect(moves[0].args).toEqual({ src: '/ws/notes.md', destDir: '/ws/sub' })

  // d36d448 fix: Rename on the hidden row expands the collapsed ancestor and
  // mounts a visible, focused input — never an input against a hidden row.
  await page.getByRole('button', { name: 'File operations' }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()

  await expect(sub).toHaveAttribute('aria-expanded', 'true')
  const input = page.getByLabel('Rename notes.md')
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  await expect(workspaceTree(page)).toBeVisible()
})
