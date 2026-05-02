import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils';

const OVI_STUDY_UID =
  '1.2.840.113619.186.2403117520819917.20201214214121708.522';

test.describe('OVI Labs shared segmentation import mapping', () => {
  test('maps an incompatible shared segmentation into a copied Ovi Lab segmentation @debug', async ({
    page,
  }) => {
    await loginAs(page);
    await page.goto(`/ovi-labs?StudyInstanceUIDs=${OVI_STUDY_UID}`);

    await page.waitForFunction(
      () => {
        try {
          const services = (window as any).services;
          const viewportId = services?.viewportGridService?.getState?.()?.activeViewportId;
          const viewportInfo = viewportId
            ? services?.cornerstoneViewportService?.getViewportInfo?.(viewportId)
            : null;
          const displaySetInstanceUID = viewportInfo?.getDisplaySetOptions?.()?.[0]?.displaySetInstanceUID;
          return Boolean(
            services?.segmentationService &&
              viewportId &&
              displaySetInstanceUID &&
              services?.displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID)
          );
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 60_000 }
    );

    const sourceSegmentationId = await page.evaluate(async () => {
      const services = (window as any).services;
      const { segmentationService, viewportGridService, displaySetService, cornerstoneViewportService } =
        services;
      const viewportId = viewportGridService.getState().activeViewportId;
      const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);
      const displaySetInstanceUID = viewportInfo.getDisplaySetOptions()[0].displaySetInstanceUID;
      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
      const segmentationId = `e2e-ovi-import-source-${Date.now()}`;

      await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        label: 'Reader A Import Source',
        segments: {
          1: { label: 'Cavity Source', active: true },
          2: { label: 'Endometrium Source' },
          3: { label: 'Myometrium Source' },
          4: { label: 'JZ Source' },
        },
      });
      await segmentationService.addSegmentationRepresentation(viewportId, {
        segmentationId,
        type: 'Labelmap',
      });
      segmentationService.setActiveSegmentation(viewportId, segmentationId);
      return segmentationId;
    });

    await expect(page.getByRole('combobox', { name: /ovi active segmentation/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('combobox', { name: /ovi active segmentation/i }).click();
    await page.getByRole('option', { name: /Reader A Import Source/i }).click();

    await expect(page.getByRole('dialog', { name: /create import label mapping/i })).toBeVisible();

    const mappings = [
      ['Uterine cavity', 'Cavity Source'],
      ['Endometrium', 'Endometrium Source'],
      ['Myometrium', 'Myometrium Source'],
      ['Junctional zone', 'JZ Source'],
    ] as const;

    for (const [target, source] of mappings) {
      await page.getByRole('combobox', { name: new RegExp(target, 'i') }).click();
      await page.getByRole('option', { name: source }).click();
    }

    await page.getByRole('button', { name: /create import copy/i }).click();
    await expect(page.getByRole('dialog', { name: /create import label mapping/i })).toBeHidden();

    const importedState = await page.evaluate(sourceSegmentationId => {
      const services = (window as any).services;
      const { segmentationService, viewportGridService } = services;
      const viewportId = viewportGridService.getState().activeViewportId;
      const active = segmentationService.getActiveSegmentation(viewportId);
      return {
        sourceSegmentationId,
        activeSegmentationId: active?.segmentationId,
        activeLabel: active?.label,
        segmentLabels: Object.values(active?.segments || {}).map((segment: any) => segment.label),
      };
    }, sourceSegmentationId);

    expect(importedState.activeSegmentationId).not.toBe(sourceSegmentationId);
    expect(importedState.activeLabel).toBe('Ovi Lab');
    expect(importedState.segmentLabels).toEqual(
      expect.arrayContaining(['Uterine cavity', 'Endometrium', 'Myometrium', 'Junctional zone'])
    );
  });
});
