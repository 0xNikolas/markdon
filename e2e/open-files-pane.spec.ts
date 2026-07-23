import { test, expect } from '@playwright/test'
import {
  seedWorkspace,
  gotoApp,
  openFilesStrip,
  stripRows,
  treeRow,
  pinFile,
} from './support/workspaceFixture.ts'

/**
 * The Open Files pane's fixed height band (min 3 rows / max 6, scroll
 * beyond): the section is always mounted while a workspace is open, so the
 * first preview/pin lands inside reserved space and the workspace tree
 * below never shifts — the user-reported dblclick race (first click grows
 * the strip, tree moves, second click hits a DIFFERENT file) is dead for
 * the common few-files case. Row math (see OpenFilesStrip.svelte): a row is
 * 32px + 4px gap, so min = 3*32+2*4 = 104px, max = 6*32+5*4 = 212px.
 */

test.describe('Open Files pane: reserved height, no layout shift', () => {
  test.beforeEach(async ({ page }) => {
    await seedWorkspace(page)
    await gotoApp(page)
  })

  test('the section is mounted with reserved space before any file opens', async ({ page }) => {
    // Quiet blank: the container is there (reserving its 3-row band), no rows.
    await expect(openFilesStrip(page)).toBeVisible()
    await expect(stripRows(page)).toHaveCount(0)
    const box = await openFilesStrip(page).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBe(104)
  })

  test('single-clicking a file leaves every tree row exactly where it was', async ({ page }) => {
    // The actual reported bug: the click adds a preview row; if the strip
    // grew, the tree would shift down and a dblclick's second click would
    // land on a different file. The row's y must be IDENTICAL.
    const probe = treeRow(page, 'guide.md')
    const before = await probe.boundingBox()
    expect(before).not.toBeNull()

    await treeRow(page, 'notes.md').click()
    await expect(
      openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true }),
    ).toBeVisible()

    const after = await probe.boundingBox()
    expect(after!.y).toBe(before!.y)
  })

  test('the preview row renders at the TOP of the strip (newest-first)', async ({ page }) => {
    // Regression: the newest-first change flipped stripOrder to preview-first
    // but the template still rendered the preview last, so it drew at the
    // bottom and the roving tab anchor landed on the wrong row.
    await treeRow(page, 'ideas.md').dblclick() // pin
    await treeRow(page, 'guide.md').dblclick() // pin (guide now above ideas)
    await treeRow(page, 'notes.md').click() // preview

    const rows = openFilesStrip(page).locator('.open-file-row')
    await expect(rows).toHaveCount(3)
    // Preview is the first DOM row and carries data-strip-index 0.
    await expect(rows.first()).toHaveClass(/preview/)
    await expect(rows.first().locator('[data-strip-index="0"]')).toBeVisible()
    // The active preview row is the tabbable anchor (tabindex 0), not a pinned row.
    await expect(
      openFilesStrip(page).getByRole('button', { name: 'notes.md (preview)', exact: true }),
    ).toHaveAttribute('tabindex', '0')
  })

  test('a bare tree dblclick pins its own file — no preview-first workaround', async ({
    page,
  }) => {
    // Regression for the race itself: both physical clicks land on the same
    // row now that the first click cannot shift the tree.
    await treeRow(page, 'notes.md').dblclick()
    await expect(
      openFilesStrip(page).getByRole('button', { name: 'notes.md', exact: true }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(openFilesStrip(page).locator('.open-file-row.preview')).toHaveCount(0)
  })

})

// Own seed (outside the shared beforeEach): needs four extra root files to
// overflow the six-row cap.
test('7 open files scroll within the 6-row cap instead of growing the pane', async ({
  page,
}) => {
  await seedWorkspace(page, {
    extraFiles: {
      'extra-a.md': '# A\n',
      'extra-b.md': '# B\n',
      'extra-c.md': '# C\n',
      'extra-d.md': '# D\n',
    },
  })
  await gotoApp(page)

  for (const name of [
    'notes.md',
    'ideas.md',
    'guide.md',
    'extra-a.md',
    'extra-b.md',
    'extra-c.md',
    'extra-d.md',
  ]) {
    await pinFile(page, name)
  }
  await expect(stripRows(page)).toHaveCount(7)

  // Capped at the 6-row band; the 7th row scrolls inside it.
  const dims = await openFilesStrip(page).evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
  }))
  expect(dims.client).toBe(212)
  expect(dims.scroll).toBeGreaterThan(dims.client)
})
