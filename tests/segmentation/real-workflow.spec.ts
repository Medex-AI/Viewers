import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils';
import {
  AUTOSAVE_SETTLE_MS,
  STACK_WORKFLOW_STUDY_UID,
  activateCanvas,
  activateBrushTool,
  cleanupWorkflowTestSegmentations,
  createIsolatedLabelmapForActiveViewport,
  deleteSegmentationViaService,
  deleteActiveLabelViaUi,
  drawManualContour,
  drawBrushStroke,
  drawBrushStrokeOnCanvas,
  expectHudSynced,
  expectNoSegmentationRemains,
  getCanvasActiveSegmentPixelCount,
  getVisibleCanvasOrder,
  getWorkflowState,
  openSegmentationStudy,
  reloadSegmentationWorkflow,
  renameActiveLabelViaUi,
  resetActiveBackendSegmentationResources,
  setActiveLabelColorViaCommand,
  stepCanvasSlice,
} from './realWorkflowHelpers';

const prepareFreshStackWorkflow = async (page: any) => {
  await loginAs(page);
  await openSegmentationStudy(page, STACK_WORKFLOW_STUDY_UID, 4, false);
  await cleanupWorkflowTestSegmentations(page);
  await resetActiveBackendSegmentationResources(page);
  await reloadSegmentationWorkflow(page, STACK_WORKFLOW_STUDY_UID, 4);
  await expectHudSynced(page);
  return getWorkflowState(page);
};

const withIsolatedLabelmap = async (
  page: any,
  labelmapLabel: string,
  body: (context: {
    initial: Awaited<ReturnType<typeof getWorkflowState>>;
    isolated: Awaited<ReturnType<typeof createIsolatedLabelmapForActiveViewport>>;
  }) => Promise<void>
) => {
  const initial = await prepareFreshStackWorkflow(page);
  const isolated = await createIsolatedLabelmapForActiveViewport(page, labelmapLabel);
  let bodyError: unknown;

  try {
    await body({ initial, isolated });
  } catch (error) {
    bodyError = error;
  } finally {
    await cleanupWorkflowTestSegmentations(page).catch(() => null);
    await deleteSegmentationViaService(page, isolated.segmentationId).catch(() => null);
    await expectHudSynced(page).catch(() => null);
    if (!bodyError) {
      await expectNoSegmentationRemains(page, {
        segmentationId: isolated.segmentationId,
        labelmapLabel: isolated.labelmapLabel,
      });
    }
  }

  if (bodyError) {
    throw bodyError;
  }
};

