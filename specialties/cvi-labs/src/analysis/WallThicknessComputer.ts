export interface FrameMask {
  frameIndex: number;
  data: Uint8Array;
  width: number;
  height: number;
}

export class WallThicknessComputer {
  static computeThicknessSeries(
    lvCavityMasks: FrameMask[],
    myoMasks: FrameMask[],
    spacingMm: number
  ): (number | null)[] {
    const innerByFrame = new Map(lvCavityMasks.map(m => [m.frameIndex, m]));
    const outerByFrame = new Map(myoMasks.map(m => [m.frameIndex, m]));

    const allFrames = new Set([...innerByFrame.keys(), ...outerByFrame.keys()]);
    if (allFrames.size === 0) return [];

    const maxFrame = Math.max(...allFrames);
    const result: (number | null)[] = new Array(maxFrame + 1).fill(null);

    for (const frame of allFrames) {
      const inner = innerByFrame.get(frame);
      const outer = outerByFrame.get(frame);
      if (!inner || !outer) continue;

      const thickness = this._meanBoundaryDistance(inner, outer, spacingMm);
      result[frame] = thickness;
    }
    return result;
  }

  private static _meanBoundaryDistance(
    inner: FrameMask,
    outer: FrameMask,
    spacingMm: number
  ): number | null {
    const { width, height } = inner;
    // Build distance transform from outer boundary using BFS
    const outerDist = this._distanceTransform(outer.data, width, height);

    // Find inner boundary pixels (LV Cavity edge touching background or myocardium)
    const innerBoundaryPixels: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (inner.data[idx] !== 1) continue;
        // Check if any 4-neighbour is outside inner mask
        const isEdge =
          (x > 0 && inner.data[idx - 1] === 0) ||
          (x < width - 1 && inner.data[idx + 1] === 0) ||
          (y > 0 && inner.data[idx - width] === 0) ||
          (y < height - 1 && inner.data[idx + width] === 0);
        if (isEdge) innerBoundaryPixels.push(idx);
      }
    }

    if (innerBoundaryPixels.length === 0) return null;

    let totalDist = 0;
    for (const idx of innerBoundaryPixels) {
      totalDist += outerDist[idx];
    }
    return (totalDist / innerBoundaryPixels.length) * spacingMm;
  }

  // BFS-based distance transform: distance from each pixel to the nearest
  // pixel NOT in the outer mask (i.e., the outer boundary distance inward)
  private static _distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
    const dist = new Float32Array(width * height).fill(Infinity);
    const queue: number[] = [];

    // Seed: outer-mask pixels adjacent to non-mask pixels are at distance 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (mask[idx] !== 1) { dist[idx] = 0; continue; }
        const isEdge =
          (x > 0 && mask[idx - 1] === 0) ||
          (x < width - 1 && mask[idx + 1] === 0) ||
          (y > 0 && mask[idx - width] === 0) ||
          (y < height - 1 && mask[idx + width] === 0);
        if (isEdge) { dist[idx] = 0; queue.push(idx); }
      }
    }

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const cx = cur % width;
      const cy = (cur / width) | 0;
      const d = dist[cur] + 1;
      // 4-connected neighbours using coordinate bounds (avoids modulo on ni)
      if (cx > 0)         { const ni = cur - 1; if (mask[ni] === 1 && dist[ni] > d) { dist[ni] = d; queue.push(ni); } }
      if (cx < width - 1) { const ni = cur + 1; if (mask[ni] === 1 && dist[ni] > d) { dist[ni] = d; queue.push(ni); } }
      if (cy > 0)         { const ni = cur - width; if (mask[ni] === 1 && dist[ni] > d) { dist[ni] = d; queue.push(ni); } }
      if (cy < height - 1){ const ni = cur + width; if (mask[ni] === 1 && dist[ni] > d) { dist[ni] = d; queue.push(ni); } }
    }
    return dist;
  }
}
