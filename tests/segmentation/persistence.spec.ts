import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils';

const SINGLE_VIEWPORT_STUDY_UID = '2.25.886183689675766305740169196162815250747';
const AUTO_LOAD_TIMEOUT_MS = 60_000;
const AUTOSAVE_SETTLE_MS = 4_000; // 1500 ms debounce + network round-trip

// ─── Helpers ──────────────────────────────────────────────────────────────────

const waitForSegmentCards = async (page: any) => {
  await page.waitForFunction(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-cy="data-row"]')
      ).some(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
};

const ensureLabelCard = async (page: any) => {
  if ((await page.locator('[data-cy="data-row"]').count()) > 0) {
    return;
  }

  try {
    await page.waitForFunction(
      () => document.querySelectorAll('[data-cy="data-row"]').length > 0,
      undefined,
      { timeout: 10_000 }
    );
    return;
  } catch {
    // No restored labels appeared; create one for the test setup below.
  }

  await page.waitForFunction(
    () => {
      const services = (window as any).services;
      const segmentationService = services?.segmentationService;
      return (
        document.querySelectorAll('[data-cy="data-row"]').length > 0 ||
        (segmentationService?.getSegmentations?.()?.length ?? 0) > 0 ||
        /add (segmentation|labelmap)/i.test(document.body.innerText)
      );
    },
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );

  if ((await page.locator('[data-cy="data-row"]').count()) > 0) {
    return;
  }

  const addViaService = () => page.evaluate(() => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
    const activeSegmentation = activeViewportId
      ? segmentationService?.getActiveSegmentation?.(activeViewportId)
      : null;
    const segmentationId =
      activeSegmentation?.segmentationId || segmentationService?.getSegmentations?.()?.[0]?.segmentationId;
    if (!segmentationId) {
      return false;
    }
    segmentationService.addSegment(segmentationId, {
      label: 'Label 1',
      active: true,
      visibility: true,
    });
    return true;
  });

  const addedViaService = await addViaService();

  if (addedViaService) {
    await page.waitForTimeout(500);
    if ((await page.locator('[data-cy="data-row"]').count()) > 0) {
      return;
    }
  }

  const addSegmentationButton = page.getByText(/^add (segmentation|labelmap)$/i);
  await expect(addSegmentationButton).toBeVisible({ timeout: AUTO_LOAD_TIMEOUT_MS });

  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('div,span,button')).find(el =>
        /^add (segmentation|labelmap)$/i.test(el.textContent?.trim() || '')
      );
      target?.click();
    });
    await page.waitForTimeout(1000);

    if ((await page.locator('[data-cy="data-row"]').count()) > 0) {
      return;
    }

    if (await addViaService()) {
      await page.waitForTimeout(500);
      if ((await page.locator('[data-cy="data-row"]').count()) > 0) {
        return;
      }
    }

    if (await page.getByRole('button', { name: /^add (segment|label)$/i }).isVisible().catch(() => false)) {
      break;
    }
  }

  if ((await page.locator('[data-cy="data-row"]').count()) > 0) {
    return;
  }

  const addLabelButton = page.getByRole('button', { name: /^add (segment|label)$/i });
  await expect(addLabelButton).toBeAttached({ timeout: 5000 });
  await addLabelButton.click();
  await expect(page.locator('[data-cy="data-row"]')).toHaveCount(1, { timeout: 5000 });
};

const activateBrushTool = async (page: any) => {
  const brushButton = page.locator('[data-cy="Brush"]').first();
  await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });
  await brushButton.locator('button').click();
  await expect(brushButton).toHaveAttribute('data-active', 'true', { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const services = (window as any).services;
      const activeViewportId = services?.viewportGridService?.getState?.()?.activeViewportId;
      const toolGroup =
        activeViewportId &&
        services?.toolGroupService?.getToolGroupForViewport?.(activeViewportId);
      return toolGroup?.getActivePrimaryMouseButtonTool?.() === 'CircularBrush';
    },
    { timeout: 5000 }
  );
};

