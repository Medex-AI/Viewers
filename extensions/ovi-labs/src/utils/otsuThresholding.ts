export interface OtsuResult {
  thresholds: number[];
  labels: Uint8Array;
}

const buildHistogram = (pixels: Uint8Array): Uint32Array => {
  const hist = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 1) {
    hist[pixels[i]] += 1;
  }
  return hist;
};

const computeCumulative = (hist: Uint32Array) => {
  const total = hist.reduce((sum, value) => sum + value, 0);
  const cumulative = new Float64Array(hist.length);
  const cumulativeMean = new Float64Array(hist.length);
  let sum = 0;
  let meanSum = 0;

  for (let i = 0; i < hist.length; i += 1) {
    sum += hist[i];
    meanSum += hist[i] * i;
    cumulative[i] = sum / total;
    cumulativeMean[i] = meanSum / total;
  }

  return { cumulative, cumulativeMean };
};

const classVariance = (
  cumulative: Float64Array,
  cumulativeMean: Float64Array,
  start: number,
  end: number
): number => {
  if (start > end) {
    return 0;
  }

  const w = cumulative[end] - (start > 0 ? cumulative[start - 1] : 0);
  if (w <= 0) {
    return 0;
  }

  const mean =
    (cumulativeMean[end] - (start > 0 ? cumulativeMean[start - 1] : 0)) / w;
  return w * mean * mean;
};

export const computeMultiOtsuThresholds = (
  pixels: Uint8Array,
  classes: number
): number[] => {
  const hist = buildHistogram(pixels);
  const { cumulative, cumulativeMean } = computeCumulative(hist);
  const bins = hist.length;

  if (classes < 2) {
    return [];
  }

  const dp: number[][] = Array.from({ length: classes + 1 }, () =>
    new Array(bins).fill(0)
  );
  const backtrack: number[][] = Array.from({ length: classes + 1 }, () =>
    new Array(bins).fill(0)
  );

  for (let t = 0; t < bins; t += 1) {
    dp[1][t] = classVariance(cumulative, cumulativeMean, 0, t);
  }

  for (let k = 2; k <= classes; k += 1) {
    for (let t = k - 1; t < bins; t += 1) {
      let bestValue = 0;
      let bestIndex = 0;
      for (let i = k - 2; i < t; i += 1) {
        const value = dp[k - 1][i] + classVariance(cumulative, cumulativeMean, i + 1, t);
        if (value > bestValue) {
          bestValue = value;
          bestIndex = i;
        }
      }
      dp[k][t] = bestValue;
      backtrack[k][t] = bestIndex;
    }
  }

  const thresholds: number[] = [];
  let t = bins - 1;
  for (let k = classes; k > 1; k -= 1) {
    const threshold = backtrack[k][t];
    thresholds.push(threshold);
    t = threshold;
  }

  return thresholds.reverse();
};

export const applyOtsuThresholds = (
  pixels: Uint8Array,
  thresholds: number[],
  classes: number
): Uint8Array => {
  const labels = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    const value = pixels[i];
    let label = 1;
    for (let t = 0; t < thresholds.length; t += 1) {
      if (value <= thresholds[t]) {
        label = t + 1;
        break;
      }
      label = t + 2;
    }
    labels[i] = Math.min(label, classes);
  }
  return labels;
};

export const runMaskedOtsu = (
  pixels: Uint8Array,
  mask: Uint8Array,
  classes = 4
): OtsuResult => {
  const maskedPixels: number[] = [];
  for (let i = 0; i < pixels.length; i += 1) {
    if (mask[i]) {
      maskedPixels.push(pixels[i]);
    }
  }

  if (maskedPixels.length === 0) {
    return { thresholds: [], labels: new Uint8Array(pixels.length) };
  }

  const thresholds = computeMultiOtsuThresholds(Uint8Array.from(maskedPixels), classes);
  const rawLabels = applyOtsuThresholds(pixels, thresholds, classes);
  const labels = new Uint8Array(pixels.length);

  for (let i = 0; i < pixels.length; i += 1) {
    if (mask[i]) {
      labels[i] = rawLabels[i];
    }
  }

  return { thresholds, labels };
};
