import { test, expect } from '@playwright/test'
import { seedWorkspace, gotoApp, calls, emitTauri } from './support/workspaceFixture.ts'

/**
 * Error-sink surfacing: Help > Show Log reveals the app log, and the error
 * banner's "Details…" button triggers the same reveal (every reportError also
 * lands in the log, so the log file is the fuller story behind the one-line
 * banner). Revealing a file has no browser-visible effect, so the stubbed
 * `reveal_log_file` call log is the assertion surface.
 */

test('Help > Show Log invokes reveal_log_file', async ({ page }) => {
  await seedWorkspace(page)
  await gotoApp(page)

  await emitTauri(page, 'menu:show_log', { target: 'main' })
  await expect.poll(async () => (await calls(page, 'reveal_log_file')).length).toBe(1)
})

test('error banner: Details… reveals the log, Dismiss still clears the banner', async ({
  page,
}) => {
  // Force a real error banner through an existing flow: Close Folder's pointer
  // delete rejects, and closeWorkspace reports it (while still closing locally).
  await seedWorkspace(page, { errors: { close_workspace: 'io error' } })
  await gotoApp(page)

  await emitTauri(page, 'menu:close_folder', { target: 'main' })
  const banner = page.locator('.banner[role="alert"]')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Could not close folder')

  await banner.getByRole('button', { name: 'Details…' }).click()
  await expect.poll(async () => (await calls(page, 'reveal_log_file')).length).toBe(1)

  // The reveal is fire-and-forget: the banner stays up until dismissed.
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toHaveCount(0)
})