const drawBrushStroke = async (page: any) => {
  const canvas = page.locator('canvas.cornerstone-canvas').nth(0);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas 0 bounding box not found');
  const midX = box.x + box.width * 0.5;
  const midY = box.y + box.height * 0.5;
  await page.mouse.move(midX - 20, midY);
  await page.mouse.down();
  await page.mouse.move(midX + 20, midY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
};

const getCanvasColorStats = async (page: any, expectedRgb: number[]) => {
  return page
    .locator('canvas.cornerstone-canvas')
    .nth(0)
    .evaluate((canvas: HTMLCanvasElement, color: number[]) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { matchedPixels: 0 };
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const gray = (color[0] + color[1] + color[2]) / 3;
      const cVec = [color[0] - gray, color[1] - gray, color[2] - gray];
      const cMag = Math.hypot(cVec[0], cVec[1], cVec[2]);
      let matched = 0;
      for (let i = 0; i < data.length; i += 4) {
        const max = Math.max(data[i], data[i + 1], data[i + 2]);
        if (max <= 70) continue;
        const pg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const pVec = [data[i] - pg, data[i + 1] - pg, data[i + 2] - pg];
        const pMag = Math.hypot(pVec[0], pVec[1], pVec[2]);
        if (pMag <= 18 || cMag <= 0) continue;
        const sim =
          (pVec[0] * cVec[0] + pVec[1] * cVec[1] + pVec[2] * cVec[2]) / (pMag * cMag);
        if (sim > 0.82) matched++;
      }
      return { matchedPixels: matched, width, height };
    }, expectedRgb);
};

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe('Segmentation delete persistence', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  /**
   * Scenario 1.0 — HUD returns to "Synced" after deleting a segment card.
   *
   * Regression test for the bug where "Unsaved segmentation changes. Saving will
   * start automatically." persisted indefinitely after deletion because
   * SEGMENTATION_REPRESENTATION_MODIFIED events kept resetting the autosave debounce.
   *
   * Expected to FAIL before the debounce-separation fix,
   * PASS after (pixel and metadata saves use separate debounce timers).
   */
  test('HUD shows Synced after deleting a segment card', async ({ page }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await ensureLabelCard(page);

    // Wait for initial load to settle — HUD should be Synced before we act
    await expect(page.locator('[data-cy="persistence-hud"]')).toHaveAttribute(
      'data-hud-status',
      'synced',
      { timeout: AUTO_LOAD_TIMEOUT_MS }
    );

    // Delete the first segment card
    const dataRow = page.locator('[data-cy="data-row"]').first();
    await dataRow.hover();
    await dataRow.locator('button[aria-label="Actions"]').click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.getByRole('button', { name: /^Delete$/i }).click();

    // HUD must transition to dirty immediately
    await expect(page.locator('[data-cy="persistence-hud"]')).toHaveAttribute(
      'data-hud-status',
      'dirty',
      { timeout: 3000 }
    );

    // After autosave settles, HUD must return to synced — NOT stay dirty
    await expect(
      page.locator('[data-cy="persistence-hud"]'),
      'HUD should return to Synced after autosave completes following segment deletion'
    ).toHaveAttribute('data-hud-status', 'synced', { timeout: AUTOSAVE_SETTLE_MS + 5_000 });
  });

  /**
   * Scenario 1.1 — Segment delete issues DELETE request to backend.
   *
   * Expected to FAIL before the autosave fix (deleteEmptyFrames: false → no DELETE request),
   * and PASS after the fix (deleteEmptyFrames: true → DELETE request per cleared frame).
   */
  test('deleting a segment sends DELETE request to segmentation-frames backend', async ({
    page,
  }) => {
    // Arm listener before navigation so no request is missed
    const deleteRequestPromise = page.waitForRequest(
      (req: any) =>
        req.method() === 'DELETE' && req.url().includes('segmentation-frames'),
      { timeout: AUTOSAVE_SETTLE_MS + 5_000 }
    );

    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await waitForSegmentCards(page);

    // Draw a stroke so the backend has at least one frame to delete
    await activateBrushTool(page);
    await drawBrushStroke(page);

    // Wait for the stroke autosave to land on the backend
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    // Open the Actions dropdown on the first segment card and choose Delete
    const dataRow = page.locator('[data-cy="data-row"]').first();
    await dataRow.hover();
    await dataRow.locator('button[aria-label="Actions"]').click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();

    // Confirm in the modal
    await page.getByRole('button', { name: /^Delete$/i }).click();

    // Assert: a DELETE request to the segmentation-frames endpoint must follow
    const deleteRequest = await deleteRequestPromise;
    expect(deleteRequest.url()).toContain('segmentation-frames');
  });

  /**
   * Scenario 1.2 — Deleted label pixels are absent after page reload.
   *
   * Expected to FAIL before fix (pixels restored from backend on reload),
   * and PASS after fix (backend frames deleted, reload shows empty canvas).
   */
  test('deleted label pixels are absent after page reload', async ({ page }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await ensureLabelCard(page);

    // Capture the label color from the first label card before deletion
    const segmentRgb: number[] = await page.evaluate(() => {
      const card = Array.from(
        document.querySelectorAll<HTMLElement>('[data-cy="data-row"]')
      )[0];
      if (!card) return [255, 0, 0];
      const colorEl = card.querySelector<HTMLElement>('[style*="background"]');
      const match = colorEl
        ? window.getComputedStyle(colorEl).backgroundColor.match(/\d+/g)
        : null;
      return match ? match.slice(0, 3).map(Number) : [255, 0, 0];
    });

    // Draw a stroke with the active label so pixels exist in backend
    await activateBrushTool(page);
    await drawBrushStroke(page);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    // Delete the label and confirm
    const dataRow = page.locator('[data-cy="data-row"]').first();
    await dataRow.hover();
    await dataRow.locator('button[aria-label="Actions"]').click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.getByRole('button', { name: /^Delete$/i }).click();

    // Wait for the delete-triggered autosave to complete
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    // Reload and re-wait for the viewer to settle
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Give auto-load time to restore from backend (if any frames remain)
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const placeholder = page.locator('[data-cy="segment-empty-state"]');
    await expect(placeholder, 'Deleted label should reload into the empty label state').toHaveText(
      /No Label/i,
      { timeout: 5000 }
    );

    await page.waitForTimeout(AUTOSAVE_SETTLE_MS + 3000);
    await expect(
      page.locator('[data-cy="data-row"]'),
      'Deleted label card must not be recreated after delayed restore/autosave work'
    ).toHaveCount(0);
    await expect(placeholder, 'Empty label state must remain stable after delayed work').toHaveText(
      /No Label/i
    );

    // The deleted label's color pixels must NOT appear on the canvas
    const stats = await getCanvasColorStats(page, segmentRgb);
    expect(
      stats.matchedPixels,
      `Expected 0 label-color pixels after reload; got ${stats.matchedPixels} (rgb=${JSON.stringify(segmentRgb)})`
    ).toBe(0);
  });

  /**
   * Scenario 5.1 — Adding a label after deleting all labels does NOT restore deleted label cards.
   *
   * Expected to FAIL before the fix (restoreFrames re-injects old segment metadata),
   * and PASS after the fix (add-segment stays in current in-memory state only).
   */
  test('add label after deleting all labels does not restore deleted label cards', async ({
    page,
  }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await waitForSegmentCards(page);

    // Draw a stroke so backend frames exist (deletion will have something to trigger on)
    await activateBrushTool(page);
    await drawBrushStroke(page);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    // Count initial label cards and collect their labels
    const initialCardCount: number = await page
      .locator('[data-cy="data-row"]')
      .filter({ hasNotText: '' })
      .count();
    expect(initialCardCount).toBeGreaterThan(0);

    const initialLabels: string[] = await page
      .locator('[data-cy="data-row"]')
      .allTextContents();

    // Delete ALL label cards one by one
    for (let i = 0; i < initialCardCount; i++) {
      const dataRow = page.locator('[data-cy="data-row"]').first();
      await dataRow.hover();
      await dataRow.locator('button[aria-label="Actions"]').click();
      await page.getByRole('menuitem', { name: /^Delete$/i }).click();
      await page.getByRole('button', { name: /^Delete$/i }).click();
      // Brief pause between deletions
      await page.waitForTimeout(300);
    }

    // All label cards should be gone
    const cardsAfterDelete = await page.locator('[data-cy="data-row"]').count();
    expect(cardsAfterDelete, 'Expected 0 label cards after deleting all').toBe(0);

    // Click "Add Segment" — this is the action that currently triggers a spurious restore
    const addSegmentButton = page.getByRole('button', { name: /^add (segment|label)$/i });
    await expect(addSegmentButton).toBeAttached({ timeout: 5000 });
    await addSegmentButton.click();

    // Allow any async work to settle (restore would take ~1s)
    await page.waitForTimeout(2000);

    // Assert: exactly ONE label card exists (the newly added label)
    const cardsAfterAdd = await page.locator('[data-cy="data-row"]').count();
    expect(
      cardsAfterAdd,
      `Expected exactly 1 new label card after Add Segment; got ${cardsAfterAdd}. ` +
        `Initial labels were: ${JSON.stringify(initialLabels)}`
    ).toBe(1);

    // Assert: the new card does NOT have any of the deleted segment labels
    const newLabels: string[] = await page.locator('[data-cy="data-row"]').allTextContents();
    for (const oldLabel of initialLabels) {
      const trimmed = oldLabel.trim();
      if (!trimmed) continue;
      expect(
        newLabels.some(l => l.includes(trimmed)),
        `Deleted segment label "${trimmed}" should not be present after Add Segment`
      ).toBe(false);
    }
  });
});

