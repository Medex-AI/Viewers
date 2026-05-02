import { metaData } from '@cornerstonejs/core';

export type HRSource = 'dicom' | 'derived' | null;

export interface HRResult {
  heartRateBpm: number | null;
  source: HRSource;
}

const readPositiveNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const v = Array.isArray(value) ? value[0] : value;
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : null;
  return n !== null && isFinite(n) && n > 0 ? n : null;
};

export class COComputer {
  static extractHR(imageId: string): HRResult {
    const instance = metaData.get('instance', imageId) ?? {};

    // Primary: DICOM tag (0018,1088) HeartRate
    const directHR = readPositiveNumber(instance.x00181088 ?? instance.HeartRate ?? instance.heartRate);
    if (directHR !== null) return { heartRateBpm: directHR, source: 'dicom' };

    // Fallback: derive from TR × CardiacNumberOfImages
    const tr = readPositiveNumber(instance.x00180080 ?? instance.RepetitionTime ?? instance.repetitionTime);
    const numImages = readPositiveNumber(instance.x00181090 ?? instance.CardiacNumberOfImages);
    if (tr !== null && numImages !== null) {
      return { heartRateBpm: 60000 / (tr * numImages), source: 'derived' };
    }

    return { heartRateBpm: null, source: null };
  }

  static computeCO(svMl: number, hrBpm: number): number {
    return (svMl * hrBpm) / 1000;
  }
}
