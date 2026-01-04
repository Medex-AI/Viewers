import { saveSegmentationFrame, loadSegmentationFrames } from './segmentationPersistence';

export interface SegmentationFramePayload {
  seriesInstanceUID: string;
  model: string;
  frameKey: string;
  width: number;
  height: number;
  maskData: Uint8Array;
  labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }>;
}

const segmentationCache = new Map<string, Map<string, Map<string, SegmentationFramePayload>>>();

export const cacheSegmentationFrame = async (payload: SegmentationFramePayload) => {
  const { seriesInstanceUID, model, frameKey } = payload;
  if (!segmentationCache.has(seriesInstanceUID)) {
    segmentationCache.set(seriesInstanceUID, new Map());
  }

  const modelMap = segmentationCache.get(seriesInstanceUID)!;
  if (!modelMap.has(model)) {
    modelMap.set(model, new Map());
  }

  modelMap.get(model)!.set(frameKey, payload);
  await saveSegmentationFrame({ ...payload, updatedAt: Date.now() });
};

export const getCachedSegmentationFrame = (
  seriesInstanceUID: string,
  model: string,
  frameKey: string
): SegmentationFramePayload | undefined => {
  return segmentationCache.get(seriesInstanceUID)?.get(model)?.get(frameKey);
};

export const hydrateSegmentationCache = async (seriesInstanceUID: string) => {
  const entries = await loadSegmentationFrames(seriesInstanceUID);
  if (!segmentationCache.has(seriesInstanceUID)) {
    segmentationCache.set(seriesInstanceUID, new Map());
  }

  const modelMap = segmentationCache.get(seriesInstanceUID)!;
  entries.forEach(entry => {
    if (!modelMap.has(entry.model)) {
      modelMap.set(entry.model, new Map());
    }
    modelMap.get(entry.model)!.set(entry.frameKey, {
      seriesInstanceUID: entry.seriesInstanceUID,
      model: entry.model,
      frameKey: entry.frameKey,
      width: entry.width,
      height: entry.height,
      maskData: entry.maskData,
      labelMap: entry.labelMap,
    });
  });
};
