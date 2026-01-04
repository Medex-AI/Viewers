export interface RoiSegmentationFrame {
  frameKey: string;
  imageId?: string;
  frameNumber?: number;
  roiAnnotationUID?: string;
  roiWidthWorld?: number;
  roiHeightWorld?: number;
  width: number;
  height: number;
  maskData: Uint8Array;
  labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }>;
  generatedAt: number;
}

const roiSegmentationStore = new Map<string, Map<string, RoiSegmentationFrame>>();

export const setRoiSegmentationFrame = (
  seriesInstanceUID: string,
  frameKey: string,
  frame: RoiSegmentationFrame
): void => {
  if (!seriesInstanceUID || !frameKey) {
    return;
  }

  if (!roiSegmentationStore.has(seriesInstanceUID)) {
    roiSegmentationStore.set(seriesInstanceUID, new Map());
  }

  const seriesMap = roiSegmentationStore.get(seriesInstanceUID);
  seriesMap?.set(frameKey, frame);
};

export const getRoiSegmentationFrame = (
  seriesInstanceUID: string,
  frameKey: string
): RoiSegmentationFrame | undefined => {
  return roiSegmentationStore.get(seriesInstanceUID)?.get(frameKey);
};

export const getRoiSegmentationSeries = (
  seriesInstanceUID: string
): RoiSegmentationFrame[] => {
  return Array.from(roiSegmentationStore.get(seriesInstanceUID)?.values() || []);
};

export const clearRoiSegmentationSeries = (seriesInstanceUID: string): void => {
  roiSegmentationStore.delete(seriesInstanceUID);
};

export const resetRoiSegmentationStore = (): void => {
  roiSegmentationStore.clear();
};
