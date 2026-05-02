export type SliceMask = { frameIndex: number; areaMm2: number };
export type SliceMasks = SliceMask[];

export class VolumeComputer {
  static computeVolumeSeries(sliceMasks: SliceMasks[], spacingMm: number): number[] {
    if (sliceMasks.length === 0) return [];

    // Build map: frameIndex → total area across slices
    const frameAreaMap = new Map<number, number>();
    for (const slice of sliceMasks) {
      for (const { frameIndex, areaMm2 } of slice) {
        frameAreaMap.set(frameIndex, (frameAreaMap.get(frameIndex) ?? 0) + areaMm2);
      }
    }

    if (frameAreaMap.size === 0) return [];

    const maxFrame = Math.max(...frameAreaMap.keys());
    const result = new Array<number>(maxFrame + 1).fill(0);
    for (const [frame, totalArea] of frameAreaMap) {
      result[frame] = (totalArea * spacingMm) / 1000;
    }
    return result;
  }
}
