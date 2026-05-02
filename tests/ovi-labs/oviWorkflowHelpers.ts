import { expect } from 'playwright-test-coverage';

export const OVI_STUDY_UID = '1.2.840.113619.186.2403117520819917.20201214214121708.522';
export const OVI_SAGITTAL_INSTANCE_UID = '1.3.12.2.1107.5.2.43.166183.2020121421485830282635282';
export const OVI_AXIAL_INSTANCE_UID = '1.3.12.2.1107.5.2.43.166183.2020121421520769327335590';
export const OVI_AXIAL_SERIES_UID = '1.3.12.2.1107.5.2.43.166183.2020121421520771678335591.0.0.0';
export const AUTO_LOAD_TIMEOUT_MS = 60_000;
export const AUTOSAVE_SETTLE_MS = 4_000;

export const openOviStudy = async (page: any) => {
  await page.goto(
    `/ovi-labs?StudyInstanceUIDs=${OVI_STUDY_UID}&SeriesInstanceUID=${OVI_AXIAL_SERIES_UID}`
  );
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => document.querySelectorAll('canvas.cornerstone-canvas').length > 0,
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () => {
      const services = (window as any).services;
      const { viewportGridService, cornerstoneViewportService, segmentationService } = services || {};
      const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
      const viewport = activeViewportId
        ? cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId)
        : null;
      return Boolean(
        activeViewportId &&
          (viewport?.getImageIds?.()?.length || viewport?.getCurrentImageId?.()) &&
          services
      );
    },
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
};

