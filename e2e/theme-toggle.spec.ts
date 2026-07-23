import { test, expect } from '@playwright/test'
import { seedWorkspace, gotoApp } from './support/workspaceFixture.ts'

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

const html = (page: import('@playwright/test').Page) => page.locator('html')

test('header toggle flips the resolved theme and persists an explicit pref', async ({ page }) => {
  await expect(html(page)).toHaveAttribute('data-theme', 'light')

  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(html(page)).toHaveAttribute('data-theme', 'dark')
  // The flip persists through the settings pipeline (save_prefs), not a
  // transient DOM stamp.
  const saved = await page.evaluate(() => {
    const calls = window.__TAURI_IPC_CALLS__.filter((c) => c.cmd === 'save_prefs')
    const last = calls[calls.length - 1]?.args as { json?: string } | undefined
    return last?.json === undefined ? null : (JSON.parse(last.json) as { theme?: string }).theme
  })
  expect(saved).toBe('dark')

  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(html(page)).toHaveAttribute('data-theme', 'light')
})

test('dark-mode editor selection and caret stay visible (regression)', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(html(page)).toHaveAttribute('data-theme', 'dark')

  // The Crepe dark sheet's own --crepe-color-selected (#2f2f2f) was invisible
  // against the slate bg; the app now pins it to --selection-bg (accent).
  const { selected, caret } = await page.evaluate(() => {
    // Serialization of computed custom properties varies (#rrggbbaa vs rgba);
    // normalize through a probe element's computed background-color.
    const probe = document.createElement('div')
    probe.style.backgroundColor = getComputedStyle(
      document.querySelector('.milkdown')!,
    ).getPropertyValue('--crepe-color-selected')
    document.body.appendChild(probe)
    const selected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      selected,
      caret: getComputedStyle(document.querySelector('.milkdown .ProseMirror')!).caretColor,
    }
  })
  expect(selected).toBe('rgba(229, 104, 43, 0.34)')
  expect(caret).toBe('rgb(229, 104, 43)')
})
