import { CardiacMetrics } from './index';

export class CardiacMetricsComputer {
  static compute(lvVolumeSeries: number[]): CardiacMetrics {
    const nonZero = lvVolumeSeries.filter(v => v > 0);
    if (nonZero.length < 2) {
      return { ef: null, edvMl: null, esvMl: null, strokeVolumeMl: null, wallThicknessMm: null };
    }

    const edvMl = Math.max(...lvVolumeSeries);
    const esvMl = Math.min(...lvVolumeSeries);
    const strokeVolumeMl = edvMl - esvMl;
    const ef = edvMl === 0 ? null : parseFloat(((strokeVolumeMl / edvMl) * 100).toFixed(1));

    return { ef, edvMl, esvMl, strokeVolumeMl, wallThicknessMm: null };
  }
}