export const getOviState = async (page: any) => {
  return page.evaluate(async ({ fallbackStudyInstanceUID, fallbackSeriesInstanceUID }) => {
    const asArray = (value: any, keys: string[]) => {
      if (Array.isArray(value)) {
        return value;
      }

      let current = value;
      for (const key of keys) {
        current = current?.[key];
        if (Array.isArray(current)) {
          return current;
        }
      }

      return [];
    };

    const services = (window as any).services;
    const { segmentationService, viewportGridService, cornerstoneViewportService } = services || {};
    const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
    const activeSegmentation = activeViewportId
      ? segmentationService?.getActiveSegmentation?.(activeViewportId)
      : null;
    const activeSegment = activeViewportId ? segmentationService?.getActiveSegment?.(activeViewportId) : null;
    const viewport = activeViewportId
      ? cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId)
      : null;
    const currentImageId = viewport?.getCurrentImageId?.();
    const currentImageIdIndex = viewport?.getCurrentImageIdIndex?.();
    const instance = currentImageId
      ? (window as any).DicomMetadataStore?.getInstanceByImageId?.(currentImageId)
      : null;
    const labelmapData = activeSegmentation?.representationData?.Labelmap;
    const pixelCountsBySegment: Record<string, number> = {};
    const currentFramePixelCountsBySegment: Record<string, number> = {};

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

    const referencedImageIds = labelmapData?.referencedImageIds || [];
    const frameIndex =
      typeof currentImageIdIndex === 'number'
        ? currentImageIdIndex
        : currentImageId
          ? referencedImageIds.indexOf(currentImageId)
          : 0;
    const currentLabelmapImageId = frameIndex >= 0 ? labelmapData?.imageIds?.[frameIndex] : undefined;
    const currentLabelmapImage = currentLabelmapImageId
      ? (window as any).cornerstone?.cache?.getImage?.(currentLabelmapImageId)
      : null;
    const currentScalarData = currentLabelmapImage?.voxelManager?.getScalarData?.();

    if (currentScalarData) {
      for (let i = 0; i < currentScalarData.length; i += 1) {
        const value = currentScalarData[i];
        if (value > 0) {
          currentFramePixelCountsBySegment[String(value)] =
            (currentFramePixelCountsBySegment[String(value)] || 0) + 1;
        }
      }
    }

    const annotationState = (window as any).cornerstoneTools?.annotation?.state || (window as any).annotation?.state;
    const annotationManager = annotationState?.getAnnotationManager?.();
    const frameOfReferenceUID = viewport?.getFrameOfReferenceUID?.();
    const currentFrameContours =
      annotationManager && frameOfReferenceUID && currentImageId
        ? ((annotationManager.getAnnotations(frameOfReferenceUID, 'ManualContour') || []) as any[]).filter(
            contour => contour?.metadata?.referencedImageId === currentImageId
          )
        : [];
    const visibleManualContoursOnCurrentFrame = currentFrameContours.filter(
      contour => contour?.isVisible !== false
    ).length;
    const derivedManualContoursOnCurrentFrame = currentFrameContours.filter(
      contour => contour?.data?.derivedFromSegmentation === true
    ).length;
    const currentFrameManualContourSummaries = currentFrameContours.map(contour => ({
      annotationUID: contour?.annotationUID,
      isVisible: contour?.isVisible,
      derivedFromSegmentation: contour?.data?.derivedFromSegmentation === true,
      labelId: contour?.data?.labelId,
      modelType: contour?.data?.modelType,
    }));

    const token = localStorage.getItem('auth_token');
    let backendFrames: any[] = [];
    let backendDocs: any[] = [];
    const studyInstanceUID = instance?.StudyInstanceUID || fallbackStudyInstanceUID;
    const seriesInstanceUID = instance?.SeriesInstanceUID || fallbackSeriesInstanceUID;

    if (studyInstanceUID && seriesInstanceUID) {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [docsResponse, segmentationFramesResponse, manualFramesResponse] = await Promise.all([
        fetch(
          `/api/segmentations?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
          { headers, credentials: 'include' }
        ).catch(() => null),
        fetch(
          `/api/segmentation-frames?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
          { headers, credentials: 'include' }
        ).catch(() => null),
        fetch(
          `/api/segmentation-frames?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=manual`,
          { headers, credentials: 'include' }
        ).catch(() => null),
      ]);

      const docsJson = docsResponse?.ok ? await docsResponse.json().catch(() => null) : null;
      const segmentationFramesJson = segmentationFramesResponse?.ok
        ? await segmentationFramesResponse.json().catch(() => null)
        : null;
      const manualFramesJson = manualFramesResponse?.ok
        ? await manualFramesResponse.json().catch(() => null)
        : null;
      backendDocs = asArray(docsJson, ['data', 'segmentations']);
      backendFrames = [
        ...asArray(segmentationFramesJson, ['data', 'frames']),
        ...asArray(manualFramesJson, ['data', 'frames']),
      ];
    }

    return {
      activeViewportId,
      segmentationId: activeSegmentation?.segmentationId,
      segmentationLabel: activeSegmentation?.label,
      activeSegmentIndex: activeSegment?.segmentIndex,
      activeSegmentLabel: activeSegment?.label,
      activeManualContourLabelId: (window as any).__oviActiveManualContourLabelId,
      activeManualContourColor: (window as any).__oviActiveManualContourColor,
      currentImageId,
      currentImageIdIndex,
      currentInstanceUID: instance?.SOPInstanceUID,
      studyInstanceUID,
      seriesInstanceUID,
      pixelCountsBySegment,
      currentFramePixelCountsBySegment,
      visibleManualContoursOnCurrentFrame,
      derivedManualContoursOnCurrentFrame,
      currentFrameManualContourSummaries,
      backendDocs,
      backendFrames,
      domCards: Array.from(document.querySelectorAll('[data-cy="data-row"]')).map(
        element => element.textContent || ''
      ),
    };
  }, { fallbackStudyInstanceUID: OVI_STUDY_UID, fallbackSeriesInstanceUID: OVI_AXIAL_SERIES_UID });
};

