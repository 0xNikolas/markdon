import { test, expect, type Page } from '@playwright/test'
import { seedWorkspace, gotoApp } from './support/workspaceFixture.ts'

test.beforeEach(async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)
})

/** Open the Settings modal from the header and land on the General tab. */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible()
}

const cliToggle = (page: Page) =>
  page.getByRole('switch', { name: 'Install md terminal command' })

/** Every recorded invoke of `cmd`. */
async function calls(page: Page, cmd: string) {
  return page.evaluate(
    (c) => window.__TAURI_IPC_CALLS__.filter((call) => call.cmd === c),
    cmd,
  )
}

test('the toggle reflects cli_status and installing invokes install_cli', async ({ page }) => {
  await openSettings(page)

  // On open the modal queries cli_status; the seed default is not-installed.
  await expect.poll(async () => (await calls(page, 'cli_status')).length).toBeGreaterThan(0)
  await expect(cliToggle(page)).toHaveAttribute('aria-checked', 'false')
  // The resolved shim path is shown (muted).
  await expect(page.getByText('/usr/local/bin/md')).toBeVisible()

  // Toggling on invokes install_cli and reflects the returned installed state.
  await cliToggle(page).click()
  await expect.poll(async () => (await calls(page, 'install_cli')).length).toBe(1)
  await expect(cliToggle(page)).toHaveAttribute('aria-checked', 'true')
})

test('toggling off invokes uninstall_cli', async ({ page }) => {
  // Seed an already-installed state so the toggle starts on.
  await page.evaluate(() => {
    window.__TAURI_CLI__ = { installed: true, path: '/usr/local/bin/md', on_path: true }
  })
  await openSettings(page)

  await expect(cliToggle(page)).toHaveAttribute('aria-checked', 'true')

  await cliToggle(page).click()
  await expect.poll(async () => (await calls(page, 'uninstall_cli')).length).toBe(1)
  await expect(cliToggle(page)).toHaveAttribute('aria-checked', 'false')
})

test('the PATH note shows only when the shim directory is off PATH', async ({ page }) => {
  await page.evaluate(() => {
    window.__TAURI_CLI__ = { installed: false, path: '/home/u/.local/bin/md', on_path: false }
  })
  await openSettings(page)

  await expect(page.getByText('Add /home/u/.local/bin to your PATH to use `md`.')).toBeVisible()
})

test('no PATH note when the shim directory is on PATH', async ({ page }) => {
  await openSettings(page)
  await expect(cliToggle(page)).toBeVisible()
  await expect(page.getByText(/to your PATH to use/)).toHaveCount(0)
})
