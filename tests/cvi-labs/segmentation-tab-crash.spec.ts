import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils/loginAs';
import { AUTO_LOAD_TIMEOUT_MS, STACK_WORKFLOW_STUDY_UID } from '../segmentation/realWorkflowHelpers';

test('Cvi Labs segmentation tab does not crash the frontend', async ({ page }) => {
  const errors: string[] = [];
  const ignoredConsoleErrorPatterns = [
    /Unknown event handler property .*onSelectStart/i,
    /\[segmentation-load-debug\]/i,
  ];

  page.on('pageerror', err => errors.push(`PAGE_ERROR: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (ignoredConsoleErrorPatterns.some(pattern => pattern.test(text))) {
        return;
      }

      errors.push(`CONSOLE_ERROR: ${text}`);
    }
  });

  await loginAs(page);
  await page.goto(`/cvi-labs?StudyInstanceUIDs=${STACK_WORKFLOW_STUDY_UID}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => document.querySelectorAll('canvas.cornerstone-canvas').length >= 1,
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
    timeout: AUTO_LOAD_TIMEOUT_MS,
  });

  await page.locator('[data-cy="segmentation-btn"]').click();
  await page.waitForTimeout(2000);

  if (errors.length) {
    throw new Error(errors.join('\n'));
  }

  await expect(page.getByLabel('Cvi active segmentation')).toBeVisible();
  await expect(page.locator('[data-cy="cvi-segmentation-row-lv_cavity"]')).toBeVisible();
});
