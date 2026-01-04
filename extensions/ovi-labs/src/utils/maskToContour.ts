export type ContourPolyline = [number, number][];

const keyForPoint = (point: [number, number]) => `${point[0]},${point[1]}`;

const addSegment = (
  segments: Map<string, [number, number][]>,
  a: [number, number],
  b: [number, number]
) => {
  const keyA = keyForPoint(a);
  const keyB = keyForPoint(b);

  if (!segments.has(keyA)) {
    segments.set(keyA, []);
  }
  if (!segments.has(keyB)) {
    segments.set(keyB, []);
  }

  segments.get(keyA)?.push(b);
  segments.get(keyB)?.push(a);
};

const traceContours = (segments: Map<string, [number, number][]>): ContourPolyline[] => {
  const contours: ContourPolyline[] = [];
  const visited = new Set<string>();

  for (const [startKey, neighbors] of segments.entries()) {
    if (visited.has(startKey) || neighbors.length === 0) {
      continue;
    }

    const startParts = startKey.split(',');
    const start: [number, number] = [parseFloat(startParts[0]), parseFloat(startParts[1])];
    const contour: [number, number][] = [start];

    let current = start;
    let previous: [number, number] | null = null;

    while (true) {
      const currentKey = keyForPoint(current);
      visited.add(currentKey);
      const options = segments.get(currentKey) || [];
      const next = options.find(option => !previous || keyForPoint(option) !== keyForPoint(previous));

      if (!next) {
        break;
      }

      contour.push(next);
      previous = current;
      current = next;

      if (keyForPoint(current) === startKey) {
        break;
      }
    }

    if (contour.length > 2) {
      contours.push(contour);
    }
  }

  return contours;
};

export const maskToContours = (
  mask: Uint8Array,
  width: number,
  height: number,
  labelValue: number
): ContourPolyline[] => {
  const segments = new Map<string, [number, number][]>();

  const getValue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return 0;
    }
    return mask[y * width + x] === labelValue ? 1 : 0;
  };

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const tl = getValue(x, y);
      const tr = getValue(x + 1, y);
      const br = getValue(x + 1, y + 1);
      const bl = getValue(x, y + 1);

      const state = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (state === 0 || state === 15) {
        continue;
      }

      const top: [number, number] = [x + 0.5, y];
      const right: [number, number] = [x + 1, y + 0.5];
      const bottom: [number, number] = [x + 0.5, y + 1];
      const left: [number, number] = [x, y + 0.5];

      switch (state) {
        case 1:
          addSegment(segments, left, bottom);
          break;
        case 2:
          addSegment(segments, bottom, right);
          break;
        case 3:
          addSegment(segments, left, right);
          break;
        case 4:
          addSegment(segments, top, right);
          break;
        case 5:
          addSegment(segments, top, left);
          addSegment(segments, bottom, right);
          break;
        case 6:
          addSegment(segments, top, bottom);
          break;
        case 7:
          addSegment(segments, top, left);
          break;
        case 8:
          addSegment(segments, top, left);
          break;
        case 9:
          addSegment(segments, top, bottom);
          break;
        case 10:
          addSegment(segments, top, right);
          addSegment(segments, bottom, left);
          break;
        case 11:
          addSegment(segments, top, right);
          break;
        case 12:
          addSegment(segments, left, right);
          break;
        case 13:
          addSegment(segments, bottom, right);
          break;
        case 14:
          addSegment(segments, left, bottom);
          break;
        default:
          break;
      }
    }
  }

  return traceContours(segments);
};
