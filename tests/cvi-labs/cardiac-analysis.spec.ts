import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils/loginAs';
import {
  AUTO_LOAD_TIMEOUT_MS,
  STACK_WORKFLOW_STUDY_UID,
  drawManualContour,
  getCanvasActiveSegmentPixelCount,
  openSegmentationStudy,
  waitForAutoCreatedLabelmap,
} from '../segmentation/realWorkflowHelpers';

const CVI_MODE = 'cvi-labs';
const SEG_MODE_PATH = '/segmentation/orthanc-medex';

async function openCviStudy(page, studyInstanceUID = STACK_WORKFLOW_STUDY_UID) {
  await page.goto(`/${CVI_MODE}?StudyInstanceUIDs=${studyInstanceUID}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => document.querySelectorAll('canvas.cornerstone-canvas').length >= 1,
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  await expect(page.getByTestId('cardiac-viewer-panel')).toBeVisible({
    timeout: AUTO_LOAD_TIMEOUT_MS,
  });
}

async function getSharedSegmentationState(page) {
  return page.evaluate(() => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
    const activeSegmentation = activeViewportId
      ? segmentationService?.getActiveSegmentation?.(activeViewportId)
      : null;
    const segmentationId = activeSegmentation?.segmentationId || activeSegmentation?.id || null;
    const segmentation = segmentationId
      ? segmentationService?.getSegmentation?.(segmentationId)
      : null;
    const labelmapData = segmentation?.representationData?.Labelmap;
    const pixelCountsBySegment: Record<string, number> = {};

    for (const imageId of labelmapData?.imageIds || []) {
      const image = (window as any).cornerstone?.cache?.getImage?.(imageId);
      const scalarData = image?.voxelManager?.getScalarData?.();
      if (!scalarData) {
        continue;
      }

      for (let i = 0; i < scalarData.length; i += 1) {
        const value = scalarData[i];
        if (value > 0) {
          pixelCountsBySegment[String(value)] = (pixelCountsBySegment[String(value)] || 0) + 1;
        }
      }
    }

    return {
      activeViewportId,
      segmentationId,
      segmentationLabel: segmentation?.label || activeSegmentation?.label || null,
      segmentLabels: Object.values(segmentation?.segments || {}).map((segment: any) => segment?.label),
      pixelCountsBySegment,
    };
  });
}

async function createCompatibleSegmentationInSegmentationMode(page) {
  await openSegmentationStudy(page, STACK_WORKFLOW_STUDY_UID, 1, false);
  await waitForAutoCreatedLabelmap(page, false);

  const result = await page.evaluate(() => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const viewportId = viewportGridService?.getState?.()?.activeViewportId;

    if (!viewportId || !segmentationService) {
      return null;
    }

    const segmentationId = `e2e-cvi-shared-${Date.now()}`;

    return (window as any).commandsManager
      .runCommand('createLabelmapForViewport', {
        viewportId,
        options: {
          segmentationId,
          label: 'Cvi Lab',
          createInitialSegment: true,
        },
      })
      .then(async (generatedSegmentationId: string) => {
        segmentationService.setSegmentLabel(generatedSegmentationId, 1, 'LV Cavity');
        segmentationService.addSegment(generatedSegmentationId, {
          segmentIndex: 2,
          label: 'Myocardium',
        });
        segmentationService.addSegment(generatedSegmentationId, {
          segmentIndex: 3,
          label: 'RV Cavity',
        });
        segmentationService.setActiveSegmentation(viewportId, segmentationId);
        segmentationService.setActiveSegment(segmentationId, 1);
        return { segmentationId: generatedSegmentationId };
      });
  });

  if (!result?.segmentationId) {
    throw new Error('Failed to create compatible shared segmentation for Cvi test');
  }

  await page.evaluate(async () => {
    const testApi = (window as any).__medexSegmentationTestApi;
    await testApi?.saveActiveSegmentation?.();
  });

  return result;
}

test.describe('Cvi Labs cardiac analysis', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('uses Cvi naming and shows only cardiac analysis sections', async ({ page }) => {
    await openCviStudy(page);

    // ROI Preview heading always visible
    await expect(page.getByText('ROI Preview')).toBeVisible();

    // Cardiac segment labels always visible in top section
    await expect(page.getByTestId('label-lv_cavity')).toBeVisible();
    await expect(page.getByTestId('label-myocardium')).toBeVisible();
    await expect(page.getByTestId('label-rv_cavity')).toBeVisible();

    // Tabs are always visible
    await expect(page.locator('[data-cy="tab-metrics"]')).toBeVisible();
    await expect(page.locator('[data-cy="tab-vtc"]')).toBeVisible();
    await expect(page.locator('[data-cy="tab-wallthickness"]')).toBeVisible();

    // VTC chart renders when VTC tab is active
    await page.locator('[data-cy="tab-vtc"]').click();
    await expect(page.locator('[data-cy="cardiac-viewer-panel"] svg').first()).toBeVisible({ timeout: 5000 });

    // Wall Thickness chart renders when its tab is active
    await page.locator('[data-cy="tab-wallthickness"]').click();
    await expect(page.locator('[data-cy="cardiac-viewer-panel"] svg').first()).toBeVisible({ timeout: 5000 });

    // No OVI Labs content
    await expect(page.getByText(/Uterine cavity/i)).toHaveCount(0);
    await expect(page.getByText(/Endometrium/i)).toHaveCount(0);
    await expect(page.getByText(/Junctional zone/i)).toHaveCount(0);
    await expect(page.getByText(/^Kymograph$/i)).toHaveCount(0);
    await expect(page.getByText(/^FFT$/i)).toHaveCount(0);

    await expect(page).toHaveURL(/\/cvi-labs\?/);

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText.includes('CVI Labs')).toBe(false);
  });

  test('auto-loads a compatible shared segmentation created in segmentation mode', async ({ page }) => {
    const created = await createCompatibleSegmentationInSegmentationMode(page);
    await openCviStudy(page);

    await page.waitForFunction(
      expectedLabel => {
        const services = (window as any).services;
        const { segmentationService, viewportGridService } = services || {};
        const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
        const activeSegmentation = activeViewportId
          ? segmentationService?.getActiveSegmentation?.(activeViewportId)
          : null;
        return String(activeSegmentation?.label || '').includes(expectedLabel);
      },
      'Cvi Lab',
      { timeout: AUTO_LOAD_TIMEOUT_MS }
    );

    const state = await getSharedSegmentationState(page);
    expect(state.segmentationId).toBeTruthy();
    expect(state.segmentationLabel).toBe('Cvi Lab');
    expect(state.segmentLabels).toEqual(expect.arrayContaining(['LV Cavity', 'Myocardium', 'RV Cavity']));
  });

  test('Cvi contour edits remain visible when reopening segmentation mode', async ({ page }) => {
    await openCviStudy(page);

    await drawManualContour(page, 0.055, 0);
    await page.waitForTimeout(1000);
    await page.evaluate(async () => {
      const testApi = (window as any).__medexSegmentationTestApi;
      await testApi?.saveActiveSegmentation?.();
    });

    const cviState = await getSharedSegmentationState(page);
    expect(cviState.segmentationId).toBeTruthy();
    expect(Number(cviState.pixelCountsBySegment['1'] || 0)).toBeGreaterThan(0);

    await page.goto(`${SEG_MODE_PATH}?StudyInstanceUIDs=${STACK_WORKFLOW_STUDY_UID}`);
    await page.waitForLoadState('domcontentloaded');
    await waitForAutoCreatedLabelmap(page, false);
    await page.waitForFunction(
      expectedLabel => {
        const services = (window as any).services;
        const { segmentationService, viewportGridService } = services || {};
        const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
        const activeSegmentation = activeViewportId
          ? segmentationService?.getActiveSegmentation?.(activeViewportId)
          : null;
        return String(activeSegmentation?.label || '').includes(expectedLabel);
      },
      'Cvi Lab',
      { timeout: AUTO_LOAD_TIMEOUT_MS }
    );

    const count = await getCanvasActiveSegmentPixelCount(page, 0);
    expect(count.count).toBeGreaterThan(0);
  });
});