// ─── Empty-state placeholder tests ────────────────────────────────────────────

test.describe('Label empty-state placeholder', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  /**
   * Scenario 6.1 — Fresh load with no backend data shows "No Label" placeholder,
   * not an auto-created "Label 1" card.
   */
  test('fresh load with no backend data shows No Label placeholder', async ({ page }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(AUTO_LOAD_TIMEOUT_MS / 10);

    const existingCount = await page.locator('[data-cy="data-row"]').count();
    for (let i = 0; i < existingCount; i++) {
      const dataRow = page.locator('[data-cy="data-row"]').first();
      await dataRow.hover();
      await dataRow.locator('button[aria-label="Actions"]').click();
      await page.getByRole('menuitem', { name: /^Delete$/i }).click();
      await page.getByRole('button', { name: /^Delete$/i }).click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const cardCount = await page.locator('[data-cy="data-row"]').count();
    expect(cardCount, 'Expected 0 label cards on fresh load with empty backend').toBe(0);

    const placeholder = page.locator('[data-cy="segment-empty-state"]');
    await expect(placeholder, 'Expected label empty-state placeholder to be visible').toBeVisible({
      timeout: 5000,
    });
    await expect(placeholder).toHaveText(/No Label/i);
  });

  /**
   * Scenario 6.2 — Deleting all label cards shows the label placeholder immediately.
   */
  test('deleting all label cards shows empty placeholder', async ({ page }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    let cardCount = await page.locator('[data-cy="data-row"]').count();
    if (cardCount === 0) {
      const addBtn = page.getByRole('button', { name: /^add (segment|label)$/i });
      await expect(addBtn).toBeAttached({ timeout: 5000 });
      await addBtn.click();
      await page.waitForTimeout(500);
      cardCount = await page.locator('[data-cy="data-row"]').count();
    }
    expect(cardCount).toBeGreaterThan(0);

    for (let i = 0; i < cardCount; i++) {
      const dataRow = page.locator('[data-cy="data-row"]').first();
      await dataRow.hover();
      await dataRow.locator('button[aria-label="Actions"]').click();
      await page.getByRole('menuitem', { name: /^Delete$/i }).click();
      await page.getByRole('button', { name: /^Delete$/i }).click();
      await page.waitForTimeout(300);
    }

    const remaining = await page.locator('[data-cy="data-row"]').count();
    expect(remaining, 'Expected 0 label cards after deleting all').toBe(0);

    const placeholder = page.locator('[data-cy="segment-empty-state"]');
    await expect(placeholder, 'Expected label empty-state placeholder after deleting all').toBeVisible({
      timeout: 3000,
    });
    await expect(placeholder).toHaveText(/No Label/i);

    await expect(
      page.locator('[data-cy="persistence-hud"]'),
      'HUD must return to Synced after all labels deleted and autosave completes'
    ).toHaveAttribute('data-hud-status', 'synced', { timeout: AUTOSAVE_SETTLE_MS + 5_000 });
  });

  /**
   * Scenario 6.3 — Adding a label from the empty state removes the placeholder.
   */
  test('adding a label from empty state removes placeholder and shows card', async ({ page }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const existingCount = await page.locator('[data-cy="data-row"]').count();
    for (let i = 0; i < existingCount; i++) {
      const dataRow = page.locator('[data-cy="data-row"]').first();
      await dataRow.hover();
      await dataRow.locator('button[aria-label="Actions"]').click();
      await page.getByRole('menuitem', { name: /^Delete$/i }).click();
      await page.getByRole('button', { name: /^Delete$/i }).click();
      await page.waitForTimeout(300);
    }

    const placeholder = page.locator('[data-cy="segment-empty-state"]');
    await expect(placeholder).toBeVisible({ timeout: 3000 });

    const addBtn = page.getByRole('button', { name: /^add (segment|label)$/i });
    await expect(addBtn).toBeAttached({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(1000);

    await expect(placeholder, 'Placeholder should disappear after adding a label').not.toBeVisible({
      timeout: 3000,
    });

    const cardCount = await page.locator('[data-cy="data-row"]').count();
    expect(cardCount, 'Expected exactly 1 label card after adding from empty state').toBe(1);
  });

  /**
   * Scenario 6.4 — Reload after deleting all label cards shows the empty state.
   */
  test('reload after deleting all label cards shows empty state not auto-created card', async ({
    page,
  }) => {
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const existingCount = await page.locator('[data-cy="data-row"]').count();
    for (let i = 0; i < existingCount; i++) {
      const dataRow = page.locator('[data-cy="data-row"]').first();
      await dataRow.hover();
      await dataRow.locator('button[aria-label="Actions"]').click();
      await page.getByRole('menuitem', { name: /^Delete$/i }).click();
      await page.getByRole('button', { name: /^Delete$/i }).click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const cardCount = await page.locator('[data-cy="data-row"]').count();
    expect(cardCount, 'Expected 0 label cards after reload').toBe(0);

    const placeholder = page.locator('[data-cy="segment-empty-state"]');
    await expect(placeholder, 'Expected label empty-state placeholder after reload').toBeVisible({
      timeout: 5000,
    });
    await expect(placeholder).toHaveText(/No Label/i);
  });
});

// ─── Delete Labelmap ──────────────────────────────────────────────────────────

test.describe('Delete labelmap object', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await ensureLabelCard(page);
    // Ensure HUD is Synced before acting
    await expect(page.locator('[data-cy="persistence-hud"]')).toHaveAttribute(
      'data-hud-status',
      'synced',
      { timeout: AUTO_LOAD_TIMEOUT_MS }
    );
  });

  /**
   * Scenario 7.1 — Delete labelmap shows confirmation modal with red Delete button.
   *
   * Expected to FAIL before DeleteSegmentationModal was created/wired,
   * PASS after deleteSegmentationCommand shows the modal.
   */
  test('Delete labelmap shows confirmation modal with red Delete button', async ({ page }) => {
    // Open the top-level labelmap options dropdown
    await page.getByRole('button', { name: /segmentation options/i }).click();

    // Click the top-level "Delete" menu item (red text)
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();

    // Modal must appear with a confirm button
    const confirmBtn = page.locator('[data-cy="confirm-delete-segmentation"]');
    await expect(confirmBtn, 'Confirmation modal should appear').toBeVisible({ timeout: 5000 });

    // The button must have a red background class
    await expect(confirmBtn).toHaveClass(/bg-red-600/);

    // Dismiss without deleting
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(confirmBtn).not.toBeVisible({ timeout: 3000 });
  });

  /**
   * Scenario 7.2 — Confirming delete removes all label cards immediately.
   *
   * Expected to FAIL before deleteSegmentationCommand called removeSegmentationRepresentations,
   * PASS after the fix.
   */
  test('Confirming delete labelmap removes all label cards immediately', async ({
    page,
  }) => {
    // Verify there is at least one label card to begin with
    const initialCount = await page.locator('[data-cy="data-row"]').count();
    expect(initialCount, 'Test requires at least one label card').toBeGreaterThan(0);

    // Open options and confirm delete
    await page.getByRole('button', { name: /segmentation options/i }).click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.locator('[data-cy="confirm-delete-segmentation"]').click();

    // All cards must be gone immediately (no debounce needed for UI removal)
    await expect(
      page.locator('[data-cy="data-row"]'),
      'All label cards should be removed after deleting the labelmap'
    ).toHaveCount(0, { timeout: 5000 });
  });

  /**
   * Scenario 7.3 — HUD returns to Synced after deleting entire labelmap.
   *
   * Regression test: before the fix the whole-seg-removed handler did not call
   * updatePersistenceStatus('synced') so the HUD stayed on "dirty" indefinitely.
   *
   * Expected to FAIL before the fix, PASS after.
   */
  test('HUD returns to Synced after deleting entire labelmap', async ({ page }) => {
    // Open options and confirm delete
    await page.getByRole('button', { name: /segmentation options/i }).click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.locator('[data-cy="confirm-delete-segmentation"]').click();

    // HUD should immediately transition to dirty
    await expect(page.locator('[data-cy="persistence-hud"]')).toHaveAttribute(
      'data-hud-status',
      'dirty',
      { timeout: 3000 }
    );

    // Then settle to synced after backend DELETE completes
    await expect(
      page.locator('[data-cy="persistence-hud"]'),
      'HUD should return to Synced after backend deletion completes'
    ).toHaveAttribute('data-hud-status', 'synced', { timeout: AUTOSAVE_SETTLE_MS + 5_000 });
  });

  /**
   * Scenario 7.4 — Deleting labelmap sends DELETE request to backend.
   *
   * Verifies that deleteAllSegFrames is called, which issues DELETE /segmentation-frames/*.
   */
  test('Delete labelmap sends DELETE request to backend', async ({ page }) => {
    // Arm listener — must be registered before the action
    const deleteRequestPromise = page.waitForRequest(
      (req: any) =>
        req.method() === 'DELETE' && req.url().includes('segmentation-frames'),
      { timeout: AUTOSAVE_SETTLE_MS + 10_000 }
    );

    await page.getByRole('button', { name: /segmentation options/i }).click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.locator('[data-cy="confirm-delete-segmentation"]').click();

    const req = await deleteRequestPromise;
    expect(req.url()).toContain('segmentation-frames');
  });

  /**
   * Scenario 7.5 — After deleting the top-level labelmap, adding a label creates a visible card.
   *
   * Regression test for the bug where the HUD stays Unsaved and Add Segment/Label remains
   * stuck at Loading without creating a new label card after top-level deletion.
   */
  test('Add label works after deleting top-level labelmap', async ({ page }) => {
    await page.getByRole('button', { name: /segmentation options/i }).click();
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();
    await page.locator('[data-cy="confirm-delete-segmentation"]').click();

    await expect(page.locator('[data-cy="data-row"]')).toHaveCount(0, { timeout: 5000 });
    await expect(
      page.locator('[data-cy="persistence-hud"]'),
      'HUD must not remain Unsaved after deleting the top-level labelmap'
    ).toHaveAttribute('data-hud-status', 'synced', { timeout: AUTOSAVE_SETTLE_MS + 5_000 });

    const addButton = page.getByText(/^add (segmentation|labelmap)$/i);
    await expect(addButton).toBeAttached({ timeout: 5000 });
    await addButton.click();

    await expect(
      page.locator('[data-cy="data-row"]'),
      'A new label card should be visible after adding from a deleted labelmap state'
    ).toHaveCount(1, { timeout: 5000 });
    await expect(
      page.locator('[data-cy="persistence-hud"]'),
      'HUD must not get stuck Loading after adding a label from a deleted labelmap state'
    ).not.toHaveAttribute('data-hud-status', 'loading', { timeout: AUTOSAVE_SETTLE_MS + 5_000 });
    await expect(
      page.locator('[data-cy="persistence-hud"]'),
      'HUD must not remain Dirty/Unsaved after adding a label from a deleted labelmap state'
    ).not.toHaveAttribute('data-hud-status', 'dirty', { timeout: AUTOSAVE_SETTLE_MS + 5_000 });
  });
});

