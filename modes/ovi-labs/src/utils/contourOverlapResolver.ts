/**
 * Utility for resolving overlapping contours when converting to pixel masks.
 * When multiple contours overlap at a pixel, the last-edited label wins.
 */

interface ContourAnnotation {
  annotationUID: string;
  data: {
    labelId: string;
    labelName: string;
    labelColor: string;
    modifiedAt: number;
    contour?: {
      polyline: number[][];
    };
  };
  metadata?: {
    toolName: string;
  };
}

/**
 * Sorts contours by modification time (oldest first).
 * When rasterizing to a pixel mask, iterate in this order so
 * the last-edited contour overwrites earlier ones at overlapping pixels.
 */
export function sortContoursByEditTime(contours: ContourAnnotation[]): ContourAnnotation[] {
  return [...contours].sort((a, b) => {
    const timeA = a.data?.modifiedAt || 0;
    const timeB = b.data?.modifiedAt || 0;
    return timeA - timeB; // Oldest first
  });
}

/**
 * Checks if a point is inside a polygon using ray casting algorithm.
 * Used for determining pixel-contour overlap during rasterization.
 */
export function isPointInPolygon(point: [number, number], polygon: number[][]): boolean {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Converts canvas coordinates to world coordinates for contour comparison.
 */
export function canvasToWorld(
  canvasPoint: [number, number],
  viewport: any
): [number, number, number] {
  return viewport.canvasToWorld(canvasPoint);
}

/**
 * Converts world coordinates to canvas coordinates.
 */
export function worldToCanvas(worldPoint: number[], viewport: any): [number, number] {
  return viewport.worldToCanvas(worldPoint);
}

/**
 * Generates a pixel mask from multiple contours with overlap resolution.
 * The last-edited contour wins at overlapping pixels.
 *
 * @param contours - Array of contour annotations
 * @param viewport - Cornerstone viewport for coordinate conversion
 * @param width - Mask width in pixels
 * @param height - Mask height in pixels
 * @returns Uint8Array where each pixel value is the label index (0 = background, 1-4 = labels)
 */
export function contoursToPixelMask(
  contours: ContourAnnotation[],
  viewport: any,
  width: number,
  height: number
): {
  maskData: Uint8Array;
  labelMap: Map<number, { labelId: string; labelName: string; labelColor: string }>;
} {
  const maskData = new Uint8Array(width * height);
  const labelMap = new Map<number, { labelId: string; labelName: string; labelColor: string }>();

  // Sort contours so last-edited is processed last (overwrites earlier ones)
  const sortedContours = sortContoursByEditTime(contours);

  // Assign a unique index to each label
  let nextLabelIndex = 1;
  const labelIdToIndex = new Map<string, number>();

  sortedContours.forEach(contour => {
    const polyline = contour.data?.contour?.polyline;
    if (!polyline || polyline.length < 3) {
      return; // Skip invalid contours
    }

    // Get or assign label index
    const labelId = contour.data.labelId;
    let labelIndex = labelIdToIndex.get(labelId);
    if (labelIndex === undefined) {
      labelIndex = nextLabelIndex++;
      labelIdToIndex.set(labelId, labelIndex);
      labelMap.set(labelIndex, {
        labelId: contour.data.labelId,
        labelName: contour.data.labelName,
        labelColor: contour.data.labelColor,
      });
    }

    // Convert world coordinates to canvas coordinates
    const canvasPolygon = polyline.map(point => worldToCanvas(point, viewport));

    // Rasterize: check each pixel if it's inside the polygon
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (isPointInPolygon([x, y], canvasPolygon)) {
          maskData[y * width + x] = labelIndex;
        }
      }
    }
  });

  return { maskData, labelMap };
}

/**
 * Example usage documentation:
 *
 * ```typescript
 * import { contoursToPixelMask } from './contourOverlapResolver';
 * import { annotation } from '@cornerstonejs/tools';
 *
 * // Get all contours for the current frame
 * const contours = annotation.state.getAnnotations('ManualContour', element);
 *
 * // Generate pixel mask with overlap resolution
 * const { maskData, labelMap } = contoursToPixelMask(
 *   contours,
 *   viewport,
 *   roiWidth,
 *   roiHeight
 * );
 *
 * // maskData is a Uint8Array where each pixel value corresponds to a label
 * // labelMap provides the mapping from pixel values to label metadata
 * ```
 */
