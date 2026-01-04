import { metaData } from '@cornerstonejs/core';

export type FrameTimingSource = 'FrameTime' | 'RepetitionTime' | 'CineRate' | 'Default';

export type FrameTiming = {
  frameTimeMs: number;
  frameRate: number;
  source: FrameTimingSource;
};

const DEFAULT_FRAME_RATE = 30;

const readNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return readNumber(value[0]);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const pickFirstPositive = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = readNumber(value);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

const resolveTimingFromImageId = (imageId: string): FrameTiming | null => {
  const cineModule = metaData.get('cineModule', imageId) || {};
  const instance = metaData.get('instance', imageId) || {};
  const seriesModule = metaData.get('generalSeriesModule', imageId) || {};
  const generalImageModule = metaData.get('generalImageModule', imageId) || {};

  const frameTimeMs = pickFirstPositive(
    cineModule.frameTime,
    instance.FrameTime,
    instance.frameTime,
    instance?.x00181063
  );

  if (frameTimeMs) {
    return {
      frameTimeMs,
      frameRate: 1000 / frameTimeMs,
      source: 'FrameTime',
    };
  }

  const repetitionTimeMs = pickFirstPositive(
    instance.RepetitionTime,
    instance.repetitionTime,
    seriesModule.RepetitionTime,
    seriesModule.repetitionTime,
    generalImageModule.RepetitionTime,
    generalImageModule.repetitionTime,
    instance?.x00180080
  );

  if (repetitionTimeMs) {
    return {
      frameTimeMs: repetitionTimeMs,
      frameRate: 1000 / repetitionTimeMs,
      source: 'RepetitionTime',
    };
  }

  const cineRate = pickFirstPositive(
    cineModule.cineRate,
    cineModule.CineRate,
    instance.CineRate,
    instance.cineRate,
    seriesModule.CineRate,
    seriesModule.cineRate,
    instance?.x00180040
  );

  if (cineRate) {
    return {
      frameTimeMs: 1000 / cineRate,
      frameRate: cineRate,
      source: 'CineRate',
    };
  }

  return null;
};

export const extractFrameTimingFromImageIds = (imageIds: string[]): FrameTiming => {
  for (const imageId of imageIds) {
    const timing = resolveTimingFromImageId(imageId);
    if (timing) {
      return timing;
    }
  }

  return {
    frameTimeMs: 1000 / DEFAULT_FRAME_RATE,
    frameRate: DEFAULT_FRAME_RATE,
    source: 'Default',
  };
};

export const logFrameTiming = (timing: FrameTiming) => {
  const frameRateLabel = Number.isFinite(timing.frameRate) ? timing.frameRate.toFixed(3) : 'N/A';
  console.info(`[Ovi Labs] Frame rate detected: ${frameRateLabel} fps (${timing.source}).`);
};