// ─── NIfTI export buttons ─────────────────────────────────────────────────────

test.describe('NIfTI export menu items', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${SINGLE_VIEWPORT_STUDY_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await waitForSegmentCards(page);
  });

  /**
   * Scenario 8.1 — NIfTI SEG and NIfTI IMG+SEG entries appear in the download sub-menu.
   *
   * Expected to FAIL before the NIfTI items were added to CustomDropdownMenuContent,
   * PASS after.
   */
  test('Download sub-menu contains NIfTI SEG and NIfTI IMG+SEG entries', async ({ page }) => {
    // Open the segmentation-level options dropdown
    await page.getByRole('button', { name: /segmentation options/i }).click();

    // Hover/click the Download sub-menu trigger
    const downloadTrigger = page.getByRole('menuitem', { name: /download/i });
    await expect(downloadTrigger).toBeVisible({ timeout: 5000 });
    await downloadTrigger.hover();

    // Both NIfTI items must be visible
    await expect(
      page.getByRole('menuitem', { name: /NIfTI SEG/i }),
      'NIfTI SEG menu item should be visible'
    ).toBeVisible({ timeout: 3000 });

    await expect(
      page.getByRole('menuitem', { name: /NIfTI IMG\+SEG/i }),
      'NIfTI IMG+SEG menu item should be visible'
    ).toBeVisible({ timeout: 3000 });
  });

  /**
   * Scenario 8.2 — Clicking NIfTI SEG triggers a file download.
   */
  test('NIfTI SEG download triggers a file download', async ({ page }) => {
    // Listen for download event before clicking
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

    await page.getByRole('button', { name: /segmentation options/i }).click();
    const downloadTrigger = page.getByRole('menuitem', { name: /download/i });
    await downloadTrigger.hover();
    await page.locator('[data-cy="download-nifti-seg"]').click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.nii\.gz$/);
  });
});
