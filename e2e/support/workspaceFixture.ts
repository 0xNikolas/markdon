import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Shared workspace seeding for the sidebar/app behavior specs: installs the
 * Tauri IPC stub, then a second init script that plants an in-memory FS tree
 * under /ws which the stub's restore_workspace/list_workspace/fileops
 * handlers serve and mutate. Every helper here is pure Playwright — no
 * arbitrary sleeps; assertions poll via expect().
 */

export const STUB = fileURLToPath(new URL('./tauriInternals.js', import.meta.url))

export const ROOT = '/ws'

/**
 * Fixture tree:
 *   /ws/notes.md ideas.md guide.md   — openable markdown files
 *   /ws/readme.txt                   — non-markdown (exercises menu enablement)
 *   /ws/huge.md                      — one line over LONG_LINE_LIMIT (100_000)
 *   /ws/sub/nested.md                — nesting for expand/collapse + moves
 */
export interface SeedOptions {
  /** Static per-command resolved values (stub __TAURI_IPC_OVERRIDES__). */
  overrides?: Record<string, unknown>
  /** Per-command forced rejections (stub __TAURI_IPC_ERRORS__). */
  errors?: Record<string, string>
}

export async function seedWorkspace(page: Page, opts: SeedOptions = {}): Promise<void> {
  await page.addInitScript({ path: STUB })
  await page.addInitScript(
    ({ root, overrides, errors }) => {
      window.__TAURI_WORKSPACE_ROOT__ = root
      window.__TAURI_DIRS__ = [`${root}/sub`]
      window.__TAURI_FS__ = {
        [`${root}/notes.md`]: '# Notes\n\nhello notes\n',
        [`${root}/ideas.md`]: '# Ideas\n\nidea one\n',
        [`${root}/guide.md`]: '# Guide\n\nguide body\n',
        [`${root}/readme.txt`]: 'plain text, not markdown\n',
        // One line over sourceEditor.ts's LONG_LINE_LIMIT (100_000): trips the
        // SplitView hugeLine guard while staying cheap for the WYSIWYG editor.
        [`${root}/huge.md`]: '# Huge\n\n' + 'x'.repeat(100_100) + '\n',
        [`${root}/sub/nested.md`]: '# Nested\n\nnested body\n',
      }
      if (overrides) window.__TAURI_IPC_OVERRIDES__ = overrides
      if (errors) window.__TAURI_IPC_ERRORS__ = errors
    },
    { root: ROOT, overrides: opts.overrides ?? null, errors: opts.errors ?? null },
  )
}

/** Load the app and wait for the restored workspace tree to render. */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(workspaceTree(page)).toBeVisible()
}

// -- locators -----------------------------------------------------------------

/** The Workspace tree container (folder/file rows). */
export function workspaceTree(page: Page): Locator {
  return page.getByTestId('workspace-tree')
}

/** The Open Files strip container (pinned rows + the italic preview row). */
export function openFilesStrip(page: Page): Locator {
  return page.getByTestId('open-files')
}

/** A workspace-tree row (role=treeitem — ARIA tree pattern) by its exact
    visible name. The Open Files strip rows stay role=button — it is a list,
    not a tree — so openFilesStrip getByRole('button') locators are separate. */
export function treeRow(page: Page, name: string): Locator {
  return workspaceTree(page).getByRole('treeitem', { name, exact: true })
}

/** Every row in the Open Files strip (pinned and preview alike). */
export function stripRows(page: Page): Locator {
  return openFilesStrip(page).locator('.open-file-row')
}

/** The WYSIWYG editor's contenteditable surface. */
export function editor(page: Page): Locator {
  return page.locator('.editor [contenteditable="true"]')
}

/** The dirty-doc discard-confirm dialog. */
export function discardDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'unsaved changes' })
}

// -- IPC/event helpers --------------------------------------------------------

/** Every logged invoke of `cmd`, in call order. */
export function calls(
  page: Page,
  cmd: string,
): Promise<{ cmd: string; args: Record<string, unknown> }[]> {
  return page.evaluate((c) => window.__TAURI_IPC_CALLS__.filter((x) => x.cmd === c), cmd)
}

/** Fire a registered Tauri event listener (menu items, window close, …). */
export function emitTauri(page: Page, event: string, payload: unknown = null): Promise<void> {
  return page.evaluate(([e, p]) => window.__tauriEmit(e, p), [event, payload] as const)
}

// -- state builders -----------------------------------------------------------

/**
 * Open `name` as a PINNED strip entry. Deliberately preview-first: a bare
 * dblclick on a tree row while the Open Files strip is unmounted is racy —
 * the first click mounts the strip, which pushes the tree rows down between
 * the two physical clicks, so the second click lands on a different row.
 * Previewing first settles the layout; the dblclick then converts the
 * preview in place (same row count, no shift).
 */
export async function pinFile(page: Page, name: string): Promise<void> {
  await treeRow(page, name).click()
  await expect(
    openFilesStrip(page).getByRole('button', { name: `${name} (preview)`, exact: true }),
  ).toHaveAttribute('aria-current', 'true')
  await treeRow(page, name).dblclick()
  await expect(
    openFilesStrip(page).getByRole('button', { name, exact: true }),
  ).toHaveAttribute('aria-current', 'true')
}

/**
 * Switch to `name` via its workspace-tree row (a single click — a preview
 * open for unpinned files, an in-place switch for pinned ones) and wait until
 * its strip row is the active one. With the buffer cache, a switch between
 * pathed docs never prompts — this helper asserts the LANDED state, so a
 * regression to prompting shows up as a timeout here.
 */
export async function switchTo(page: Page, name: string): Promise<void> {
  await treeRow(page, name).click()
  await expect(
    openFilesStrip(page).getByRole('button', {
      name: new RegExp(`^${name}( \\(preview\\))?$`),
    }),
  ).toHaveAttribute('aria-current', 'true')
}

/**
 * Close `name`'s Open Files strip row via its hover close affordance (pinned
 * or preview row alike). Does NOT wait for the row to disappear — a dirty
 * cached row opens the discard dialog instead, and the caller owns that
 * resolution.
 */
export async function closeStripRow(page: Page, name: string): Promise<void> {
  const row = openFilesStrip(page)
    .locator('.open-file-row')
    .filter({ hasText: name })
  await row.hover()
  await row.getByRole('button', { name: new RegExp(`^Close ${name}`) }).click()
}

/**
 * Type into the WYSIWYG editor until the doc is actually dirty (Header shows
 * the Edited badge). Milkdown's listener debounces 200ms and its FIRST
 * emission is adopted as the clean baseline (App.svelte adoptNormalization),
 * so a single burst of keystrokes may fold into the baseline without dirtying
 * — hence the poll: keep typing single characters until the badge appears.
 * The `marker` text always ends up in the buffer, for content assertions.
 */
export async function makeDirty(page: Page, marker = 'edited-by-e2e'): Promise<void> {
  const pm = editor(page)
  await pm.click()
  await page.keyboard.type(marker)
  const edited = page.locator('.badge.edited')
  await expect(async () => {
    await page.keyboard.type('x')
    await expect(edited).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 15_000 })
}
