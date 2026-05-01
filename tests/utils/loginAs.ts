import { Page } from 'playwright-test-coverage';

/**
 * Log in via the MedEx login page using credentials from .env.test.
 * Waits until the redirect away from /login completes before returning.
 */
export async function loginAs(
  page: Page,
  username = process.env.TEST_USER ?? '',
  password = process.env.TEST_PASSWORD ?? ''
): Promise<void> {
  if (!username || !password) {
    throw new Error('TEST_USER and TEST_PASSWORD must be set in frontend/.env.test');
  }

  await page.goto('/login');
  await page.waitForLoadState('domcontentloaded');

  await page.getByPlaceholder('Username').fill(username);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: /login|sign in/i }).click();

  // Wait until the login page navigates away (redirect to app)
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 10_000 });
}
