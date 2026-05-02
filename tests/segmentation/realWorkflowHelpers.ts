import { expect } from 'playwright-test-coverage';

export const STACK_WORKFLOW_STUDY_UID =
  '1.2.840.113619.186.2403117520819917.20201214214121708.522';

export const AUTO_LOAD_TIMEOUT_MS = 60_000;
export const AUTOSAVE_SETTLE_MS = 4_000;

export type WorkflowState = {
  activeViewportId?: string;
  segmentationId?: string;
  segmentIndex?: number;
  label?: string;
  color?: number[];
  domCards: string[];
  hudStatus?: string | null;
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  pixelCountsBySegment: Record<string, number>;
  backendDocuments?: Array<{ id: string; label: string; labels: Record<string, unknown> }>;
};

export type IsolatedLabelmap = {
  viewportId: string;
  segmentationId: string;
  labelmapLabel: string;
  initialLabel: string;
  segmentIndex: number;
};

export const openSegmentationStudy = async (
  page: any,
  studyInstanceUID: string = STACK_WORKFLOW_STUDY_UID,
  minCanvasCount = 1,
  requireLabelCard = true
) => {
  await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${studyInstanceUID}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    count => document.querySelectorAll('canvas.cornerstone-canvas').length >= count,
    minCanvasCount,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  await waitForAutoCreatedLabelmap(page, requireLabelCard);
};