export const cleanupOviBackend = async (page: any) => {
  const state = await getOviState(page);
   const studyInstanceUID = state.studyInstanceUID || OVI_STUDY_UID;
   const seriesInstanceUID = state.seriesInstanceUID || OVI_AXIAL_SERIES_UID;
   if (!studyInstanceUID || !seriesInstanceUID) {
    return state;
  }

  await page.evaluate(async ({ studyInstanceUID, seriesInstanceUID }) => {
    const asArray = (value: any, keys: string[]) => {
      if (Array.isArray(value)) {
        return value;
      }

      let current = value;
      for (const key of keys) {
        current = current?.[key];
        if (Array.isArray(current)) {
          return current;
        }
      }

      return [];
    };

    const token = localStorage.getItem('auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const docsResponse = await fetch(
      `/api/segmentations?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
      { headers, credentials: 'include' }
    ).catch(() => null);
    const docsJson = docsResponse?.ok ? await docsResponse.json().catch(() => null) : null;
    const docs = asArray(docsJson, ['data', 'segmentations']);

    await Promise.all(
      docs
        .filter((document: any) => String(document?.label || '').includes('Ovi Lab'))
        .map((document: any) =>
          fetch(`/api/segmentations/${document.id}`, {
            method: 'DELETE',
            headers,
            credentials: 'include',
          }).catch(() => null)
        )
    );

    await Promise.all([
      fetch(
        `/api/segmentation-frames?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
        {
          method: 'DELETE',
          headers,
          credentials: 'include',
        }
      ).catch(() => null),
      fetch(
        `/api/segmentation-frames?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=manual`,
        {
          method: 'DELETE',
          headers,
          credentials: 'include',
        }
      ).catch(() => null),
    ]);
  }, { studyInstanceUID, seriesInstanceUID });

  return state;
};

export const cleanupOviSegmentations = async (page: any) => {
  await page.evaluate(() => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const viewports = viewportGridService?.getState?.()?.viewports;
    const viewportIds = Array.from(viewports?.keys?.() ?? []);
    const segmentations = segmentationService?.getSegmentations?.() || [];

    for (const segmentation of segmentations) {
      if (!String(segmentation?.label || '').includes('Ovi Lab')) {
        continue;
      }
      for (const viewportId of viewportIds) {
        try {
          segmentationService?.removeSegmentationRepresentations?.(viewportId, {
            segmentationId: segmentation.segmentationId,
          });
        } catch {
          // keep cleanup best-effort
        }
      }
      try {
        segmentationService?.remove?.(segmentation.segmentationId);
      } catch {
        // keep cleanup best-effort
      }
    }
  });
};

export const activateOviBrushTool = async (page: any) => {
  const brushButton = page.locator('[data-cy="Brush"]').first();
  await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });
  await brushButton.locator('button').click();
  await expect(brushButton).toHaveAttribute('data-active', 'true', { timeout: 5000 });
};

export const activateOviManualContourTool = async (page: any) => {
  const button = page.locator('[data-cy="ManualContour"]').first();
  await expect(button).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });
  await button.locator('button').click();
  await expect(button).toHaveAttribute('data-active', 'true', { timeout: 5000 });
};

export const drawBrushStrokeOnCanvas = async (page: any, canvasIndex = 0) => {
  const canvas = page.locator('canvas.cornerstone-canvas').nth(canvasIndex);
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error(`Canvas ${canvasIndex} bounding box not found`);
  }
  const midX = box.x + box.width * 0.5;
  const midY = box.y + box.height * 0.5;
  await page.mouse.move(midX - 20, midY);
  await page.mouse.down();
  await page.mouse.move(midX + 20, midY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
};