test.describe('Real segmentation workflow consistency', () => {
  test('fresh stack label rename survives refresh across UI service and backend state', async ({
    page,
  }) => {
    const labelName = `Workflow Rename ${Date.now()}`;
    await withIsolatedLabelmap(page, `Workflow Test Labelmap Rename ${Date.now()}`, async ({
      initial,
      isolated,
    }) => {

      await renameActiveLabelViaUi(page, labelName);
      await expect(page.locator('[data-cy="data-row"]')).toContainText(labelName);
      await expectHudSynced(page);

      const afterRename = await getWorkflowState(page);
      expect(afterRename.segmentationId).toBe(isolated.segmentationId);
      expect(afterRename.label).toBe(labelName);
      expect(
        afterRename.backendDocuments?.some(document =>
          Object.values(document.labels || {}).some((label: any) => label?.name === labelName)
        ),
        `Expected backend metadata document to contain renamed label: ${JSON.stringify({
          initial,
          isolated,
          afterRename,
        })}`
      ).toBe(true);

      await reloadSegmentationWorkflow(page, STACK_WORKFLOW_STUDY_UID, 4, false);
      await expectHudSynced(page);

      const afterReload = await getWorkflowState(page);
      expect(
        afterReload.domCards.some(card => card.includes(labelName)),
        `Expected DOM card to restore renamed label: ${JSON.stringify({ afterRename, afterReload })}`
      ).toBe(true);
      expect(afterReload.label).toBe(labelName);
    });
  });

  test('fresh stack label color survives refresh across service representation and backend state', async ({
    page,
  }) => {
    const color = [12, 200, 70, 255];
    await withIsolatedLabelmap(page, `Workflow Test Labelmap Color ${Date.now()}`, async ({
      initial,
      isolated,
    }) => {

      await setActiveLabelColorViaCommand(page, color);
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterColor = await getWorkflowState(page);
      expect(afterColor.segmentationId).toBe(isolated.segmentationId);
      expect(afterColor.color?.slice(0, 4)).toEqual(color);
      expect(
        afterColor.backendDocuments?.some(document =>
          Object.values(document.labels || {}).some(
            (label: any) => String(label?.color || '').toUpperCase() === '#0CC846'
          )
        ),
        `Expected backend metadata document to contain changed color: ${JSON.stringify({
          initial,
          isolated,
          afterColor,
        })}`
      ).toBe(true);

      await reloadSegmentationWorkflow(page, STACK_WORKFLOW_STUDY_UID, 4, false);
      await expectHudSynced(page);

      const afterReload = await getWorkflowState(page);
      expect(
        afterReload.color?.slice(0, 4),
        `Expected service color to restore after refresh: ${JSON.stringify({ afterColor, afterReload })}`
      ).toEqual(color);
    });
  });

  test('fresh stack label delete survives refresh across UI service and backend state', async ({
    page,
  }) => {
    const labelName = `Workflow Delete ${Date.now()}`;
    await withIsolatedLabelmap(page, `Workflow Test Labelmap Delete ${Date.now()}`, async ({
      initial,
      isolated,
    }) => {

      await renameActiveLabelViaUi(page, labelName);
      await expect(page.locator('[data-cy="data-row"]')).toContainText(labelName);
      await expectHudSynced(page);

      const afterRename = await getWorkflowState(page);
      expect(afterRename.segmentationId).toBe(isolated.segmentationId);
      expect(
        afterRename.backendDocuments?.some(document =>
          Object.values(document.labels || {}).some((label: any) => label?.name === labelName)
        ),
        `Expected backend metadata document before delete: ${JSON.stringify({
          initial,
          isolated,
          afterRename,
        })}`
      ).toBe(true);

      await deleteActiveLabelViaUi(page);
      await expect(page.locator('body')).not.toContainText(labelName);
      await expectHudSynced(page);

      const afterDelete = await getWorkflowState(page);
      expect(
        afterDelete.backendDocuments?.some(document =>
          Object.values(document.labels || {}).some((label: any) => label?.name === labelName)
        ),
        `Expected backend metadata to remove deleted label: ${JSON.stringify({ afterRename, afterDelete })}`
      ).toBe(false);

      await reloadSegmentationWorkflow(page, STACK_WORKFLOW_STUDY_UID, 4, false);
      await expectHudSynced(page);

      const afterReload = await getWorkflowState(page);
      expect(
        afterReload.domCards.some(card => card.includes(labelName)),
        `Expected deleted label not to restore after refresh: ${JSON.stringify({ afterDelete, afterReload })}`
      ).toBe(false);
    });
  });

  test('brush pixels for deleted label stay removed after refresh', async ({ page }) => {
    const labelName = `Workflow Brush Delete ${Date.now()}`;
    await withIsolatedLabelmap(page, `Workflow Test Labelmap Brush ${Date.now()}`, async ({
      initial,
      isolated,
    }) => {

      await renameActiveLabelViaUi(page, labelName);
      await expect(page.locator('[data-cy="data-row"]')).toContainText(labelName);
      await expectHudSynced(page);

      await activateBrushTool(page);
      await drawBrushStroke(page);
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterBrush = await getWorkflowState(page);
      expect(afterBrush.segmentationId).toBe(isolated.segmentationId);
      expect(
        Number(afterBrush.pixelCountsBySegment[String(afterBrush.segmentIndex || 1)] || 0),
        `Expected brush to create pixels before deletion: ${JSON.stringify({
          initial,
          isolated,
          afterBrush,
        })}`
      ).toBeGreaterThan(0);

      await deleteActiveLabelViaUi(page);
      await expect(page.locator('body')).not.toContainText(labelName);
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterDelete = await getWorkflowState(page);
      const deletedIndex = String(afterBrush.segmentIndex || 1);
      expect(
        Number(afterDelete.pixelCountsBySegment[deletedIndex] || 0),
        `Expected deleted label pixels to be cleared immediately: ${JSON.stringify({ afterBrush, afterDelete })}`
      ).toBe(0);

      await reloadSegmentationWorkflow(page, STACK_WORKFLOW_STUDY_UID, 4, false);
      await expectHudSynced(page);

      const afterReload = await getWorkflowState(page);
      expect(
        Number(afterReload.pixelCountsBySegment[deletedIndex] || 0),
        `Expected deleted label pixels not to restore after refresh: ${JSON.stringify({ afterDelete, afterReload })}`
      ).toBe(0);
      expect(afterReload.domCards.some(card => card.includes(labelName))).toBe(false);
    });
  });

  test('mixed contour and brush pixels for deleted label stay removed after refresh', async ({
    page,
  }) => {
    const labelName = `Workflow Mixed Delete ${Date.now()}`;
    await withIsolatedLabelmap(page, `Workflow Test Labelmap Mixed ${Date.now()}`, async ({
      initial,
      isolated,
    }) => {

      await renameActiveLabelViaUi(page, labelName);
      await expect(page.locator('[data-cy="data-row"]')).toContainText(labelName);
      await expectHudSynced(page);

      const contourResult = await drawManualContour(page);
      expect(contourResult?.result, `Expected contour draw to succeed: ${JSON.stringify(contourResult)}`).toBeTruthy();

      await activateBrushTool(page);
      await drawBrushStroke(page);
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterDraw = await getWorkflowState(page);
      expect(afterDraw.segmentationId).toBe(isolated.segmentationId);
      const deletedIndex = String(afterDraw.segmentIndex || 1);
      expect(
        Number(afterDraw.pixelCountsBySegment[deletedIndex] || 0),
        `Expected contour+brush to create pixels before deletion: ${JSON.stringify({
          initial,
          isolated,
          afterDraw,
        })}`
      ).toBeGreaterThan(0);

      await deleteActiveLabelViaUi(page);
      await expect(page.locator('body')).not.toContainText(labelName);
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterDelete = await getWorkflowState(page);
      expect(
        Number(afterDelete.pixelCountsBySegment[deletedIndex] || 0),
        `Expected mixed contour+brush pixels to be cleared immediately: ${JSON.stringify({
          afterDraw,
          afterDelete,
        })}`
      ).toBe(0);

      await reloadSegmentationWorkflow(page, STACK_WORKFLOW_STUDY_UID, 4, false);
      await expectHudSynced(page);

      const afterReload = await getWorkflowState(page);
      expect(
        Number(afterReload.pixelCountsBySegment[deletedIndex] || 0),
        `Expected mixed contour+brush pixels not to restore after refresh: ${JSON.stringify({
          afterDelete,
          afterReload,
        })}`
      ).toBe(0);
      expect(afterReload.domCards.some(card => card.includes(labelName))).toBe(false);
    });
  });

  test('viewport 4 time-series brush pixels do not leak across time frames', async ({ page }) => {
    const initial = await prepareFreshStackWorkflow(page);
    const color = [12, 200, 70, 255];
    const canvasOrder = await getVisibleCanvasOrder(page);
    expect(
      canvasOrder.length,
      `Expected four visible canvases for viewport-4 time-series check: ${JSON.stringify({
        initial,
        canvasOrder,
      })}`
    ).toBeGreaterThanOrEqual(4);

    const targetCanvas = canvasOrder[3];
    let isolated: Awaited<ReturnType<typeof createIsolatedLabelmapForActiveViewport>> | undefined;
    try {
      await activateCanvas(page, targetCanvas.index);
      isolated = await createIsolatedLabelmapForActiveViewport(
        page,
        `Workflow Test Labelmap VP4 Brush ${Date.now()}`
      );
      await setActiveLabelColorViaCommand(page, color);
      await page.waitForTimeout(500);

      await activateBrushTool(page);
      const beforeDraw = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      await drawBrushStrokeOnCanvas(page, targetCanvas.index);
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterDraw = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      expect(
        afterDraw.count,
        `Expected brush pixels on viewport 4 before stepping time: ${JSON.stringify({
          targetCanvas,
          beforeDraw,
          afterDraw,
        })}`
      ).toBeGreaterThan(beforeDraw.count);

      const forwardStep = await stepCanvasSlice(page, targetCanvas.index, 1);
      expect(
        forwardStep.toIndex,
        `Expected viewport 4 to step to another time/frame: ${JSON.stringify({
          targetCanvas,
          forwardStep,
        })}`
      ).toBe(forwardStep.requestedIndex);

      const afterStep = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      expect(
        afterStep.count,
        `Viewport 4 labelmap pixels should not leak across time frames: ${JSON.stringify({
          targetCanvas,
          beforeDraw,
          afterDraw,
          forwardStep,
          afterStep,
        })}`
      ).toBeLessThanOrEqual(beforeDraw.count);

      const backStep = await stepCanvasSlice(
        page,
        targetCanvas.index,
        forwardStep.delta === 1 ? -1 : 1
      );
      expect(backStep.toIndex).toBe(forwardStep.fromIndex);

      const afterReturn = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      expect(
        afterReturn.count,
        `Viewport 4 original time/frame pixels should remain after round-trip: ${JSON.stringify({
          targetCanvas,
          beforeDraw,
          afterDraw,
          forwardStep,
          backStep,
          afterReturn,
        })}`
      ).toBeGreaterThan(beforeDraw.count);
    } finally {
      if (isolated) {
        await cleanupWorkflowTestSegmentations(page).catch(() => null);
        await deleteSegmentationViaService(page, isolated.segmentationId).catch(() => null);
        await expectNoSegmentationRemains(page, {
          segmentationId: isolated.segmentationId,
          labelmapLabel: isolated.labelmapLabel,
        }).catch(() => null);
      }
    }
  });

  test('viewport 4 time-series contour pixels do not leak across time frames', async ({ page }) => {
    const initial = await prepareFreshStackWorkflow(page);
    const color = [234, 179, 8, 255];
    const canvasOrder = await getVisibleCanvasOrder(page);
    expect(
      canvasOrder.length,
      `Expected four visible canvases for viewport-4 contour time-series check: ${JSON.stringify({
        initial,
        canvasOrder,
      })}`
    ).toBeGreaterThanOrEqual(4);

    const targetCanvas = canvasOrder[3];
    let isolated: Awaited<ReturnType<typeof createIsolatedLabelmapForActiveViewport>> | undefined;
    try {
      await activateCanvas(page, targetCanvas.index);
      isolated = await createIsolatedLabelmapForActiveViewport(
        page,
        `Workflow Test Labelmap VP4 Contour ${Date.now()}`
      );
      await setActiveLabelColorViaCommand(page, color);
      await page.waitForTimeout(500);

      const beforeDraw = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      const contourResult = await drawManualContour(page, 0.055, targetCanvas.index);
      expect(contourResult?.result, `Expected viewport 4 contour draw: ${JSON.stringify(contourResult)}`).toBeTruthy();
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
      await expectHudSynced(page);

      const afterDraw = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      expect(
        afterDraw.count,
        `Expected contour pixels on viewport 4 before stepping time: ${JSON.stringify({
          targetCanvas,
          beforeDraw,
          afterDraw,
        })}`
      ).toBeGreaterThan(beforeDraw.count);

      const forwardStep = await stepCanvasSlice(page, targetCanvas.index, 1);
      expect(forwardStep.toIndex).toBe(forwardStep.requestedIndex);

      const afterStep = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      expect(
        afterStep.count,
        `Viewport 4 contour labelmap pixels should not leak across time frames: ${JSON.stringify({
          targetCanvas,
          beforeDraw,
          afterDraw,
          forwardStep,
          afterStep,
        })}`
      ).toBeLessThanOrEqual(beforeDraw.count);

      const backStep = await stepCanvasSlice(
        page,
        targetCanvas.index,
        forwardStep.delta === 1 ? -1 : 1
      );
      expect(backStep.toIndex).toBe(forwardStep.fromIndex);

      const afterReturn = await getCanvasActiveSegmentPixelCount(page, targetCanvas.index);
      expect(
        afterReturn.count,
        `Viewport 4 original contour time/frame pixels should remain after round-trip: ${JSON.stringify({
          targetCanvas,
          beforeDraw,
          afterDraw,
          forwardStep,
          backStep,
          afterReturn,
        })}`
      ).toBeGreaterThan(beforeDraw.count);
    } finally {
      if (isolated) {
        await cleanupWorkflowTestSegmentations(page).catch(() => null);
        await deleteSegmentationViaService(page, isolated.segmentationId).catch(() => null);
        await expectNoSegmentationRemains(page, {
          segmentationId: isolated.segmentationId,
          labelmapLabel: isolated.labelmapLabel,
        }).catch(() => null);
      }
    }
  });
});
