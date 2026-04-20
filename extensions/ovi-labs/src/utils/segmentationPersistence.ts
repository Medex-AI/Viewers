import { annotationApi } from '../services/annotationApi';

interface StoredSegmentation {
  seriesInstanceUID: string;
  studyInstanceUID?: string;
  model: string;
  frameKey: string;
  frameNumber?: number;
  width: number;
  height: number;
  maskData: Uint8Array;
  labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }>;
  updatedAt: number;
}

export const saveSegmentationFrame = async (payload: Omit<StoredSegmentation, 'id'>) => {
  if (!payload.studyInstanceUID) {
    throw new Error('studyInstanceUID is required for backend segmentation persistence.');
  }

  await annotationApi.saveSegmentationFrame({
    study_uid: payload.studyInstanceUID,
    series_uid: payload.seriesInstanceUID,
    frame_number: payload.frameNumber ?? 0,
    frame_key: payload.frameKey,
    model_type: payload.model,
    width: payload.width,
    height: payload.height,
    mask_data: payload.maskData,
    label_map: payload.labelMap,
  });
};

export const deleteSegmentationFrame = async ({
  studyInstanceUID,
  seriesInstanceUID,
  model,
  frameKey,
}: {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  model: string;
  frameKey: string;
}) => {
  await annotationApi.deleteSegmentationFrame({
    studyUID: studyInstanceUID,
    seriesUID: seriesInstanceUID,
    modelType: model,
    frameKey,
  });
};

export const loadSegmentationFrames = async (
  seriesInstanceUID: string,
  studyInstanceUID?: string,
  model?: string
) => {
  if (!studyInstanceUID) {
    return [];
  }

  const allEntries = await annotationApi.listSegmentationFrames({
    studyUID: studyInstanceUID,
    seriesUID: seriesInstanceUID,
    modelType: model,
  });

  return allEntries.map(
    entry =>
      ({
        seriesInstanceUID: entry.series_uid,
        studyInstanceUID: entry.study_uid,
        model: entry.model_type,
        frameKey: entry.frame_key,
        frameNumber: entry.frame_number,
        width: entry.width,
        height: entry.height,
        maskData: entry.mask_data,
        labelMap: entry.label_map || {},
        updatedAt: 0,
      }) as StoredSegmentation
  );
};
