export interface PhaseResult {
  edFrame: number;
  esFrame: number;
}

export class PhaseDetector {
  static detect(volumeSeries: number[]): PhaseResult {
    const nonZeroCount = volumeSeries.filter(v => v > 0).length;
    if (nonZeroCount < 2) return { edFrame: -1, esFrame: -1 };

    let edFrame = -1;
    let esFrame = -1;
    let maxVol = -Infinity;
    let minVol = Infinity;

    for (let i = 0; i < volumeSeries.length; i++) {
      const v = volumeSeries[i];
      if (v <= 0) continue; // zero means no segmentation data, not actual zero volume
      if (v > maxVol) { maxVol = v; edFrame = i; }
      if (v < minVol) { minVol = v; esFrame = i; }
    }

    return { edFrame, esFrame };
  }
}
