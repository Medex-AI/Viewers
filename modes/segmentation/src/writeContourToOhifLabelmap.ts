import { cache, imageLoader, utilities as csUtils } from '@cornerstonejs/core';
import { segmentation, Enums as toolEnums } from '@cornerstonejs/tools';
import {
  rasterizePolygonToMask,
  isPointInPolygon,
} from '../../../extensions/ovi-labs/src/utils/rasterizeContour';

/**
 * Rasterizes a closed ManualContour annotation into the active OHIF segmentation
 * labelmap (supports both volume-based and stack-based representations).
 *
 * This mirrors the OVI Labs `writeContourToActiveSegmentation` flow but uses
 * the standard OHIF segmentationService active segmentation instead of the
 * OVI-specific segmentation setup.
 */
export const writeContourToOhifLabelmap = async ({
  servicesManager,
  viewportId,
  referencedImageId,
  worldPolyline,
}: {
  servicesManager: any;
  viewportId: string;
  referencedImageId: string;
  worldPolyline: number[][];
}): Promise<{ segmentationId: string; segmentIndex: number } | null> => {
  const { segmentationService, cornerstoneViewportService } = servicesManager?.services || {};
  if (!segmentationService || !cornerstoneViewportService || !worldPolyline?.length) {
    return null;
  }

  const activeSegmentation = segmentationService.getActiveSegmentation(viewportId);
  const activeSegment = segmentationService.getActiveSegment(viewportId);
  if (!activeSegmentation || !activeSegment?.segmentIndex) {
    return null;
  }

  const { segmentationId } = activeSegmentation;
  const segmentIndex = activeSegment.segmentIndex as number;

  // --- Volume-based labelmap (typical for CT in Segmentation mode) ---
  const labelmapVolume = segmentationService.getLabelmapVolume?.(segmentationId);
  if (labelmapVolume?.imageData && labelmapVolume?.voxelManager) {
    const imageData = labelmapVolume.imageData;

    // Convert each world contour point to continuous IJK index space.
    const ijkPoints = worldPolyline.map(worldPoint => {
      const ijk = imageData.worldToIndex(worldPoint);
      return [Math.round(ijk[0]), Math.round(ijk[1]), Math.round(ijk[2])] as [
        number,
        number,
        number,
      ];
    });

    if (!ijkPoints.length) {
      return null;
    }

    // All points in a planar contour share the same K (slice index).
    const k = ijkPoints[0][2];
    const dims = labelmapVolume.dimensions as [number, number, number]; // [dimI, dimJ, dimK]
    const [dimI, dimJ] = dims;

    // 2-D polygon in (I, J) = (col, row) space for the rasterizer.
    const polygon2D = ijkPoints.map(([i, j]) => [i, j] as [number, number]);

    // Compute bounding box to minimise iteration.
    let minI = Infinity;
    let minJ = Infinity;
    let maxI = -Infinity;
    let maxJ = -Infinity;
    for (const [pi, pj] of polygon2D) {
      if (pi < minI) minI = pi;
      if (pj < minJ) minJ = pj;
      if (pi > maxI) maxI = pi;
      if (pj > maxJ) maxJ = pj;
    }
    minI = Math.max(0, Math.floor(minI));
    minJ = Math.max(0, Math.floor(minJ));
    maxI = Math.min(dimI - 1, Math.ceil(maxI));
    maxJ = Math.min(dimJ - 1, Math.ceil(maxJ));

    const vm = labelmapVolume.voxelManager;
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        if (isPointInPolygon([i + 0.5, j + 0.5], polygon2D as number[][])) {
          vm.setAtIJK(i, j, k, segmentIndex);
        }
      }
    }

    labelmapVolume.invalidate?.();
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      [k],
      segmentIndex
    );
    return { segmentationId, segmentIndex };
  }

  // --- Stack-based labelmap fallback ---
  const csSegState = segmentation.state.getSegmentation(segmentationId);
  const labelmapData = csSegState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

  const referencedImageIds = labelmapData?.referencedImageIds || [];
  const imageIds = labelmapData?.imageIds || [];
  if (!imageIds.length) {
    return null;
  }

  const frameIndex = referencedImageId ? referencedImageIds.indexOf(referencedImageId) : 0;
  if (frameIndex < 0 || !imageIds[frameIndex]) {
    return null;
  }

  const labelmapImageId = imageIds[frameIndex];
  const labelmapImage =
    cache.getImage(labelmapImageId) ||
    (await imageLoader.loadAndCacheImage(labelmapImageId));

  const scalarData = labelmapImage?.voxelManager?.getScalarData?.() as Uint8Array | undefined;
  const width: number = labelmapImage?.columns || labelmapImage?.width || 0;
  const height: number = labelmapImage?.rows || labelmapImage?.height || 0;

  if (!scalarData || !width || !height) {
    return null;
  }

  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const polygon = worldPolyline.map(worldPoint => {
    const indexPoint =
      viewport?.worldToIndex
        ? viewport.worldToIndex(worldPoint)
        : csUtils.worldToImageCoords(referencedImageId, worldPoint as [number, number, number]);
    return [indexPoint[0], indexPoint[1]] as [number, number];
  });

  rasterizePolygonToMask(scalarData, polygon, segmentIndex, width, height);
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    segmentationId,
    [frameIndex],
    segmentIndex
  );

  return { segmentationId, segmentIndex };
};
