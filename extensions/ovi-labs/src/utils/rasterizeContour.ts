/**
 * Contour rasterization utilities shared across OVI Labs panels.
 *
 * Provides point-in-polygon test and scanline fill for converting closed
 * polylines (in any 2-D coordinate space) into pixel masks.
 */

/**
 * Ray-casting point-in-polygon test.
 * Works for simple (non-self-intersecting) polygons.
 */
export function isPointInPolygon(point: [number, number], polygon: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Rasterize a closed polygon into a flat pixel mask using scanline fill.
 *
 * @param targetMask  Destination Uint8Array of length `width * height`.
 * @param polygon     Closed polyline as `[x, y]` pairs in pixel coordinates.
 * @param value       Label value to write for pixels inside the polygon.
 * @param width       Width of the mask in pixels.
 * @param height      Height of the mask in pixels.
 */
export function rasterizePolygonToMask(
  targetMask: Uint8Array,
  polygon: [number, number][],
  value: number,
  width: number,
  height: number
): void {
  if (!polygon.length) {
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of polygon) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const startX = Math.max(0, Math.floor(minX));
  const endX = Math.min(width - 1, Math.ceil(maxX));
  const startY = Math.max(0, Math.floor(minY));
  const endY = Math.min(height - 1, Math.ceil(maxY));

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      if (isPointInPolygon([x + 0.5, y + 0.5], polygon as number[][])) {
        targetMask[y * width + x] = value;
      }
    }
  }
}
