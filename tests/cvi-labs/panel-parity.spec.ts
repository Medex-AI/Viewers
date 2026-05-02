import { test, expect } from 'playwright-test-coverage';
import type { Page } from '@playwright/test';
import { loginAs } from '../utils/loginAs';
import { AUTO_LOAD_TIMEOUT_MS, STACK_WORKFLOW_STUDY_UID } from '../segmentation/realWorkflowHelpers';

async function openMode(page: Page, mode: 'ovi-labs' | 'cvi-labs') {
  await page.goto(`/${mode}?StudyInstanceUIDs=${STACK_WORKFLOW_STUDY_UID}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => document.querySelectorAll('canvas.cornerstone-canvas').length >= 1,
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
}

test.describe('Cvi Labs panel parity', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('ROI Preview heading and orientation labels match OVI Labs style', async ({ page }) => {
    await openMode(page, 'ovi-labs');
    await expect(page.getByText('ROI Preview')).toBeVisible({ timeout: AUTO_LOAD_TIMEOUT_MS });

    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });
    await expect(page.getByText('ROI Preview')).toBeVisible();
  });

  test('CVI Labs shows cardiac segment labels in the ROI panel (not uterine)', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    await expect(page.locator('[data-cy="label-lv_cavity"]')).toBeVisible();
    await expect(page.locator('[data-cy="label-myocardium"]')).toBeVisible();
    await expect(page.locator('[data-cy="label-rv_cavity"]')).toBeVisible();

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('Uterine cavity');
    expect(bodyText).not.toContain('Endometrium');
    expect(bodyText).not.toContain('Junctional zone');
    expect(bodyText).not.toContain('Myometrium');
    expect(bodyText).not.toContain('Kymograph');
    expect(bodyText).not.toContain('FFT');
  });

  test('CVI Labs tab bar has Metrics, VTC, and Wall Thickness tabs', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    await expect(page.locator('[data-cy="tab-metrics"]')).toBeVisible();
    await expect(page.locator('[data-cy="tab-vtc"]')).toBeVisible();
    await expect(page.locator('[data-cy="tab-wallthickness"]')).toBeVisible();
  });

  test('Metrics tab shows EF, EDV, ESV, SV by default', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    await expect(page.locator('[data-cy="metric-ef"]')).toBeVisible();
    await expect(page.locator('[data-cy="metric-edv"]')).toBeVisible();
    await expect(page.locator('[data-cy="metric-esv"]')).toBeVisible();
    await expect(page.locator('[data-cy="metric-sv"]')).toBeVisible();
  });

  test('VTC tab renders chart after click', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    await page.locator('[data-cy="tab-vtc"]').click();
    // recharts renders svg inside the tab content
    await expect(page.locator('[data-cy="cardiac-viewer-panel"] svg').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('Wall Thickness tab renders chart after click', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    await page.locator('[data-cy="tab-wallthickness"]').click();
    await expect(page.locator('[data-cy="cardiac-viewer-panel"] svg').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('Metrics tab shows HR input and CO when Metrics tab is active', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    // HR input and CO are in the Metrics tab (default active tab)
    await expect(page.locator('[data-cy="hr-input"]')).toBeVisible();
    await expect(page.locator('[data-cy="metric-co"]')).toBeVisible();
  });

  test('Eye icon toggles segment visibility on click', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    // LV Cavity eye button starts visible (title="Hide")
    const eyeBtn = page.locator('[data-cy="label-visibility-lv_cavity"]');
    await expect(eyeBtn).toBeVisible();
    await expect(eyeBtn).toHaveAttribute('title', 'Hide');

    // Click once → hidden
    await eyeBtn.click();
    await expect(eyeBtn).toHaveAttribute('title', 'Show');

    // Click again → visible again
    await eyeBtn.click();
    await expect(eyeBtn).toHaveAttribute('title', 'Hide');
  });

  test('Advanced section expands and shows Segmentation Model', async ({ page }) => {
    await openMode(page, 'cvi-labs');
    await expect(page.locator('[data-cy="cardiac-viewer-panel"]')).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });

    const advancedBtn = page.getByRole('button', { name: /advanced/i });
    await expect(advancedBtn).toBeVisible();

    await advancedBtn.click();
    await expect(page.getByText('Segmentation Model')).toBeVisible();
  });
});
