import {
  saveSegmentationFrame as saveSharedSegmentationFrame,
  loadSegmentationFrames as loadSharedSegmentationFrames,
  deleteSegmentationFrame as deleteSharedSegmentationFrame,
  deleteSegmentationFrames as deleteSharedSegmentationFrames,
} from '../../../extensions/ovi-labs/src/utils/segmentationPersistence';

export interface StoredSegFrame {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  model: string;
  frameKey: string; // referencedImageId (stable DICOM image identifier)
  frameNumber: number;
  width: number;
  height: number;
  maskData: Uint8Array;
  labelMap?: Record<
    number,
    { labelId: string; labelName: string; labelColor: string; labelLocked?: boolean }
  >;
  segmentationLabel?: string;
  updatedAt: number;
}

export const saveSegFrame = async (payload: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  frameKey: string;
  frameNumber: number;
  width: number;
  height: number;
  maskData: Uint8Array;
  labelMap?: Record<
    number,
    { labelId: string; labelName: string; labelColor: string; labelLocked?: boolean }
  >;
  segmentationLabel?: string;
}): Promise<void> => {
  await saveSharedSegmentationFrame({
    ...payload,
    model: 'segmentation',
    labelMap: payload.labelMap || {},
    segmentationLabel: payload.segmentationLabel,
    updatedAt: Date.now(),
  } as Parameters<typeof saveSharedSegmentationFrame>[0]);
};

export const loadSegFrames = async (
  studyInstanceUID: string,
  seriesInstanceUID: string
): Promise<StoredSegFrame[]> => {
  console.error('[segmentation-load-debug] storage:loadSegFrames:start', {
    studyInstanceUID,
    seriesInstanceUID,
  });
  const entries = await loadSharedSegmentationFrames(
    seriesInstanceUID,
    studyInstanceUID,
    'segmentation'
  );
  console.error('[segmentation-load-debug] storage:loadSegFrames:done', {
    studyInstanceUID,
    seriesInstanceUID,
    count: entries.length,
    nonEmptyCount: entries.filter(entry => entry.maskData?.some(value => value !== 0)).length,
    sample: entries.slice(0, 5).map(entry => ({
      frameKey: entry.frameKey,
      frameNumber: entry.frameNumber,
      width: entry.width,
      height: entry.height,
      maskLength: entry.maskData?.length || 0,
      nonZero: entry.maskData?.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0) || 0,
    })),
  });
  return entries as StoredSegFrame[];
};

export const deleteSegFrame = async ({
  studyInstanceUID,
  seriesInstanceUID,
  frameKey,
}: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  frameKey: string;
}): Promise<void> => {
  await deleteSharedSegmentationFrame({
    studyInstanceUID,
    seriesInstanceUID,
    model: 'segmentation',
    frameKey,
  });
};

export const deleteSegFrames = async ({
  studyInstanceUID,
  seriesInstanceUID,
}: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
}): Promise<void> => {
  await deleteSharedSegmentationFrames({
    studyInstanceUID,
    seriesInstanceUID,
    model: 'segmentation',
  });
};