export const drawManualContour = async (page: any, sizeFraction = 0.055, canvasIndex = 0) => {
  return page.evaluate(
    async ({ sizeFraction, canvasIndex }) => {
      const cornerstone = (window as any).cornerstone;
      const enabledElement = cornerstone?.getEnabledElements?.()[canvasIndex];
      const viewport = enabledElement?.viewport;
      const element = enabledElement?.element || viewport?.element;
      const testApi = (window as any).__medexSegmentationTestApi;

      if (!viewport || !element || !testApi?.completeManualContour) {
        throw new Error('OVI ManualContour test API was not available');
      }

      const canvas = element.querySelector('canvas.cornerstone-canvas') as HTMLCanvasElement | null;
      if (!canvas) {
        throw new Error('Cornerstone canvas was not available');
      }

      const width = canvas.clientWidth || canvas.width;
      const height = canvas.clientHeight || canvas.height;
      const cx = width * 0.52;
      const cy = height * 0.48;
      const rx = width * sizeFraction;
      const ry = height * sizeFraction;
      const canvasPoints = [
        [cx - rx, cy - ry],
        [cx + rx, cy - ry],
        [cx + rx, cy + ry],
        [cx - rx, cy + ry],
        [cx - rx, cy - ry],
      ];
      const worldPolyline = canvasPoints.map(point => viewport.canvasToWorld(point));
      const imageIds = viewport.getImageIds?.() ?? [];
      const imageIndex = viewport.getCurrentImageIdIndex?.() ?? 0;
      const referencedImageId = imageIds[imageIndex] || imageIds[0];

      return testApi.completeManualContour({
        viewportId: viewport.id,
        referencedImageId,
        worldPolyline,
        mode: 'draw',
      });
    },
    { sizeFraction, canvasIndex }
  );
};

export const stepOviCanvasSlice = async (page: any, canvasIndex: number, preferredDelta: 1 | -1 = 1) => {
  return page.evaluate(
    async ({ canvasIndex, preferredDelta }) => {
      const cornerstone = (window as any).cornerstone;
      const enabledElement = cornerstone?.getEnabledElements?.()?.[canvasIndex];
      const viewport = enabledElement?.viewport;
      const element = enabledElement?.element || viewport?.element;
      const currentIndex = viewport?.getCurrentImageIdIndex?.();
      const totalSlices = viewport?.getNumberOfSlices?.() || viewport?.getImageIds?.()?.length || 0;

      if (!viewport || !element || typeof currentIndex !== 'number' || totalSlices < 2) {
        throw new Error(`Cannot step canvas ${canvasIndex}`);
      }

      const delta =
        preferredDelta > 0 && currentIndex < totalSlices - 1
          ? 1
          : preferredDelta < 0 && currentIndex > 0
            ? -1
            : currentIndex > 0
              ? -1
              : 1;
      const nextIndex = currentIndex + delta;
      cornerstone.utilities.jumpToSlice(element, { imageIndex: nextIndex, debounceLoading: false });
      viewport.render?.();
      await new Promise(resolve => setTimeout(resolve, 700));

      return {
        viewportId: viewport.id,
        fromIndex: currentIndex,
        toIndex: viewport.getCurrentImageIdIndex?.(),
        requestedIndex: nextIndex,
        delta,
        totalSlices,
      };
    },
    { canvasIndex, preferredDelta }
  );
};

export const expectOviBackendFrames = async (page: any) => {
  await page.waitForFunction(
    async ({ studyInstanceUID, seriesInstanceUID }) => {
      const asArray = (value: any, keys: string[]) => {
        if (Array.isArray(value)) {
          return value;
        }

        let current = value;
        for (const key of keys) {
          current = current?.[key];
          if (Array.isArray(current)) {
            return current;
          }
        }

        return [];
      };

      const token = localStorage.getItem('auth_token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const response = await fetch(
        `/api/segmentation-frames?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
        { headers, credentials: 'include' }
      ).catch(() => null);
      const json = response?.ok ? await response.json().catch(() => null) : null;
      return asArray(json, ['data', 'frames']).length > 0;
    },
    { studyInstanceUID: OVI_STUDY_UID, seriesInstanceUID: OVI_AXIAL_SERIES_UID },
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
};
