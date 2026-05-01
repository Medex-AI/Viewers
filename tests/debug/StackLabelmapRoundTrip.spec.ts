import { test, expect } from 'playwright-test-coverage';
import { loginAs } from '../utils';

const VOLUME_STUDY_UID = '2.25.886183689675766305740169196162815250747';
const STACK_STUDY_UID = '1.2.840.113619.186.2403117520819917.20201214214121708.522';
const AUTO_LOAD_TIMEOUT_MS = 60_000;
const TARGET_COLOR: [number, number, number, number] = [255, 0, 255, 255];

const getVisibleCanvasOrder = async page => {
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

const getCanvasColorStats = async (page, canvasIndex: number, expectedRgb: number[]) => {
  return page
    .locator('canvas.cornerstone-canvas')
    .nth(canvasIndex)
    .evaluate((canvas, color) => {
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

const stepCanvasSlice = async (page, canvasIndex: number, preferredDelta: 1 | -1 = 1) => {
  return page.evaluate(
    async ({ canvasIndex, preferredDelta }) => {
      const cornerstone = (window as any).cornerstone;
      const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
      const viewport = enabledElement?.viewport;
      const element = enabledElement?.element || viewport?.element;
      const currentIndex = viewport?.getCurrentImageIdIndex?.();
      const totalSlices = viewport?.getNumberOfSlices?.() || viewport?.getImageIds?.()?.length || 0;

      if (!viewport || !element || typeof currentIndex !== 'number' || totalSlices < 2) {
        throw new Error(
          `Cannot step canvas ${canvasIndex}: ${JSON.stringify({
            hasViewport: Boolean(viewport),
            hasElement: Boolean(element),
            currentIndex,
            totalSlices,
          })}`
        );
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

const countSegment = (data: ArrayLike<number> | null | undefined, segmentIndex: number) => {
  if (!data) {
    return 0;
  }

  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === segmentIndex) {
      count += 1;
    }
  }
  return count;
};

const drawBrushStrokeOnCanvas = async (page, canvasIndex: number) => {
  const canvas = page.locator('canvas.cornerstone-canvas').nth(canvasIndex);
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error(`No bounding box for canvas ${canvasIndex}`);
  }

  const target = await canvas.evaluate(canvasElement => {
    const canvas = canvasElement as HTMLCanvasElement;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !canvas.width || !canvas.height) {
      return { x: 0.5, y: 0.5 };
    }

    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    let best = { x: Math.floor(width / 2), y: Math.floor(height / 2), score: -1 };
    const minX = Math.floor(width * 0.15);
    const maxX = Math.floor(width * 0.85);
    const minY = Math.floor(height * 0.15);
    const maxY = Math.floor(height * 0.85);
    const stepX = Math.max(1, Math.floor(width / 120));
    const stepY = Math.max(1, Math.floor(height / 120));

    for (let y = minY; y < maxY; y += stepY) {
      for (let x = minX; x < maxX; x += stepX) {
        const offset = (y * width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const score = red + green + blue - Math.max(0, max - min) * 3;
        if (max > 35 && score > best.score) {
          best = { x, y, score };
        }
      }
    }

    return {
      x: best.x / width,
      y: best.y / height,
    };
  });

  const startX = box.x + box.width * Math.max(0.08, target.x - 0.06);
  const startY = box.y + box.height * target.y;
  const endX = box.x + box.width * Math.min(0.92, target.x + 0.06);
  const endY = box.y + box.height * target.y;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
};

const addProbeSegment = async (page, canvasIndex: number, color: number[]) => {
  return page.evaluate(
    async ({ canvasIndex, color }) => {
      const cornerstone = (window as any).cornerstone;
      const services = (window as any).services;
      const { segmentationService, viewportGridService } = services || {};
      const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
      const viewport = enabledElement?.viewport;
      const viewportId = viewport?.id;

      if (!viewport || !viewportId || !segmentationService) {
        throw new Error(`Missing viewport or segmentation service for canvas ${canvasIndex}`);
      }

      viewportGridService?.setActiveViewportId?.(viewportId);
      const activeSegmentation = segmentationService.getActiveSegmentation?.(viewportId);
      if (!activeSegmentation?.segmentationId) {
        throw new Error(`No active segmentation for viewport ${viewportId}`);
      }

      const segmentationId = activeSegmentation.segmentationId;
      segmentationService.addSegment(segmentationId, {
        label: `VolumeLabelmapBrush-${canvasIndex}`,
        color,
        active: true,
        visibility: true,
      });
      await new Promise(resolve => setTimeout(resolve, 300));

      return {
        viewportId,
        segmentationId,
        segmentIndex: segmentationService.getActiveSegment?.(viewportId)?.segmentIndex,
        viewportType: viewport.type,
      };
    },
    { canvasIndex, color }
  );
};

const writeDirectLabelmapProbe = async (page, canvasIndex: number, color: number[]) => {
  return page.evaluate(
    async ({ canvasIndex, color }) => {
      const cornerstone = (window as any).cornerstone;
      const cornerstoneTools = (window as any).cornerstoneTools;
      const services = (window as any).services;
      const { segmentationService, viewportGridService } = services || {};
      const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
      const viewport = enabledElement?.viewport;
      const viewportId = viewport?.id;

      if (!viewport || !viewportId || !segmentationService) {
        throw new Error(`Missing viewport or segmentation service for canvas ${canvasIndex}`);
      }

      viewportGridService?.setActiveViewportId?.(viewportId);

      const activeSegmentation = segmentationService.getActiveSegmentation?.(viewportId);
      if (!activeSegmentation?.segmentationId) {
        throw new Error(`No active segmentation for viewport ${viewportId}`);
      }

      const segmentationId = activeSegmentation.segmentationId;
      const label = `StackLabelmapDirect-${canvasIndex}`;
      segmentationService.addSegment(segmentationId, {
        label,
        color,
        active: true,
        visibility: true,
      });

      const activeSegment = segmentationService.getActiveSegment?.(viewportId);
      const segmentIndex = activeSegment?.segmentIndex;
      if (!segmentIndex) {
        throw new Error(`No active segment after direct probe setup for viewport ${viewportId}`);
      }

      const currentImageId = viewport.getCurrentImageId?.();
      const currentImageIdIndex = viewport.getCurrentImageIdIndex?.();
      const labelmapImageId =
        cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdForViewport?.(
          viewportId,
          segmentationId
        );
      const labelmapVolumeId = activeSegmentation.representationData?.Labelmap?.volumeId;
      const labelmapImageIds =
        cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdsForViewport?.(
          viewportId,
          segmentationId
        ) || [];

      if (!labelmapImageId) {
        const labelmapVolume = labelmapVolumeId ? cornerstone.cache.getVolume(labelmapVolumeId) : null;
        const voxelManager = labelmapVolume?.voxelManager;
        const dimensions = labelmapVolume?.dimensions || labelmapVolume?.imageData?.getDimensions?.();
        const width = dimensions?.[0] || 0;
        const height = dimensions?.[1] || 0;
        const depth = dimensions?.[2] || 1;

        if (!voxelManager?.setAtIJK || !width || !height) {
          throw new Error(
            `No current labelmap image id for ${JSON.stringify({
              viewportId,
              segmentationId,
              currentImageId,
              labelmapImageIds,
              labelmapVolumeId,
              hasLabelmapVolume: Boolean(labelmapVolume),
              dimensions,
            })}`
          );
        }

        const z = Math.max(
          0,
          Math.min(
            depth - 1,
            typeof currentImageIdIndex === 'number' ? currentImageIdIndex : Math.floor(depth / 2)
          )
        );
        const boxSize = Math.max(12, Math.floor(Math.min(width, height) * 0.08));
        const startX = Math.floor(width / 2 - boxSize / 2);
        const startY = Math.floor(height / 2 - boxSize / 2);
        for (let y = startY; y < startY + boxSize; y++) {
          for (let x = startX; x < startX + boxSize; x++) {
            voxelManager.setAtIJK(x, y, z, segmentIndex);
          }
        }

        labelmapVolume.voxelManager?.modified?.();
        labelmapVolume.imageData?.modified?.();
        labelmapVolume.vtkOpenGLTexture?.setUpdatedFrame?.(z);
        cornerstoneTools?.segmentation?.triggerSegmentationEvents?.triggerSegmentationDataModified?.(
          segmentationId,
          [z],
          segmentIndex
        );
        cornerstoneTools?.utilities?.segmentation?.triggerSegmentationRender?.(viewportId);
        viewport.render?.();
        await new Promise(resolve => setTimeout(resolve, 700));

        return {
          viewportId,
          segmentationId,
          segmentIndex,
          currentImageId,
          currentImageIdIndex,
          labelmapImageId: null,
          labelmapImageIds,
          labelmapVolumeId,
          wrotePixels: boxSize * boxSize,
          wroteSliceIndex: z,
        };
      }

      const labelmapImage = cornerstone.cache.getImage(labelmapImageId);
      const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
      const width = labelmapImage?.columns || labelmapImage?.width || 0;
      const height = labelmapImage?.rows || labelmapImage?.height || 0;
      if (!scalarData || !width || !height) {
        throw new Error(`No scalar data for labelmap ${labelmapImageId}`);
      }

      const boxSize = Math.max(12, Math.floor(Math.min(width, height) * 0.08));
      const startX = Math.floor(width / 2 - boxSize / 2);
      const startY = Math.floor(height / 2 - boxSize / 2);
      for (let y = startY; y < startY + boxSize; y++) {
        for (let x = startX; x < startX + boxSize; x++) {
          scalarData[y * width + x] = segmentIndex;
        }
      }

      labelmapImage.voxelManager?.modified?.();
      labelmapImage.imageData?.modified?.();
      cornerstoneTools?.segmentation?.triggerSegmentationEvents?.triggerSegmentationDataModified?.(
        segmentationId,
        typeof currentImageIdIndex === 'number' ? [currentImageIdIndex] : undefined,
        segmentIndex
      );
      cornerstoneTools?.utilities?.segmentation?.triggerSegmentationRender?.(viewportId);
      viewport.render?.();
      await new Promise(resolve => setTimeout(resolve, 700));

      return {
        viewportId,
        segmentationId,
        segmentIndex,
        currentImageId,
        currentImageIdIndex,
        labelmapImageId,
        labelmapImageIds,
        labelmapVolumeId,
        wrotePixels: boxSize * boxSize,
      };
    },
    { canvasIndex, color }
  );
};

const collectStackLabelmapDiagnostics = async (
  page,
  canvasIndex: number,
  segmentationId: string,
  segmentIndex: number
) => {
  return page.evaluate(
    ({ canvasIndex, segmentationId, segmentIndex }) => {
      const cornerstone = (window as any).cornerstone;
      const cornerstoneTools = (window as any).cornerstoneTools;
      const enabledElement = (cornerstone?.getEnabledElements?.() ?? [])[canvasIndex];
      const viewport = enabledElement?.viewport;
      const viewportId = viewport?.id;
      const currentImageId = viewport?.getCurrentImageId?.();
      const currentImageIdIndex = viewport?.getCurrentImageIdIndex?.();
      const currentImage = currentImageId ? cornerstone.cache.getImage(currentImageId) : null;
      const camera = viewport?.getCamera?.();
      const currentMetadata =
        currentImage && viewport?.getImageDataMetadata
          ? viewport.getImageDataMetadata(currentImage)
          : null;
      const imagePlane = currentMetadata?.imagePlaneModule || {};
      const currentLabelmapImageId =
        viewportId && segmentationId
          ? cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdForViewport?.(
              viewportId,
              segmentationId
            )
          : null;
      const currentLabelmapImageIds =
        viewportId && segmentationId
          ? cornerstoneTools?.segmentation?.state?.getCurrentLabelmapImageIdsForViewport?.(
              viewportId,
              segmentationId
            ) || []
          : [];
      const labelmapImage = currentLabelmapImageId
        ? cornerstone.cache.getImage(currentLabelmapImageId)
        : null;
      const labelmapScalarData = labelmapImage?.voxelManager?.getScalarData?.();
      const segmentation = segmentationId
        ? cornerstoneTools?.segmentation?.state?.getSegmentation?.(segmentationId)
        : null;
      const labelmapVolumeId = segmentation?.representationData?.Labelmap?.volumeId;
      const labelmapVolume = labelmapVolumeId ? cornerstone.cache.getVolume(labelmapVolumeId) : null;
      const labelmapVolumeScalarData =
        labelmapVolume?.imageData?.getPointData?.()?.getScalars?.()?.getData?.() ||
        labelmapVolume?.scalarData;
      const actors = (viewport?.getActors?.() || []).map((entry: any) => {
        const property = entry.actor?.getProperty?.();
        const scalarOpacity = property?.getScalarOpacity?.(0);
        const rgbTransfer = property?.getRGBTransferFunction?.(0);
        const colorAtSegment = [0, 0, 0];
        try {
          rgbTransfer?.getColor?.(segmentIndex, colorAtSegment);
        } catch {
          // optional VTK API
        }
        const scalarData = entry.actor
          ?.getMapper?.()
          ?.getInputData?.()
          ?.getPointData?.()
          ?.getScalars?.()
          ?.getData?.();
        let actorSegmentCount = 0;
        if (scalarData) {
          for (let i = 0; i < scalarData.length; i++) {
            if (scalarData[i] === segmentIndex) {
              actorSegmentCount += 1;
            }
          }
        }
        const mapper = entry.actor?.getMapper?.();
        const imageData = mapper?.getInputData?.();
        const clippingPlanes = mapper?.getClippingPlanes?.() || [];

        return {
          uid: entry.uid,
          referencedId: entry.referencedId,
          representationUID: entry.representationUID,
          visible: entry.actor?.getVisibility?.(),
          actorSegmentCount,
          scalarOpacityRange: scalarOpacity?.getRange?.(),
          scalarOpacityMTime: scalarOpacity?.getMTime?.(),
          opacityAtSegment: scalarOpacity?.getValue?.(segmentIndex),
          rgbTransferRange: rgbTransfer?.getRange?.(),
          rgbTransferMTime: rgbTransfer?.getMTime?.(),
          colorAtSegment,
          bounds: entry.actor?.getBounds?.(),
          mapperMTime: mapper?.getMTime?.(),
          imageMTime: imageData?.getMTime?.(),
          dimensions: imageData?.getDimensions?.(),
          origin: imageData?.getOrigin?.(),
          spacing: imageData?.getSpacing?.(),
          direction: imageData?.getDirection?.(),
          clippingPlaneCount: clippingPlanes.length,
          clippingPlanes: clippingPlanes.map((plane: any) => ({
            normal: plane.getNormal?.(),
            origin: plane.getOrigin?.(),
          })),
        };
      });
      const renderer = viewport?.getRenderer?.();
      const rendererViewProps = renderer?.getViewProps?.() || [];
      const rendererProps = rendererViewProps.map((viewProp: any, index: number) => {
        const property = viewProp?.getProperty?.();
        const scalarOpacity = property?.getScalarOpacity?.(0);
        const rgbTransfer = property?.getRGBTransferFunction?.(0);
        const colorAtSegment = [0, 0, 0];
        try {
          rgbTransfer?.getColor?.(segmentIndex, colorAtSegment);
        } catch {
          // optional VTK API
        }
        const matchingActor = actors.find((actor: any) => {
          const actorEntry = (viewport?.getActors?.() || []).find((entry: any) => entry.uid === actor.uid);
          return actorEntry?.actor === viewProp;
        });
        const scalarData = viewProp
          ?.getMapper?.()
          ?.getInputData?.()
          ?.getPointData?.()
          ?.getScalars?.()
          ?.getData?.();
        let rendererSegmentCount = 0;
        if (scalarData) {
          for (let i = 0; i < scalarData.length; i++) {
            if (scalarData[i] === segmentIndex) {
              rendererSegmentCount += 1;
            }
          }
        }
        const mapper = viewProp?.getMapper?.();
        const imageData = mapper?.getInputData?.();
        const clippingPlanes = mapper?.getClippingPlanes?.() || [];

        return {
          index,
          actorUid: matchingActor?.uid || null,
          referencedId: matchingActor?.referencedId || null,
          visible: viewProp?.getVisibility?.(),
          rendererSegmentCount,
          scalarOpacityRange: scalarOpacity?.getRange?.(),
          scalarOpacityMTime: scalarOpacity?.getMTime?.(),
          opacityAtSegment: scalarOpacity?.getValue?.(segmentIndex),
          rgbTransferRange: rgbTransfer?.getRange?.(),
          rgbTransferMTime: rgbTransfer?.getMTime?.(),
          colorAtSegment,
          bounds: viewProp?.getBounds?.(),
          mapperMTime: mapper?.getMTime?.(),
          imageMTime: imageData?.getMTime?.(),
          dimensions: imageData?.getDimensions?.(),
          origin: imageData?.getOrigin?.(),
          spacing: imageData?.getSpacing?.(),
          direction: imageData?.getDirection?.(),
          clippingPlaneCount: clippingPlanes.length,
          clippingPlanes: clippingPlanes.map((plane: any) => ({
            normal: plane.getNormal?.(),
            origin: plane.getOrigin?.(),
          })),
        };
      });

      let cacheSegmentCount = 0;
      const cacheScalarData = labelmapScalarData || labelmapVolumeScalarData;
      if (cacheScalarData) {
        for (let i = 0; i < cacheScalarData.length; i++) {
          if (cacheScalarData[i] === segmentIndex) {
            cacheSegmentCount += 1;
          }
        }
      } else if (labelmapVolume?.voxelManager?.getAtIndex && labelmapVolume?.dimensions) {
        const voxelCount = labelmapVolume.dimensions[0] * labelmapVolume.dimensions[1] * labelmapVolume.dimensions[2];
        for (let i = 0; i < voxelCount; i++) {
          if (labelmapVolume.voxelManager.getAtIndex(i) === segmentIndex) {
            cacheSegmentCount += 1;
          }
        }
      }

      return {
        viewportId,
        viewportType: viewport?.type,
        currentImageId,
        currentImageIdIndex,
        currentLabelmapImageId,
        currentLabelmapImageIds,
        labelmapVolumeId,
        cacheSegmentCount,
        imageGeometry: {
          dimensions: currentMetadata?.dimensions,
          origin: currentMetadata?.origin,
          spacing: currentMetadata?.spacing,
          direction: currentMetadata?.direction,
          rowCosines: imagePlane.rowCosines,
          columnCosines: imagePlane.columnCosines,
          imagePositionPatient: imagePlane.imagePositionPatient,
          sliceLocation: imagePlane.sliceLocation,
          spacingBetweenSlices: imagePlane.spacingBetweenSlices,
          sliceThickness: imagePlane.sliceThickness,
        },
        camera: camera
          ? {
              focalPoint: camera.focalPoint,
              position: camera.position,
              viewPlaneNormal: camera.viewPlaneNormal,
              viewUp: camera.viewUp,
              parallelScale: camera.parallelScale,
              clippingRange: camera.clippingRange,
            }
          : null,
        actors,
        rendererProps,
      };
    },
    { canvasIndex, segmentationId, segmentIndex }
  );
};

const openStudy = async (page, studyInstanceUID: string, minCanvasCount: number) => {
  await page.goto(`/segmentation/orthanc-medex?StudyInstanceUIDs=${studyInstanceUID}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    count => document.querySelectorAll('canvas.cornerstone-canvas').length >= count,
    minCanvasCount,
    { timeout: AUTO_LOAD_TIMEOUT_MS }
  );
  await page.waitForTimeout(2000);
};

const expectDirectLabelmapRoundTrip = async (page, targetCanvas, expectedViewportType: string) => {
  await page.locator('canvas.cornerstone-canvas').nth(targetCanvas.index).click({
    position: { x: targetCanvas.width / 2, y: targetCanvas.height / 2 },
  });
  await page.waitForTimeout(300);

  const writeState = await writeDirectLabelmapProbe(page, targetCanvas.index, TARGET_COLOR);
  const afterWriteDiagnostics = await collectStackLabelmapDiagnostics(
    page,
    targetCanvas.index,
    writeState.segmentationId,
    writeState.segmentIndex
  );
  const afterWriteCanvas = await getCanvasColorStats(page, targetCanvas.index, TARGET_COLOR);

  expect(
    afterWriteDiagnostics.viewportType,
    `Expected ${expectedViewportType} viewport: ${JSON.stringify({
      targetCanvas,
      writeState,
      afterWriteDiagnostics,
    })}`
  ).toBe(expectedViewportType);
  expect(
    afterWriteDiagnostics.cacheSegmentCount,
    `Direct write should update cached labelmap: ${JSON.stringify({
      targetCanvas,
      writeState,
      afterWriteDiagnostics,
      afterWriteCanvas,
    })}`
  ).toBeGreaterThan(0);
  if (expectedViewportType === 'stack') {
    expect(
      afterWriteDiagnostics.actors.some(actor => actor.actorSegmentCount > 0),
      `Direct write should update at least one labelmap actor: ${JSON.stringify({
        targetCanvas,
        writeState,
        afterWriteDiagnostics,
        afterWriteCanvas,
      })}`
    ).toBe(true);
  }
  expect(
    afterWriteCanvas.matchedPixels,
    `Direct write should render chromatic labelmap pixels before navigation: ${JSON.stringify({
      targetCanvas,
      writeState,
      afterWriteDiagnostics,
      afterWriteCanvas,
    })}`
  ).toBeGreaterThan(0);

  const forwardStep = await stepCanvasSlice(page, targetCanvas.index, 1);
  const backStep = await stepCanvasSlice(
    page,
    targetCanvas.index,
    forwardStep.delta === 1 ? -1 : 1
  );
  const afterReturnDiagnostics = await collectStackLabelmapDiagnostics(
    page,
    targetCanvas.index,
    writeState.segmentationId,
    writeState.segmentIndex
  );
  const afterReturnCanvas = await getCanvasColorStats(page, targetCanvas.index, TARGET_COLOR);

  expect(
    backStep.toIndex,
    `Expected slice round-trip to return to original slice: ${JSON.stringify({
      targetCanvas,
      forwardStep,
      backStep,
      writeState,
      afterReturnDiagnostics,
      afterReturnCanvas,
    })}`
  ).toBe(forwardStep.fromIndex);
  expect(
    afterReturnDiagnostics.cacheSegmentCount,
    `Cached labelmap data should survive slice round-trip: ${JSON.stringify({
      targetCanvas,
      forwardStep,
      backStep,
      writeState,
      afterWriteDiagnostics,
      afterWriteCanvas,
      afterReturnDiagnostics,
      afterReturnCanvas,
    })}`
  ).toBeGreaterThan(0);
  if (expectedViewportType === 'stack') {
    expect(
      afterReturnDiagnostics.actors.some(actor => actor.actorSegmentCount > 0),
      `Actor labelmap data should survive slice round-trip: ${JSON.stringify({
        targetCanvas,
        forwardStep,
        backStep,
        writeState,
        afterWriteDiagnostics,
        afterWriteCanvas,
        afterReturnDiagnostics,
        afterReturnCanvas,
      })}`
    ).toBe(true);
  }

  return {
    targetCanvas,
    writeState,
    forwardStep,
    backStep,
    afterWriteDiagnostics,
    afterWriteCanvas,
    afterReturnDiagnostics,
    afterReturnCanvas,
  };
};

test.describe('Labelmap rendering path diagnostics', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
  });

  test('volume labelmap pixels render after slice round-trip in single-viewport study', async ({ page }) => {
    await openStudy(page, VOLUME_STUDY_UID, 1);

    const canvasOrder = await getVisibleCanvasOrder(page);
    expect(canvasOrder.length, `Expected visible canvas: ${JSON.stringify(canvasOrder)}`).toBeGreaterThanOrEqual(1);

    const targetCanvas = canvasOrder[0];
    await page.locator('canvas.cornerstone-canvas').nth(targetCanvas.index).click({
      position: { x: targetCanvas.width / 2, y: targetCanvas.height / 2 },
    });
    const probeState = await addProbeSegment(page, targetCanvas.index, TARGET_COLOR);
    expect(probeState.viewportType, `Expected orthographic volume viewport: ${JSON.stringify(probeState)}`).toBe('orthographic');

    const brushButton = page.locator('[data-cy="Brush"]').first();
    await expect(brushButton).toBeAttached({ timeout: AUTO_LOAD_TIMEOUT_MS });
    await brushButton.locator('button').click();
    await expect(brushButton).toHaveAttribute('data-active', 'true');

    const beforeWriteCanvas = await getCanvasColorStats(page, targetCanvas.index, TARGET_COLOR);
    await drawBrushStrokeOnCanvas(page, targetCanvas.index);
    const afterWriteCanvas = await getCanvasColorStats(page, targetCanvas.index, TARGET_COLOR);

    expect(
      afterWriteCanvas.matchedPixels,
      `Brush should render volume labelmap pixels before navigation: ${JSON.stringify({
        targetCanvas,
        probeState,
        beforeWriteCanvas,
        afterWriteCanvas,
      })}`
    ).toBeGreaterThan(beforeWriteCanvas.matchedPixels);

    const forwardStep = await stepCanvasSlice(page, targetCanvas.index, 1);
    const backStep = await stepCanvasSlice(
      page,
      targetCanvas.index,
      forwardStep.delta === 1 ? -1 : 1
    );
    const afterReturnCanvas = await getCanvasColorStats(page, targetCanvas.index, TARGET_COLOR);

    expect(
      backStep.toIndex,
      `Expected volume slice round-trip to return to original slice: ${JSON.stringify({
        targetCanvas,
        probeState,
        forwardStep,
        backStep,
      })}`
    ).toBe(forwardStep.fromIndex);
    expect(
      afterReturnCanvas.matchedPixels,
      `Rendered volume labelmap pixels should survive slice round-trip: ${JSON.stringify({
        targetCanvas,
        probeState,
        beforeWriteCanvas,
        afterWriteCanvas,
        forwardStep,
        backStep,
        afterReturnCanvas,
      })}`
    ).toBeGreaterThan(0);
  });

  test('stack labelmap pixels render after slice round-trip in all four stack viewports', async ({
    page,
  }) => {
    await openStudy(page, STACK_STUDY_UID, 4);

    const canvasOrder = await getVisibleCanvasOrder(page);
    expect(canvasOrder.length, `Expected four visible canvases: ${JSON.stringify(canvasOrder)}`).toBeGreaterThanOrEqual(4);

    const results = [];
    for (const targetCanvas of canvasOrder.slice(0, 4)) {
      const result = await expectDirectLabelmapRoundTrip(page, targetCanvas, 'stack');
      results.push(result);
    }

    const failedResults = results.filter(result => result.afterReturnCanvas.matchedPixels <= 0);
    expect(
      failedResults,
      `Rendered stack labelmap pixels should survive slice round-trip in all four viewports: ${JSON.stringify(
        results
      )}`
    ).toHaveLength(0);
  });
});
