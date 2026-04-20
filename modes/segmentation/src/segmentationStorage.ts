import {
  saveSegmentationFrame as saveSharedSegmentationFrame,
  loadSegmentationFrames as loadSharedSegmentationFrames,
  deleteSegmentationFrame as deleteSharedSegmentationFrame,
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
  });
};

export const loadSegFrames = async (
  studyInstanceUID: string,
  seriesInstanceUID: string
): Promise<StoredSegFrame[]> => {
  const entries = await loadSharedSegmentationFrames(
    seriesInstanceUID,
    studyInstanceUID,
    'segmentation'
  );
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