export const waitForAutoCreatedLabelmap = async (page: any, requireLabelCard = true) => {
  await page.waitForFunction(
    () => {
      try {
        const services = (window as any).services;
        const segmentationService = services?.segmentationService;
        const viewportGridService = services?.viewportGridService;
        const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
        const activeSegmentation = activeViewportId
          ? segmentationService?.getActiveSegmentation?.(activeViewportId)
          : null;

        return Boolean(
          activeSegmentation?.segmentationId || segmentationService?.getSegmentations?.()?.length
        );
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  if (requireLabelCard) {
    await expect(page.locator('[data-cy="data-row"]').first()).toBeVisible({
      timeout: AUTO_LOAD_TIMEOUT_MS,
    });
  }
};

export const expectHudSynced = async (page: any, timeout = AUTOSAVE_SETTLE_MS + 10_000) => {
  await expect(page.locator('[data-cy="persistence-hud"]')).toHaveAttribute(
    'data-hud-status',
    'synced',
    { timeout }
  );
};

export const getWorkflowState = async (page: any): Promise<WorkflowState> => {
  const state = await page.evaluate(async () => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
    const activeSegmentation = activeViewportId
      ? segmentationService?.getActiveSegmentation?.(activeViewportId)
      : null;
    const segmentationId = activeSegmentation?.segmentationId;
    const segment = activeViewportId
      ? segmentationService?.getActiveSegment?.(activeViewportId)
      : null;
    const segmentIndex = segment?.segmentIndex || 1;
    const segmentation = segmentationId
      ? segmentationService?.getSegmentation?.(segmentationId)
      : null;
    const color = segmentationId
      ? segmentationService?.getSegmentColor?.(activeViewportId, segmentationId, segmentIndex)
      : undefined;
    const labelmapData = segmentation?.representationData?.Labelmap;
    const referencedImageId = labelmapData?.referencedImageIds?.[0];
    const instance = referencedImageId
      ? (window as any).DicomMetadataStore?.getInstanceByImageId?.(referencedImageId) ||
        (window as any).cornerstone?.metaData?.get?.('instance', referencedImageId)
      : null;
    const pixelCountsBySegment: Record<string, number> = {};

    const countData = (data?: ArrayLike<number> | null) => {
      if (!data) return;
      for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (value > 0) {
          pixelCountsBySegment[String(value)] = (pixelCountsBySegment[String(value)] || 0) + 1;
        }
      }
    };

    for (const imageId of labelmapData?.imageIds || []) {
      try {
        const image = (window as any).cornerstone?.cache?.getImage?.(imageId);
        countData(image?.voxelManager?.getScalarData?.());
      } catch {
        // best-effort diagnostics
      }
    }

    try {
      const volumeId = labelmapData?.volumeId;
      const volume = volumeId ? (window as any).cornerstone?.cache?.getVolume?.(volumeId) : null;
      countData(volume?.voxelManager?.getScalarData?.());
    } catch {
      // best-effort diagnostics
    }

    return {
      activeViewportId,
      segmentationId,
      segmentIndex,
      label: segmentation?.segments?.[segmentIndex]?.label,
      color,
      domCards: Array.from(document.querySelectorAll('[data-cy="data-row"]')).map(
        element => element.textContent || ''
      ),
      hudStatus: document
        .querySelector('[data-cy="persistence-hud"]')
        ?.getAttribute('data-hud-status'),
      studyInstanceUID: instance?.StudyInstanceUID,
      seriesInstanceUID: instance?.SeriesInstanceUID,
      pixelCountsBySegment,
    };
  });

  if (state.studyInstanceUID && state.seriesInstanceUID) {
    state.backendDocuments = await page.evaluate(async ({ studyInstanceUID, seriesInstanceUID }) => {
      const token = localStorage.getItem('auth_token');
      const response = await fetch(
        `/api/segmentations?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include',
        }
      ).catch(() => null);
      const contentType = response?.headers?.get?.('content-type') || '';
      if (!response?.ok || !contentType.includes('application/json')) {
        return [];
      }
      const body = await response.json();
      return (body?.data?.segmentations || []).map(item => ({
        id: item.id,
        label: item.label,
        labels: item.labels || {},
      }));
    }, state);
  }

  return state;
};

export const resetActiveBackendSegmentationResources = async (page: any) => {
  const state = await getWorkflowState(page);
  if (!state.studyInstanceUID || !state.seriesInstanceUID) {
    return state;
  }

  await page.evaluate(async ({ studyInstanceUID, seriesInstanceUID }) => {
    const token = localStorage.getItem('auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const listResponse = await fetch(
      `/api/segmentations?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
      { headers, credentials: 'include' }
    ).catch(() => null);
    const contentType = listResponse?.headers?.get?.('content-type') || '';
    const body = listResponse?.ok && contentType.includes('application/json')
      ? await listResponse.json()
      : null;
    const documents = body?.data?.segmentations || [];
    await Promise.all(
      documents.map(document =>
        fetch(`/api/segmentations/${document.id}`, {
          method: 'DELETE',
          headers,
          credentials: 'include',
        }).catch(() => null)
      )
    );
    await fetch(
      `/api/segmentation-frames?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
      {
        method: 'DELETE',
        headers,
        credentials: 'include',
      }
    ).catch(() => null);
  }, state);

  return state;
};

export const renameActiveLabelViaUi = async (page: any, name: string) => {
  const dataRow = page.locator('[data-cy="data-row"]').first();
  await dataRow.hover();
  await dataRow.locator('button[aria-label="Actions"]').click();
  await page.getByRole('menuitem', { name: /^Rename$/i }).click();
  await page.getByPlaceholder(/enter new label/i).fill(name);
  await page.getByRole('button', { name: /save|ok|rename/i }).click();
};

export const deleteActiveLabelViaUi = async (page: any) => {
  const dataRow = page.locator('[data-cy="data-row"]').first();
  await dataRow.hover();
  await dataRow.locator('button[aria-label="Actions"]').click();
  await page.getByRole('menuitem', { name: /^Delete$/i }).click();
  await page.getByRole('button', { name: /^Delete$/i }).click();
};

export const activateBrushTool = async (page: any) => {
  const brushButton = page.locator('[data-cy="Brush"]').first();
  await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });
  await brushButton.locator('button').click();
  await expect(brushButton).toHaveAttribute('data-active', 'true', { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const services = (window as any).services;
      const activeViewportId = services?.viewportGridService?.getState?.()?.activeViewportId;
      const toolGroup =
        activeViewportId && services?.toolGroupService?.getToolGroupForViewport?.(activeViewportId);
      return toolGroup?.getActivePrimaryMouseButtonTool?.() === 'CircularBrush';
    },
    undefined,
    { timeout: 5000 }
  );
};

export const drawBrushStroke = async (page: any) => {
  await drawBrushStrokeOnCanvas(page, 0);
};

export const getVisibleCanvasOrder = async (page: any) => {
  return page.locator('canvas.cornerstone-canvas').evaluateAll(canvases =>
    canvases
      .map((canvas, index) => {
        const rect = canvas.getBoundingClientRect();
        const style = window.getComputedStyle(canvas);
        return {
          index,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden',
        };
      })
      .filter(item => item.visible)
      .sort((a, b) => a.top - b.top || a.left - b.left)
  );
};

export const activateCanvas = async (page: any, canvasIndex: number) => {
  const target = page.locator('canvas.cornerstone-canvas').nth(canvasIndex);
  const box = await target.boundingBox();
  if (!box) {
    throw new Error(`Canvas ${canvasIndex} bounding box not found`);
  }
  await target.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.evaluate(index => {
    const cornerstone = (window as any).cornerstone;
    const services = (window as any).services;
    const viewportId = cornerstone?.getEnabledElements?.()?.[index]?.viewport?.id;
    if (viewportId) {
      services?.viewportGridService?.setActiveViewportId?.(viewportId);
    }
  }, canvasIndex);
};

export const addActiveLabelViaService = async (page: any, label: string, color: number[]) => {
  return page.evaluate(
    ({ label, color }) => {
      const services = (window as any).services;
      const { segmentationService, viewportGridService } = services || {};
      const viewportId = viewportGridService?.getState?.()?.activeViewportId;
      const activeSegmentation = segmentationService?.getActiveSegmentation?.(viewportId);
      if (!viewportId || !activeSegmentation?.segmentationId) {
        throw new Error('No active segmentation available for new label');
      }
      segmentationService.addSegment(activeSegmentation.segmentationId, {
        label,
        color,
        active: true,
        visibility: true,
      });
      return {
        viewportId,
        segmentationId: activeSegmentation.segmentationId,
        segmentIndex: segmentationService.getActiveSegment?.(viewportId)?.segmentIndex,
      };
    },
    { label, color }
  );
};

export const createIsolatedLabelmapForActiveViewport = async (
  page: any,
  labelmapLabel = `Workflow Test Labelmap ${Date.now()}`
): Promise<IsolatedLabelmap> => {
  return page.evaluate(async labelmapLabel => {
    const services = (window as any).services;
    const commandsManager = (window as any).commandsManager;
    const { segmentationService, viewportGridService } = services || {};
    const viewportId = viewportGridService?.getState?.()?.activeViewportId;
    if (!viewportId || !commandsManager?.runCommand) {
      throw new Error('Cannot create isolated labelmap without active viewport and commandsManager');
    }

    const segmentationId = await commandsManager.runCommand('createLabelmapForViewport', {
      viewportId,
      options: {
        label: labelmapLabel,
        createInitialSegment: true,
      },
    });
    segmentationService?.setActiveSegmentation?.(viewportId, segmentationId);

    const activeSegment = segmentationService?.getActiveSegment?.(viewportId);
    if (!segmentationId || !activeSegment?.segmentIndex) {
      throw new Error('Created isolated labelmap without an active initial label');
    }

    return {
      viewportId,
      segmentationId,
      labelmapLabel,
      initialLabel: 'Label 1',
      segmentIndex: activeSegment.segmentIndex,
    };
  }, labelmapLabel);
};

export const deleteSegmentationViaService = async (page: any, segmentationId: string) => {
  return page.evaluate(segmentationId => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const viewports = viewportGridService?.getState?.()?.viewports;
    const viewportIds = Array.from(viewports?.keys?.() ?? []);

    for (const viewportId of viewportIds) {
      try {
        segmentationService?.removeSegmentationRepresentations?.(viewportId, { segmentationId });
      } catch {
        // Best-effort teardown must continue across partially disposed viewports.
      }
    }

    if (segmentationService?.getSegmentation?.(segmentationId)) {
      segmentationService.remove(segmentationId);
      return true;
    }
    return false;
  }, segmentationId);
};

export const cleanupWorkflowTestSegmentations = async (page: any) => {
  const state = await getWorkflowState(page);
  await page.evaluate(() => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const viewports = viewportGridService?.getState?.()?.viewports;
    const viewportIds = Array.from(viewports?.keys?.() ?? []);
    const segmentations = segmentationService?.getSegmentations?.() || [];

    for (const segmentation of segmentations) {
      const label = segmentation?.label || '';
      if (!label.startsWith('Workflow Test Labelmap')) {
        continue;
      }
      for (const viewportId of viewportIds) {
        try {
          segmentationService?.removeSegmentationRepresentations?.(viewportId, {
            segmentationId: segmentation.segmentationId,
          });
        } catch {
          // continue cleanup
        }
      }
      try {
        segmentationService?.remove?.(segmentation.segmentationId);
      } catch {
        // continue cleanup
      }
    }
  });

  if (!state.studyInstanceUID || !state.seriesInstanceUID) {
    return;
  }

  await page.evaluate(async ({ studyInstanceUID, seriesInstanceUID }) => {
    const token = localStorage.getItem('auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const listResponse = await fetch(
      `/api/segmentations?study=${encodeURIComponent(studyInstanceUID)}&series=${encodeURIComponent(seriesInstanceUID)}&model=segmentation`,
      { headers, credentials: 'include' }
    ).catch(() => null);
    const contentType = listResponse?.headers?.get?.('content-type') || '';
    const body = listResponse?.ok && contentType.includes('application/json')
      ? await listResponse.json()
      : null;
    const documents = body?.data?.segmentations || [];
    await Promise.all(
      documents
        .filter(document => String(document?.label || '').startsWith('Workflow Test Labelmap'))
        .map(document =>
          fetch(`/api/segmentations/${document.id}`, {
            method: 'DELETE',
            headers,
            credentials: 'include',
          }).catch(() => null)
        )
    );
  }, state);
};

export const expectNoSegmentationRemains = async (
  page: any,
  target: { segmentationId: string; label?: string; labelmapLabel?: string }
) => {
  await page.waitForTimeout(750);
  const state = await getWorkflowState(page);
  const labels = [target.label, target.labelmapLabel].filter(Boolean) as string[];

  expect(
    state.domCards.some(card => labels.some(label => card.includes(label))),
    `Expected deleted labelmap labels to leave the panel: ${JSON.stringify({ target, state })}`
  ).toBe(false);
  expect(
    Boolean(state.backendDocuments?.some(document => {
      if (document.id === target.segmentationId || document.label === target.labelmapLabel) {
        return true;
      }
      return Object.values(document.labels || {}).some((label: any) =>
        labels.some(expected => label?.name === expected)
      );
    })),
    `Expected deleted labelmap metadata to leave backend: ${JSON.stringify({ target, state })}`
  ).toBe(false);
};

export const removeActiveLabelViaService = async (page: any, canvasIndex?: number) => {
  return page.evaluate(index => {
    const cornerstone = (window as any).cornerstone;
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const viewportId =
      typeof index === 'number'
        ? cornerstone?.getEnabledElements?.()?.[index]?.viewport?.id
        : viewportGridService?.getState?.()?.activeViewportId;
    if (viewportId) {
      viewportGridService?.setActiveViewportId?.(viewportId);
    }
    const activeSegmentation = segmentationService?.getActiveSegmentation?.(viewportId);
    const activeSegment = segmentationService?.getActiveSegment?.(viewportId);
    if (!activeSegmentation?.segmentationId || !activeSegment?.segmentIndex) {
      return false;
    }
    segmentationService.removeSegment(activeSegmentation.segmentationId, activeSegment.segmentIndex);
    return true;
  }, canvasIndex);
};

export const drawBrushStrokeOnCanvas = async (page: any, canvasIndex: number) => {
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
  await page.waitForTimeout(300);
};

export const stepCanvasSlice = async (page: any, canvasIndex: number, preferredDelta: 1 | -1 = 1) => {
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

export const getCanvasColorStats = async (page: any, canvasIndex: number, expectedRgb: number[]) => {
  return page.locator('canvas.cornerstone-canvas').nth(canvasIndex).evaluate((canvas, color) => {
    if (!(canvas instanceof HTMLCanvasElement)) {
      return { width: 0, height: 0, matchedPixels: 0, chromaticPixels: 0 };
    }

    const sourceWidth = canvas.width;
    const sourceHeight = canvas.height;
    const sampleWidth = Math.min(sourceWidth, 360);
    const sampleHeight = Math.min(sourceHeight, 360);
    const target = document.createElement('canvas');
    target.width = sampleWidth;
    target.height = sampleHeight;
    const context = target.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { width: sourceWidth, height: sourceHeight, matchedPixels: 0, chromaticPixels: 0 };
    }

    context.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, sampleWidth, sampleHeight);
    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
    const colorGray = (color[0] + color[1] + color[2]) / 3;
    const colorVector = [color[0] - colorGray, color[1] - colorGray, color[2] - colorGray];
    const colorMagnitude = Math.hypot(colorVector[0], colorVector[1], colorVector[2]);
    let matchedPixels = 0;
    let chromaticPixels = 0;

    for (let i = 0; i < data.length; i += 4) {
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      if (max <= 70 || max - min <= 24) {
        continue;
      }
      chromaticPixels += 1;
      const gray = (red + green + blue) / 3;
      const pixelVector = [red - gray, green - gray, blue - gray];
      const pixelMagnitude = Math.hypot(pixelVector[0], pixelVector[1], pixelVector[2]);
      if (pixelMagnitude <= 18 || colorMagnitude <= 0) {
        continue;
      }
      const similarity =
        (pixelVector[0] * colorVector[0] +
          pixelVector[1] * colorVector[1] +
          pixelVector[2] * colorVector[2]) /
        (pixelMagnitude * colorMagnitude);
      if (similarity > 0.82) {
        matchedPixels += 1;
      }
    }

    return { width: sourceWidth, height: sourceHeight, matchedPixels, chromaticPixels };
  }, expectedRgb);
};

export const getCanvasActiveSegmentPixelCount = async (page: any, canvasIndex: number) => {
  return page.evaluate(index => {
    const cornerstone = (window as any).cornerstone;
    const cornerstoneTools = (window as any).cornerstoneTools;
    const services = (window as any).services;
    const { segmentationService } = services || {};
    const enabledElement = cornerstone?.getEnabledElements?.()?.[index];
    const viewport = enabledElement?.viewport;
    const viewportId = viewport?.id;
    const activeSegmentation = segmentationService?.getActiveSegmentation?.(viewportId);
    const activeSegment = segmentationService?.getActiveSegment?.(viewportId);
    const segmentationId = activeSegmentation?.segmentationId;
    const segmentIndex = activeSegment?.segmentIndex || 1;
    if (!viewportId || !segmentationId) {
      return { viewportId, segmentationId, segmentIndex, count: 0, source: 'none' };
    }

    const countData = (data?: ArrayLike<number> | null) => {
      let count = 0;
      if (!data) {
        return count;
      }
      for (let i = 0; i < data.length; i++) {
        if (data[i] === segmentIndex) {
          count += 1;
        }
      }
      return count;
    };

    const labelmapImageId =
      cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdForViewport?.(
        viewportId,
        segmentationId
      );
    const image = labelmapImageId ? cornerstone?.cache?.getImage?.(labelmapImageId) : null;
    const imageCount = countData(image?.voxelManager?.getScalarData?.());
    if (labelmapImageId) {
      return {
        viewportId,
        segmentationId,
        segmentIndex,
        labelmapImageId,
        currentImageIdIndex: viewport.getCurrentImageIdIndex?.(),
        count: imageCount,
        source: 'image',
      };
    }

    const volumeId = activeSegmentation?.representationData?.Labelmap?.volumeId;
    const volume = volumeId ? cornerstone?.cache?.getVolume?.(volumeId) : null;
    return {
      viewportId,
      segmentationId,
      segmentIndex,
      volumeId,
      currentImageIdIndex: viewport.getCurrentImageIdIndex?.(),
      count: countData(volume?.voxelManager?.getScalarData?.()),
      source: volumeId ? 'volume' : 'none',
    };
  }, canvasIndex);
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
        throw new Error('ManualContour test API was not available');
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

      (window as any).__medexManualContourMode = 'draw';
      const result = await testApi.completeManualContour({
        viewportId: viewport.id,
        referencedImageId,
        worldPolyline,
        mode: 'draw',
      });

      await new Promise(resolve => setTimeout(resolve, 500));
      return { referencedImageId, canvasPoints, result };
    },
    { sizeFraction, canvasIndex }
  );
};

export const setActiveLabelColorViaCommand = async (page: any, color: number[]) => {
  await page.evaluate(newColor => {
    const services = (window as any).services;
    const { segmentationService, viewportGridService } = services || {};
    const viewportId = viewportGridService?.getState?.()?.activeViewportId;
    const activeSegmentation = segmentationService?.getActiveSegmentation?.(viewportId);
    const activeSegment = segmentationService?.getActiveSegment?.(viewportId);
    if (!viewportId || !activeSegmentation?.segmentationId || !activeSegment?.segmentIndex) {
      throw new Error('No active label to color');
    }

    const originalShow = services.uiDialogService.show.bind(services.uiDialogService);
    services.uiDialogService.show = options => {
      services.uiDialogService.show = originalShow;
      options.contentProps.onSave({
        r: newColor[0],
        g: newColor[1],
        b: newColor[2],
        a: newColor[3] / 255,
      });
    };

    (window as any).commandsManager.runCommand('editSegmentColor', {
      segmentationId: activeSegmentation.segmentationId,
      segmentIndex: activeSegment.segmentIndex,
    });
  }, color);
};

export const reloadSegmentationWorkflow = async (
  page: any,
  studyInstanceUID: string = STACK_WORKFLOW_STUDY_UID,
  minCanvasCount = 1,
  requireLabelCard = true
) => {
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await openSegmentationStudy(page, studyInstanceUID, minCanvasCount, requireLabelCard);
};
