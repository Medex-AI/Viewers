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
  await page.getByRole('button', { name: /login|sign in/i }).click({ force: true });

  try {
    // Wait until the login page navigates away (redirect to app)
    await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 10_000 });
    return;
  } catch {
    // Fall back to direct API login for dev-server/test-overlay environments.
  }

  const response = await page.request.post('/api/auth/login', {
    data: { username, password },
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await response.json();
  const token = data?.access_token || data?.token;
  const user = data?.user;

  if (!response.ok() || !token || !user) {
    throw new Error(`Login failed: ${JSON.stringify({ status: response.status(), data })}`);
  }

  await page.evaluate(
    ({ authToken, authUser }) => {
      localStorage.setItem('auth_token', authToken);
      localStorage.setItem('auth_user', JSON.stringify(authUser));
    },
    { authToken: token, authUser: user }
  );

  await page.goto('/medex-app');
  await page.waitForLoadState('domcontentloaded');
}
