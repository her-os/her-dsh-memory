/** Navigation inside the DSH Web UI. */

import type { Page } from 'playwright-core'

/**
 * Open the memory plugin's page from a fresh Web UI load.
 * @param page - a page at the tokenized Web UI URL.
 */
export async function openMemoryPage(page: Page): Promise<void> {
  // A fresh DSH home greets with the preview notice first.
  const notice = page.getByRole('button', { name: '继续', exact: true })
  await notice.waitFor({ timeout: 10_000 }).then(() => notice.click(), () => {})
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await page.getByRole('button', { name: '查看 @her-os/dsh-memory', exact: true }).click()
  await page.getByText('语义检索').first().waitFor()
}
