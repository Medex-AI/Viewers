export function pointInPolygon(point: number[], polygon: number[][]): boolean {
  let isInside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];

    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

export function distanceToSegment(point: number[], start: number[], end: number[]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];

  if (dx === 0 && dy === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }

  const t = Math.max(
    0,
    Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy))
  );

  const projection = [start[0] + t * dx, start[1] + t * dy];
  return Math.hypot(point[0] - projection[0], point[1] - projection[1]);
}

export function isPointNearContourEdge(
  point: number[],
  polygon: number[][],
  isClosed = true,
  proximityPx: number
): boolean {
  const edgeCount = isClosed ? polygon.length : polygon.length - 1;

  for (let i = 0; i < edgeCount; i++) {
    const start = polygon[i];
    const end = polygon[(i + 1) % polygon.length];
    if (distanceToSegment(point, start, end) <= proximityPx) {
      return true;
    }
  }

  return false;
}
