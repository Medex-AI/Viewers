import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils';
import {
  AUTOSAVE_SETTLE_MS,
  OVI_AXIAL_SERIES_UID,
  OVI_STUDY_UID,
  activateOviBrushTool,
  activateOviManualContourTool,
  cleanupOviBackend,
  cleanupOviSegmentations,
  drawBrushStrokeOnCanvas,
  drawManualContour,
  expectOviBackendFrames,
  getOviState,
  openOviStudy,
  stepOviCanvasSlice,
} from './oviWorkflowHelpers';

test.describe('OVI Labs segmentation regression', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await openOviStudy(page);
    await cleanupOviSegmentations(page);
    await cleanupOviBackend(page);
    await page.reload();
    await openOviStudy(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupOviSegmentations(page).catch(() => null);
    await cleanupOviBackend(page).catch(() => null);
  });

  test('contour and brush both write canonical shared Ovi Lab pixels @debug', async ({ page }) => {
    await activateOviManualContourTool(page);
    const beforeContour = await getOviState(page);
    await drawManualContour(page, 0.055, 0);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const afterContour = await getOviState(page);
    expect(afterContour.segmentationLabel).toBe('Ovi Lab');
    expect(afterContour.segmentationId).toBeTruthy();
    expect(afterContour.activeSegmentIndex).toBeTruthy();
    expect(
      afterContour.visibleManualContoursOnCurrentFrame,
      `Expected no visible contour overlay after commit: ${JSON.stringify(afterContour)}`
    ).toBe(0);
    expect(
      Number(afterContour.currentFramePixelCountsBySegment[String(afterContour.activeSegmentIndex)] || 0),
      `Expected contour draw to add pixels: ${JSON.stringify({ beforeContour, afterContour })}`
    ).toBeGreaterThan(
      Number(beforeContour.currentFramePixelCountsBySegment[String(afterContour.activeSegmentIndex)] || 0)
    );

    await activateOviBrushTool(page);
    const beforeBrush = await getOviState(page);
    await drawBrushStrokeOnCanvas(page, 0);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const afterBrush = await getOviState(page);
    expect(afterBrush.segmentationId).toBe(afterContour.segmentationId);
    expect(afterBrush.activeSegmentIndex).toBe(afterContour.activeSegmentIndex);
    expect(
      Number(afterBrush.pixelCountsBySegment[String(afterBrush.activeSegmentIndex)] || 0),
      `Expected brush draw to add pixels in same shared segment: ${JSON.stringify({
        beforeBrush,
        afterBrush,
      })}`
    ).toBeGreaterThan(Number(beforeBrush.pixelCountsBySegment[String(afterBrush.activeSegmentIndex)] || 0));
  });

  test('OVI manual contour writes stay on the active slice only @debug', async ({ page }) => {
    await activateOviManualContourTool(page);
    await drawManualContour(page, 0.055, 0);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const frameA = await getOviState(page);
    const activeSegmentIndex = String(frameA.activeSegmentIndex || 1);
    const frameAPixels = Number(frameA.currentFramePixelCountsBySegment[activeSegmentIndex] || 0);
    expect(
      frameA.visibleManualContoursOnCurrentFrame,
      `Expected no visible contour overlay on frame A after commit: ${JSON.stringify(frameA)}`
    ).toBe(0);
    expect(frameAPixels).toBeGreaterThan(0);

    const sliceStep = await stepOviCanvasSlice(page, 0, 1);
    expect(sliceStep.toIndex).not.toBe(sliceStep.fromIndex);

    const frameBBeforeDraw = await getOviState(page);
    expect(Number(frameBBeforeDraw.currentFramePixelCountsBySegment[activeSegmentIndex] || 0)).toBe(0);
    expect(frameBBeforeDraw.currentImageId).not.toBe(frameA.currentImageId);

    await drawManualContour(page, 0.045, 0);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const frameBAfterDraw = await getOviState(page);
    expect(
      frameBAfterDraw.visibleManualContoursOnCurrentFrame,
      `Expected no visible contour overlay on frame B after commit: ${JSON.stringify(frameBAfterDraw)}`
    ).toBe(0);
    expect(Number(frameBAfterDraw.currentFramePixelCountsBySegment[activeSegmentIndex] || 0)).toBeGreaterThan(0);

    await stepOviCanvasSlice(page, 0, -1);
    const frameAReturn = await getOviState(page);
    expect(frameAReturn.currentImageId).toBe(frameA.currentImageId);
    expect(Number(frameAReturn.currentFramePixelCountsBySegment[activeSegmentIndex] || 0)).toBe(frameAPixels);
  });

  test('OVI contour and brush edits persist across reload @debug', async ({ page }) => {
    await activateOviManualContourTool(page);
    await drawManualContour(page, 0.055, 0);
    await activateOviBrushTool(page);
    await drawBrushStrokeOnCanvas(page, 0);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);
    await expectOviBackendFrames(page);

    const beforeReload = await getOviState(page);
    const segmentIndex = String(beforeReload.activeSegmentIndex || 1);
    expect(Number(beforeReload.pixelCountsBySegment[segmentIndex] || 0)).toBeGreaterThan(0);
    expect((beforeReload.backendFrames || []).length).toBeGreaterThan(0);

    await page.goto(`/ovi-labs?StudyInstanceUIDs=${OVI_STUDY_UID}`);
    await openOviStudy(page);
    await page.waitForFunction(
      expectedSegmentIndex => {
        const services = (window as any).services;
        const { segmentationService, viewportGridService } = services || {};
        const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
        const activeSegmentation = activeViewportId
          ? segmentationService?.getActiveSegmentation?.(activeViewportId)
          : null;

        if (!String(activeSegmentation?.label || '').includes('Ovi Lab')) {
          return false;
        }

        const labelmapData = activeSegmentation?.representationData?.Labelmap;
        for (const imageId of labelmapData?.imageIds || []) {
          const image = (window as any).cornerstone?.cache?.getImage?.(imageId);
          const scalarData = image?.voxelManager?.getScalarData?.();
          if (!scalarData) {
            continue;
          }
          for (let i = 0; i < scalarData.length; i += 1) {
            if (String(scalarData[i]) === expectedSegmentIndex) {
              return true;
            }
          }
        }

        return false;
      },
      segmentIndex,
      { timeout: 60_000 }
    );

    const afterReload = await getOviState(page);
    expect(afterReload.segmentationLabel).toBe('Ovi Lab');
    expect(Number(afterReload.pixelCountsBySegment[segmentIndex] || 0)).toBeGreaterThan(0);
    expect((afterReload.backendFrames || []).length).toBeGreaterThan(0);
  });

  test('OVI edits are visible in segmentation mode shared state @debug', async ({ page }) => {
    await activateOviManualContourTool(page);
    await drawManualContour(page, 0.055, 0);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    const oviState = await getOviState(page);
    expect(Number(oviState.pixelCountsBySegment[String(oviState.activeSegmentIndex || 1)] || 0)).toBeGreaterThan(0);

    await page.goto(
      `/segmentation/orthanc-medex?StudyInstanceUIDs=${OVI_STUDY_UID}&SeriesInstanceUID=${OVI_AXIAL_SERIES_UID}`
    );
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => {
        const services = (window as any).services;
        const segmentations = services?.segmentationService?.getSegmentations?.() || [];
        return segmentations.some((seg: any) => String(seg?.label || '').includes('Ovi Lab'));
      },
      undefined,
      { timeout: 60_000 }
    );

    const segmentationState = await page.evaluate(() => {
      const services = (window as any).services;
       const { segmentationService } = services || {};
       const segmentations = segmentationService?.getSegmentations?.() || [];
       const activeSegmentation = segmentations.find((seg: any) =>
         String(seg?.label || '').includes('Ovi Lab')
       );
       const labelmapData = activeSegmentation?.representationData?.Labelmap;
       const counts: Record<string, number> = {};
      for (const imageId of labelmapData?.imageIds || []) {
        const image = (window as any).cornerstone?.cache?.getImage?.(imageId);
        const scalarData = image?.voxelManager?.getScalarData?.();
        if (!scalarData) {
          continue;
        }
        for (let i = 0; i < scalarData.length; i += 1) {
          const value = scalarData[i];
          if (value > 0) {
            counts[String(value)] = (counts[String(value)] || 0) + 1;
          }
        }
      }
      return {
        segmentationLabel: activeSegmentation?.label,
        pixelCountsBySegment: counts,
      };
    });

    expect(segmentationState.segmentationLabel).toBeTruthy();
    expect(
      Object.values(segmentationState.pixelCountsBySegment).some((count: any) => Number(count) > 0),
      `Expected segmentation mode to see shared pixels from OVI Labs: ${JSON.stringify({
        oviState,
        segmentationState,
      })}`
    ).toBe(true);
  });
});
