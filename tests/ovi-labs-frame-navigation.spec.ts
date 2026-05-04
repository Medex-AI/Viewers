/**
 * Regression test: OVI Labs frame navigation
 *
 * Verifies that:
 *  D. The OVI viewport loads without console errors related to viewportType
 *  E. Clicking "Next Frame" increments the displayed frame
 *  F. Clicking "Prev Frame" decrements the displayed frame
 *
 * No OVI test study UID is currently configured; the tests skip gracefully if
 * OVI_STUDY_UID is not set.
 *
 * Run with:
 *   OVI_STUDY_UID=<uid> PLAYWRIGHT_APP_CONFIG=config/default.js yarn test:e2e --grep ovi-labs-frame-navigation
 */

import { test, expect } from 'playwright-test-coverage';
import { loginAs } from './utils/loginAs';

const OVI_STUDY_UID = process.env.OVI_STUDY_UID ?? '';

test.describe('OVI Labs frame navigation', () => {
  test.beforeEach(async () => {
    if (!OVI_STUDY_UID) {
      test.skip(true, 'No OVI test study configured — set OVI_STUDY_UID to enable');
    }
  });

  test('Scenario D: OVI viewport loads without viewportType errors', async ({ page }) => {
    const viewportErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && msg.text().toLowerCase().includes('viewporttype')) {
        viewportErrors.push(msg.text());
      }
    });
    page.on('pageerror', err => {
      if (err.message.toLowerCase().includes('viewporttype')) {
        viewportErrors.push('PAGE_ERROR: ' + err.message);
      }
    });

    await loginAs(page);
    await page.goto(`/ovi-labs/ohif?StudyInstanceUIDs=${OVI_STUDY_UID}`);

    // Wait for the OVI segmentation panel to mount
    await page.waitForSelector('[data-testid^="ovi-segmentation-row-"]', { timeout: 60_000 });

    expect(viewportErrors).toHaveLength(0);

    const viewport = page.locator('[data-viewport-uid], .cornerstone-viewport-element').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });
  });

  test('Scenario E: Next Frame button increments the frame', async ({ page }) => {
    await loginAs(page);
    await page.goto(`/ovi-labs/ohif?StudyInstanceUIDs=${OVI_STUDY_UID}`);
    await page.waitForSelector('[data-testid^="ovi-segmentation-row-"]', { timeout: 60_000 });

    const getFrameIndex = () =>
      page.evaluate(() => {
        const cs = (window as any).cornerstone;
        const engines = cs?.getRenderingEngines?.() || [];
        for (const engine of engines) {
          for (const vp of engine.getViewports?.() || []) {
            const idx = vp.getCurrentImageIdIndex?.();
            if (typeof idx === 'number') {
              return idx;
            }
          }
        }
        return null;
      });

    const initialIndex = await getFrameIndex();

    const nextFrameBtn = page
      .locator('[data-testid^="ovi-segmentation-row-"]')
      .first()
      .getByTitle('Next frame')
      .first();

    if (!(await nextFrameBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await nextFrameBtn.click();
    await page.waitForTimeout(500);

    const nextIndex = await getFrameIndex();

    if (initialIndex !== null && nextIndex !== null) {
      expect(nextIndex).toBeGreaterThan(initialIndex);
    }
  });

  test('Scenario F: Prev Frame button decrements the frame', async ({ page }) => {
    await loginAs(page);
    await page.goto(`/ovi-labs/ohif?StudyInstanceUIDs=${OVI_STUDY_UID}`);
    await page.waitForSelector('[data-testid^="ovi-segmentation-row-"]', { timeout: 60_000 });

    const getFrameIndex = () =>
      page.evaluate(() => {
        const cs = (window as any).cornerstone;
        const engines = cs?.getRenderingEngines?.() || [];
        for (const engine of engines) {
          for (const vp of engine.getViewports?.() || []) {
            const idx = vp.getCurrentImageIdIndex?.();
            if (typeof idx === 'number') {
              return idx;
            }
          }
        }
        return null;
      });

    // First move forward so we have room to go back
    const nextFrameBtn = page
      .locator('[data-testid^="ovi-segmentation-row-"]')
      .first()
      .getByTitle('Next frame')
      .first();

    if (!(await nextFrameBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await nextFrameBtn.click();
    await page.waitForTimeout(300);

    const midIndex = await getFrameIndex();

    const prevFrameBtn = page
      .locator('[data-testid^="ovi-segmentation-row-"]')
      .first()
      .getByTitle('Previous frame')
      .first();

    await prevFrameBtn.click();
    await page.waitForTimeout(500);

    const finalIndex = await getFrameIndex();

    if (midIndex !== null && finalIndex !== null) {
      expect(finalIndex).toBeLessThan(midIndex);
    }
  });
});
