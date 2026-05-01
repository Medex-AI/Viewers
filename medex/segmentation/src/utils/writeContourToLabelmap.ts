import { cache, imageLoader, metaData, utilities as csUtils } from '@cornerstonejs/core';
import { DicomMetadataStore } from '@ohif/core';
import { segmentation, Enums as toolEnums } from '@cornerstonejs/tools';
import { rasterizePolygonToMask, isPointInPolygon } from './rasterizeContour';

const toVector3 = (value: unknown): [number, number, number] | null => {
  if (!value) return null;

  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\\')
      : null;

  if (!values || values.length < 3) return null;

  const vector = values.slice(0, 3).map(Number);
  return vector.every(Number.isFinite) ? (vector as [number, number, number]) : null;
};

const dot = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const getImagePlaneGeometry = (imageId: string) => {
  const imagePlane = metaData.get('imagePlaneModule', imageId) || {};
  const instance = DicomMetadataStore.getInstanceByImageId(imageId) || {};
  const rowCosines =
    toVector3(imagePlane.rowCosines) ||
    toVector3(imagePlane.rowCosine) ||
    toVector3(imagePlane.imageOrientationPatient?.slice?.(0, 3)) ||
    toVector3(instance.ImageOrientationPatient?.slice?.(0, 3));
  const columnCosines =
    toVector3(imagePlane.columnCosines) ||
    toVector3(imagePlane.columnCosine) ||
    toVector3(imagePlane.imageOrientationPatient?.slice?.(3, 6)) ||
    toVector3(instance.ImageOrientationPatient?.slice?.(3, 6));
  const imagePositionPatient =
    toVector3(imagePlane.imagePositionPatient) ||
    toVector3(imagePlane.imagePosition) ||
    toVector3(instance.ImagePositionPatient);

  if (!rowCosines || !columnCosines || !imagePositionPatient) {
    return null;
  }

  return {
    rowCosines,
    columnCosines,
    normal: cross(rowCosines, columnCosines),
    imagePositionPatient,
  };
};

const hasReconstructableImageGeometry = (imageIds: string[]): boolean => {
  if (imageIds.length < 2) {
    return true;
  }

  const geometries = imageIds.map(getImagePlaneGeometry);
  if (geometries.some(geometry => !geometry)) {
    return true;
  }

  const [first] = geometries;
  const orientationTolerance = 0.999;
  const positionTolerance = 0.01;
  const slicePositions = new Set<string>();

  for (const geometry of geometries) {
    if (
      Math.abs(dot(first.rowCosines, geometry.rowCosines)) < orientationTolerance ||
      Math.abs(dot(first.columnCosines, geometry.columnCosines)) < orientationTolerance
    ) {
      return false;
    }

    const slicePosition = dot(geometry.imagePositionPatient, first.normal);
    const positionKey = (Math.round(slicePosition / positionTolerance) * positionTolerance).toFixed(
      2
    );
    if (slicePositions.has(positionKey)) {
      return false;
    }
    slicePositions.add(positionKey);
  }

  return true;
};

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
  mode = 'draw',
}: {
  servicesManager: any;
  viewportId: string;
  referencedImageId: string;
  worldPolyline: number[][];
  mode?: 'draw' | 'erase';
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
  const writeValue = mode === 'erase' ? 0 : segmentIndex;
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

  const csSegState = segmentation.state.getSegmentation(segmentationId);
  const labelmapData = csSegState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

  const referencedImageIds = labelmapData?.referencedImageIds || [];
  const imageIds = labelmapData?.imageIds || [];
  const isStackViewport = viewport?.type === 'stack';
  const canUseVolumeLabelmap =
    !isStackViewport &&
    (Boolean((labelmapData as any)?.volumeId) || hasReconstructableImageGeometry(referencedImageIds));

  // --- Volume-based labelmap (typical for CT in Segmentation mode) ---
  const labelmapVolume = segmentationService.getLabelmapVolume?.(segmentationId);
  if (canUseVolumeLabelmap && labelmapVolume?.imageData && labelmapVolume?.voxelManager) {
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
          const currentValue = vm.getAtIJK?.(i, j, k);
          if (mode === 'draw' || currentValue === undefined || currentValue === segmentIndex) {
            vm.setAtIJK(i, j, k, writeValue);
          }
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
  if (!imageIds.length) {
    return null;
  }

  const currentViewportImageIndex = viewport?.getCurrentImageIdIndex?.();
  const frameIndex = referencedImageId
    ? referencedImageIds.indexOf(referencedImageId)
    : typeof currentViewportImageIndex === 'number'
      ? currentViewportImageIndex
      : 0;
  if (frameIndex < 0 || !imageIds[frameIndex]) {
    return null;
  }

  const labelmapImageId =
    segmentation.state.getCurrentLabelmapImageIdForViewport?.(viewportId, segmentationId) ||
    imageIds[frameIndex];
  const labelmapImage =
    cache.getImage(labelmapImageId) || (await imageLoader.loadAndCacheImage(labelmapImageId));

  const scalarData = labelmapImage?.voxelManager?.getScalarData?.() as Uint8Array | undefined;
  const width: number = labelmapImage?.columns || labelmapImage?.width || 0;
  const height: number = labelmapImage?.rows || labelmapImage?.height || 0;

  if (!scalarData || !width || !height) {
    return null;
  }

  const polygon = worldPolyline.map(worldPoint => {
    const indexPoint = viewport?.worldToIndex
      ? viewport.worldToIndex(worldPoint)
      : csUtils.worldToImageCoords(referencedImageId, worldPoint as [number, number, number]);
    return [indexPoint[0], indexPoint[1]] as [number, number];
  });

  if (mode === 'erase') {
    const eraseMask = new Uint8Array(width * height);
    rasterizePolygonToMask(eraseMask, polygon, 1, width, height);
    for (let i = 0; i < eraseMask.length; i++) {
      if (eraseMask[i] && scalarData[i] === segmentIndex) {
        scalarData[i] = 0;
      }
    }
  } else {
    rasterizePolygonToMask(scalarData, polygon, segmentIndex, width, height);
  }
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    segmentationId,
    [frameIndex],
    segmentIndex
  );

  return { segmentationId, segmentIndex };
};
