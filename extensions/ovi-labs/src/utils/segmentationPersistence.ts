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

// ─── Batch / beacon helpers ──────────────────────────────────────────────────

interface BatchFrame {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  frameKey: string;
  maskData: Uint8Array;
  width: number;
  height: number;
}

/**
 * Save multiple segmentation frames in a single HTTP request.
 * Converts Uint8Array maskData to plain number arrays for JSON serialisation.
 */
export async function batchSaveSegmentationFrames(frames: BatchFrame[]): Promise<void> {
  const token = localStorage.getItem('token');
  const response = await fetch('/api/segmentation-frames/batch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(
      frames.map(f => ({
        ...f,
        maskData: Array.from(f.maskData),
      }))
    ),
  });
  if (!response.ok) {
    throw new Error(`Batch save failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Best-effort synchronous exit flush using `navigator.sendBeacon`.
 * Returns the result of `sendBeacon` (false if the UA rejected the request).
 * Used in `beforeunload` / `onModeExit` to flush unsaved frames without
 * keeping the page alive.
 */
export function sendBeaconSaveFrames(frames: BatchFrame[]): boolean {
  const payload = JSON.stringify(frames.map(f => ({ ...f, maskData: Array.from(f.maskData) })));
  return navigator.sendBeacon(
    '/api/segmentation-frames/batch',
    new Blob([payload], { type: 'application/json' })
  );
}

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
