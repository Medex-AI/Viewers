import { cache, imageLoader } from '@cornerstonejs/core';
import { Enums as toolEnums, segmentation as cstSegmentation } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';
import { saveSegFrame, loadSegFrames, deleteSegFrame, deleteSegFrames } from './segmentationStorage';
import { setSegmentationPersistenceStatus } from '../../../extensions/cornerstone/src/utils/segmentationPersistenceStatus';
import { hexToRgba255, rgbaToHex } from '../../../extensions/ovi-labs/src/utils/colorUtils';
import {
  getPhase,
  destroy as destroyAdapterSegmentation,
  setPhase,
} from '../../../medex/segmentation/src/services/SegmentationPersistenceAdapter';
import {
  bindSegmentationDocument,
  createBoundSegmentationDocument,
  getBoundSegmentationDocument,
  listSegmentationDocuments,
} from '../../../medex/segmentation/src/persistence/segmentationContractClient';
import {
  wasSegmentationDeletedForDisplaySet,
} from '../../../medex/segmentation/src/persistence/deletedSegmentationMarkers';

// ─── Timestamped debug logger ─────────────────────────────────────────────────

const _t0 = performance.now();
export const segLoadLog = (event: string, data?: Record<string, unknown>) => {
  const ms = (performance.now() - _t0).toFixed(1);
  console.log(`[seg-autoload | +${ms}ms] ${event}`, data ?? '');
};

export const snapshotSegState = (segmentationService: any, segmentationId: string) => {
  try {
    const seg = segmentationService?.getSegmentation?.(segmentationId);
    const segments = seg?.segments ?? {};
    const segmentIndices = Object.keys(segments)
      .map(Number)
      .filter(i => segments[i]);
    const labelmapData = seg?.representationData?.[toolEnums.SegmentationRepresentations.Labelmap];
    return {
      phase: getPhase(segmentationId),
      label: seg?.label,
      segmentCount: segmentIndices.length,
      segmentIndices,
      segmentLabels: segmentIndices.map(i => segments[i]?.label ?? null),
      hasLabelmapData: Boolean(labelmapData),
      labelmapImageCount: (labelmapData as any)?.imageIds?.length ?? 0,
    };
  } catch {
    return { phase: getPhase(segmentationId), error: 'snapshot-failed' };
  }
};

export interface AutoCreateState {
  autoCreateDoneDisplaySetUIDs: Set<string>;
  autoCreateInProgressDisplaySetUIDs: Set<string>;
  autoRestoredSegmentationIds: Set<string>;
  restoreInProgressSegmentationIds: Set<string>;
  firstLoadPendingSegmentationIds: Set<string>;
  autosaveArmedSegmentationIds: Set<string>;
  autosaveBlockedUntilBySegmentationId: Map<string, number>;
}

export const makeAutoCreateState = (): AutoCreateState => ({
  autoCreateDoneDisplaySetUIDs: new Set(),
  autoCreateInProgressDisplaySetUIDs: new Set(),
  autoRestoredSegmentationIds: new Set(),
  restoreInProgressSegmentationIds: new Set(),
  firstLoadPendingSegmentationIds: new Set(),
  autosaveArmedSegmentationIds: new Set(),
  autosaveBlockedUntilBySegmentationId: new Map(),
});

const _autoCreateDisplaySetSegmentationIds = new Map<string, string>();

// ─── Status helpers ───────────────────────────────────────────────────────────

export const notifySegmentationPersistenceError = (
  servicesManager: any,
  error: unknown,
  title: string
): void => {
  const uiNotificationService = servicesManager?.services?.uiNotificationService;
  const message =
    error instanceof Error ? error.message : 'Segmentation persistence failed unexpectedly.';

  uiNotificationService?.show?.({
    title,
    message,
    type: 'warning',
  });
};

export const updatePersistenceStatus = (
  servicesManager: any,
  kind: 'loading' | 'synced' | 'dirty' | 'saving' | 'error',
  message: string,
  viewportId?: string
) => {
  const activeViewportId =
    viewportId || servicesManager?.services?.viewportGridService?.getState?.()?.activeViewportId;

  setSegmentationPersistenceStatus(activeViewportId, {
    kind,
    message,
  });
};

export const logSegmentationTimeline = (phase: string, details?: unknown) => {
  void phase;
  void details;
};

const countNonZero = (data?: ArrayLike<number> | null): number => {
  if (!data) return 0;

  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) count++;
  }
  return count;
};

const summarizeSavedFrames = (
  frames: Array<{ frameKey: string; maskData: Uint8Array }>
): Record<string, unknown> => {
  const nonEmptyFrames = frames.filter(frame => countNonZero(frame.maskData) > 0);
  return {
    frameCount: frames.length,
    nonEmptyFrameCount: nonEmptyFrames.length,
    sampleNonEmptyFrames: nonEmptyFrames.slice(0, 5).map(frame => ({
      frameKey: frame.frameKey,
      length: frame.maskData.length,
      nonZero: countNonZero(frame.maskData),
    })),
  };
};

const summarizeLabelmapFrames = (labelmapImageIds: string[]): Record<string, unknown> => {
  const samples = labelmapImageIds.slice(0, 5).map((imageId, index) => {
    let image;
    try {
      image = (cache as any).getImageLoadObject?.(imageId)?.promise
        ? cache.getImage(imageId)
        : undefined;
    } catch {
      image = undefined;
    }
    const scalarData = image?.voxelManager?.getScalarData?.();
    return {
      index,
      imageId,
      cached: Boolean(image),
      length: scalarData?.length || 0,
      nonZero: countNonZero(scalarData),
    };
  });

  return {
    imageCount: labelmapImageIds.length,
    cachedSampleCount: samples.filter(sample => sample.cached).length,
    samples,
  };
};

const summarizeRestoreMatches = (
  referencedImageIds: string[],
  savedByKey: Map<string, { frameKey: string; maskData: Uint8Array }>,
  sliceLength?: number
) => {
  let exactMatchCount = 0;
  let stableMatchCount = 0;
  let sizeMatchCount = 0;
  const sample = referencedImageIds.slice(0, 6).map((referencedImageId, index) => {
    const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
    const exactFrame = savedByKey.get(referencedImageId);
    const stableFrame = savedByKey.get(stableFrameKey);
    const frame = stableFrame || exactFrame;

    if (exactFrame) {
      exactMatchCount += 1;
    }
    if (stableFrame) {
      stableMatchCount += 1;
    }
    if (frame && (!sliceLength || frame.maskData.length === sliceLength)) {
      sizeMatchCount += 1;
    }

    return {
      index,
      referencedImageId,
      stableFrameKey,
      exactMatch: Boolean(exactFrame),
      stableMatch: Boolean(stableFrame),
      maskLength: frame?.maskData.length || 0,
      nonZero: countNonZero(frame?.maskData),
    };
  });

  for (let i = sample.length; i < referencedImageIds.length; i++) {
    const referencedImageId = referencedImageIds[i];
    const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
    const exactFrame = savedByKey.get(referencedImageId);
    const stableFrame = savedByKey.get(stableFrameKey);
    const frame = stableFrame || exactFrame;

    if (exactFrame) {
      exactMatchCount += 1;
    }
    if (stableFrame) {
      stableMatchCount += 1;
    }
    if (frame && (!sliceLength || frame.maskData.length === sliceLength)) {
      sizeMatchCount += 1;
    }
  }

  return {
    referencedImageCount: referencedImageIds.length,
    savedFrameCount: savedByKey.size,
    exactMatchCount,
    stableMatchCount,
    sizeMatchCount,
    sample,
  };
};

const viewportHasSegmentationRepresentation = (
  segmentationService: any,
  viewportId: string,
  segmentationId: string
): boolean => {
  const viewportRepresentations =
    segmentationService.getSegmentationRepresentations?.(viewportId) ?? [];
  return viewportRepresentations.some(rep => rep.segmentationId === segmentationId);
};

const addSegmentationRepresentationAndConfirm = async (
  segmentationService: any,
  viewportId: string,
  segmentationId: string
): Promise<boolean> => {
  segLoadLog('addSegRepresentation:START', { viewportId, segmentationId });
  await segmentationService.addSegmentationRepresentation(viewportId, {
    segmentationId,
    type: toolEnums.SegmentationRepresentations.Labelmap,
  });
  segLoadLog('addSegRepresentation:addRepresentation-returned', { viewportId, segmentationId });

  // For dynamic volumes the state update happens asynchronously after the
  // addSegmentationRepresentation call returns. Poll briefly before giving up.
  for (let i = 0; i < 20; i++) {
    const confirmed = viewportHasSegmentationRepresentation(
      segmentationService,
      viewportId,
      segmentationId
    );
    segLoadLog('addSegRepresentation:poll', { viewportId, segmentationId, attempt: i, confirmed });
    if (confirmed) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  segLoadLog('addSegRepresentation:unconfirmed-continuing', { viewportId, segmentationId });
  // Dynamic volume labelmaps can be attached through the volume-viewport path
  // without appearing in getSegmentationRepresentations(viewportId). The
  // representation poll is diagnostic only; restoration can safely proceed
  // once addSegmentationRepresentation has returned and the labelmap volume
  // has been registered in Cornerstone state.
  return true;
};

const forceRenderViewportAfterSegmentationRepresentation = (
  servicesManager: any,
  viewportId: string,
  reason: string
): void => {
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;

  try {
    const renderingEngine = cornerstoneViewportService?.getRenderingEngine?.();
    if (renderingEngine?.renderViewport) {
      renderingEngine.renderViewport(viewportId);
    } else {
      cornerstoneViewportService?.getCornerstoneViewport?.(viewportId)?.render?.();
    }

    logSegmentationTimeline('viewportVolumesChanged:forced-render', {
      viewportId,
      reason,
    });
  } catch (err) {
    logSegmentationTimeline('viewportVolumesChanged:forced-render-failed', {
      viewportId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ─── Frame key utilities ──────────────────────────────────────────────────────

export const getFrameNumberFromImageId = (imageId?: string): number => {
  if (!imageId) {
    return 1;
  }

  const framePathMatch = imageId.match(/\/frames\/(\d+)(?:[/?#]|$)/i);
  if (framePathMatch) {
    return Number.parseInt(framePathMatch[1], 10);
  }

  const frameQueryMatch = imageId.match(/[?&]frame(?:Number)?=(\d+)(?:[&#]|$)/i);
  if (frameQueryMatch) {
    return Number.parseInt(frameQueryMatch[1], 10);
  }

  const instance = DicomMetadataStore.getInstanceByImageId(imageId);
  const instanceFrameNumber = Number(instance?.frameNumber ?? instance?.FrameNumber);
  return Number.isFinite(instanceFrameNumber) && instanceFrameNumber > 0 ? instanceFrameNumber : 1;
};

export const getStableFrameKey = (referencedImageId?: string): string | null => {
  if (!referencedImageId) {
    return null;
  }

  const instance = DicomMetadataStore.getInstanceByImageId(referencedImageId);
  const studyInstanceUID = instance?.StudyInstanceUID;
  const seriesInstanceUID = instance?.SeriesInstanceUID;
  const sopInstanceUID = instance?.SOPInstanceUID;
  const frameNumber = getFrameNumberFromImageId(referencedImageId);

  if (studyInstanceUID && seriesInstanceUID && sopInstanceUID) {
    return `wadors:/dicom-web/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frameNumber}`;
  }

  return referencedImageId;
};

export const getSanitizedLabelmapFrames = (
  labelmapData?: { imageIds?: string[]; referencedImageIds?: string[] } | undefined
): { imageIds: string[]; referencedImageIds: string[] } => {
  const imageIds = labelmapData?.imageIds ?? [];
  const referencedImageIds = labelmapData?.referencedImageIds ?? [];
  const sanitized = imageIds.reduce(
    (acc, imageId, index) => {
      const referencedImageId = referencedImageIds[index];
      if (imageId && referencedImageId) {
        acc.imageIds.push(imageId);
        acc.referencedImageIds.push(referencedImageId);
      }
      return acc;
    },
    { imageIds: [] as string[], referencedImageIds: [] as string[] }
  );

  if (
    labelmapData &&
    (sanitized.imageIds.length !== imageIds.length ||
      sanitized.referencedImageIds.length !== referencedImageIds.length)
  ) {
    // Keep the underlying representation aligned so downstream rendering never sees
    // sparse/undefined labelmap imageIds.
    labelmapData.imageIds = sanitized.imageIds;
    labelmapData.referencedImageIds = sanitized.referencedImageIds;
  }

  return sanitized;
};

// ─── Label map builders ───────────────────────────────────────────────────────

export const buildPersistedLabelMap = (segmentationId: string, servicesManager: any) => {
  const { segmentationService, viewportGridService } = servicesManager.services;
  const segState = segmentationService.getSegmentation(segmentationId);
  const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;

  return Object.fromEntries(
    Object.entries(segState?.segments || {})
      .filter(([, segment]: [string, any]) => Boolean(segment))
      .map(([segmentIndex, segment]: [string, any]) => [
        Number(segmentIndex),
        {
          labelId: String(segmentIndex),
          labelName: segment?.label || `Label ${segmentIndex}`,
          labelColor: rgbaToHex(
            activeViewportId
              ? segmentationService.getSegmentColor?.(
                  activeViewportId,
                  segmentationId,
                  Number(segmentIndex)
                )
              : null
          ),
          labelLocked: Boolean(segment?.locked),
        },
      ])
  );
};

export const buildLabelMapFromSegmentationDocument = (
  document?: { labels?: Record<string, { name: string; color?: string; locked?: boolean }> }
) => {
  const labelMap: Record<
    number,
    { labelId: string; labelName: string; labelColor: string; labelLocked?: boolean }
  > = {};

  if (!document?.labels) {
    return labelMap;
  }

  for (const [segmentIndex, label] of Object.entries(document.labels)) {
    labelMap[Number(segmentIndex)] = {
      labelId: String(segmentIndex),
      labelName: label.name,
      labelColor: label.color || '#FFFFFF',
      labelLocked: Boolean(label.locked),
    };
  }

  return labelMap;
};

export const sanitizeMaskDataForPersistedLabels = (
  data: ArrayLike<number>,
  labelMap: Record<number, unknown>
): Uint8Array => {
  const allowedSegmentIndices = new Set(Object.keys(labelMap).map(Number));
  const result = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    result[i] = allowedSegmentIndices.has(value) ? value : 0;
  }

  return result;
};

export const applySavedFramesToLabelmapVolume = (
  restoreVolume: any,
  savedByKey: Map<string, { maskData: Uint8Array }>,
  segmentationId: string,
  logPrefix: string
): number[] => {
  void segmentationId;
  void logPrefix;
  const modifiedIndices: number[] = [];
  let volumeScalarData: Uint8Array | undefined;
  try {
    volumeScalarData = restoreVolume?.voxelManager?.getScalarData?.() as Uint8Array | undefined;
  } catch {
    // best-effort fallback to per-image writes below
  }

  for (let i = 0; i < (restoreVolume?.imageIds?.length || 0); i++) {
    const labelmapImage = cache.getImage(restoreVolume.imageIds[i]);
    if (!labelmapImage) continue;

    const referencedImageId = (labelmapImage as any).referencedImageId;
    if (!referencedImageId) continue;

    const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
    const frame = savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
    if (!frame) continue;

    const sliceScalarData = labelmapImage?.voxelManager?.getScalarData?.();
    if (!sliceScalarData || sliceScalarData.length !== frame.maskData.length) continue;

    sliceScalarData.set(frame.maskData);

    if (volumeScalarData) {
      const offset = i * frame.maskData.length;
      if (offset + frame.maskData.length <= volumeScalarData.length) {
        volumeScalarData.set(frame.maskData, offset);
      }
    }

    modifiedIndices.push(i);
  }

  return modifiedIndices;
};

// ─── Save / restore ───────────────────────────────────────────────────────────

export type SaveScope = 'current-timepoint' | 'all-timepoints';

export type SaveOptions = {
  deleteEmptyFrames?: boolean;
  writeEmptyPlaceholder?: boolean;
  modifiedSlicesToUse?: number[];
};

const BACKEND_SEGMENTATION_LOAD_TIMEOUT_MS = 8000;

const loadSegFramesWithTimeout = async (
  studyInstanceUID: string,
  seriesInstanceUID: string
): Promise<Awaited<ReturnType<typeof loadSegFrames>>> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      loadSegFrames(studyInstanceUID, seriesInstanceUID),
      new Promise<Awaited<ReturnType<typeof loadSegFrames>>>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `Timed out checking saved segmentation after ${BACKEND_SEGMENTATION_LOAD_TIMEOUT_MS} ms`
            )
          );
        }, BACKEND_SEGMENTATION_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const getLabelmapVolumeFromData = (
  labelmapData?: { volumeId?: string } | undefined
): any | null => {
  const volumeId = labelmapData?.volumeId;
  return volumeId ? cache.getVolume(volumeId) : null;
};

const getVolumeScalarData = (volume: any): Uint8Array | null => {
  try {
    return volume?.voxelManager?.getScalarData?.() || null;
  } catch {
    return null;
  }
};

const getVolumeFrameGeometry = (volume: any) => {
  const dimensions = volume?.dimensions || volume?.imageData?.getDimensions?.();
  const width = dimensions?.[0] || 0;
  const height = dimensions?.[1] || 0;
  const numberOfSlices = dimensions?.[2] || 0;
  const sliceLength = width * height;

  return { width, height, numberOfSlices, sliceLength };
};

const countNonZeroPixels = (data: ArrayLike<number>): number => {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) {
      count += 1;
    }
  }
  return count;
};

const getVolumeSliceIndexForReferencedImageId = (
  volume: any,
  referencedImageId: string,
  fallbackIndex: number
): number => {
  const targetFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
  const volumeReferencedImageIds = volume?.referencedImageIds ?? [];
  const referencedIndex = volumeReferencedImageIds.findIndex(
    imageId => (getStableFrameKey(imageId) || imageId) === targetFrameKey
  );
  if (referencedIndex >= 0) {
    return referencedIndex;
  }

  const volumeImageIds = volume?.imageIds ?? [];
  for (let i = 0; i < volumeImageIds.length; i++) {
    const labelmapImage = cache.getImage(volumeImageIds[i]);
    const labelmapReferencedImageId = (labelmapImage as any)?.referencedImageId;
    if (
      labelmapReferencedImageId &&
      (getStableFrameKey(labelmapReferencedImageId) || labelmapReferencedImageId) === targetFrameKey
    ) {
      return i;
    }
  }

  return fallbackIndex;
};

const getVolumeSliceScalarData = (volume: any, sliceIndex: number): Uint8Array | null => {
  const imageId = volume?.imageIds?.[sliceIndex];
  if (!imageId) {
    return null;
  }

  try {
    return (
      (cache.getImage(imageId)?.voxelManager?.getScalarData?.() as Uint8Array | undefined) || null
    );
  } catch {
    return null;
  }
};

const writeVolumeSliceScalarData = (
  volume: any,
  sliceIndex: number,
  frameData: Uint8Array,
  volumeScalarData?: Uint8Array | null,
  sliceLength?: number
): void => {
  const sliceScalarData = getVolumeSliceScalarData(volume, sliceIndex);
  if (sliceScalarData && sliceScalarData.length === frameData.length) {
    sliceScalarData.set(frameData);
  }

  if (volumeScalarData && sliceLength) {
    const offset = sliceIndex * sliceLength;
    if (offset + frameData.length <= volumeScalarData.length) {
      volumeScalarData.set(frameData, offset);
    }
  }
};

/**
 * Return the study/series UIDs for a currently live segmentation.
 * Returns null if the segmentation or its labelmap metadata is unavailable.
 */
export const getSegStudySeries = (
  segmentationId: string,
  servicesManager: any
): { studyInstanceUID: string; seriesInstanceUID: string; displaySetInstanceUID?: string } | null => {
  const { segmentationService } = servicesManager.services;
  const segState = segmentationService.getSegmentation(segmentationId);
  if (!segState) return null;
  const labelmapData = segState.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { referencedImageIds?: string[] } | undefined;
  const refImageId = labelmapData?.referencedImageIds?.[0];
  if (!refImageId) return null;
  const instance = DicomMetadataStore.getInstanceByImageId(refImageId);
  if (!instance?.StudyInstanceUID || !instance?.SeriesInstanceUID) return null;
  return {
    studyInstanceUID: instance.StudyInstanceUID,
    seriesInstanceUID: instance.SeriesInstanceUID,
    displaySetInstanceUID: segState.displaySetInstanceUID,
  };
};

/**
 * Load all stored frames for a series from the backend and delete each one.
 * Used when the whole segmentation has been removed from the viewer.
 */
export const deleteAllSegFrames = async (
  studyInstanceUID: string,
  seriesInstanceUID: string
): Promise<void> => {
  try {
    await deleteSegFrames({ studyInstanceUID, seriesInstanceUID });
  } catch (error) {
    console.warn('[segmentation-mode] bulk segmentation frame delete failed', error);
  }

  let frames: Awaited<ReturnType<typeof loadSegFrames>> = [];
  try {
    frames = await loadSegFrames(studyInstanceUID, seriesInstanceUID);
  } catch (error) {
    console.warn('[segmentation-mode] failed to enumerate segmentation frames for cleanup', error);
    return;
  }

  for (const frame of frames) {
    try {
      await deleteSegFrame({ studyInstanceUID, seriesInstanceUID, frameKey: frame.frameKey });
    } catch (error) {
      console.warn('[segmentation-mode] failed to delete segmentation frame during cleanup', {
        frameKey: frame.frameKey,
        error,
      });
    }
  }
};

/** Read labelmap frames for a segmentation and save them to the backend. */
export const saveAllFrames = async (
  segmentationId: string,
  servicesManager: any,
  saveScope: SaveScope = 'all-timepoints',
  options: SaveOptions = {}
): Promise<void> => {
  const { segmentationService } = servicesManager.services;
  const deleteEmptyFrames = options.deleteEmptyFrames ?? true;
  const writeEmptyPlaceholder = options.writeEmptyPlaceholder ?? true;
  const modifiedSlicesToUse =
    saveScope === 'current-timepoint'
      ? options.modifiedSlicesToUse?.filter(Number.isInteger)
      : undefined;
  const segState = segmentationService.getSegmentation(segmentationId);
  if (!segState) {
    console.warn('[segmentation-load-debug] restoreFrames:no-segmentation-state', {
      segmentationId,
    });
    return;
  }

  const labelmapData = segState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { imageIds?: string[]; referencedImageIds?: string[]; volumeId?: string } | undefined;

  const { imageIds: labelmapImageIds, referencedImageIds } =
    getSanitizedLabelmapFrames(labelmapData);
  if (!labelmapImageIds.length || !referencedImageIds.length) {
    console.warn('[segmentation-load-debug] restoreFrames:no-labelmap-frames', {
      segmentationId,
      labelmapImageCount: labelmapImageIds.length,
      referencedImageCount: referencedImageIds.length,
    });
    return;
  }

  const instance = DicomMetadataStore.getInstanceByImageId(referencedImageIds[0]);
  const seriesInstanceUID = instance?.SeriesInstanceUID;
  const studyInstanceUID = instance?.StudyInstanceUID;
  if (!seriesInstanceUID || !studyInstanceUID) return;

  logSegmentationTimeline('saveAllFrames:start', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    hasDynamicSegmentation: segmentationService.hasDynamicSegmentation?.(segmentationId) || false,
    saveScope,
    deleteEmptyFrames,
    writeEmptyPlaceholder,
    modifiedSlicesToUse,
  });
  updatePersistenceStatus(servicesManager, 'saving', 'Saving segmentation changes to backend...');

  const labelMap = buildPersistedLabelMap(segmentationId, servicesManager);
  const segmentationLabel = segState.label;
  const segmentCount = Object.keys(labelMap).length;
  let wroteAnyFrame = false;

  if (!getBoundSegmentationDocument(segmentationId) && segmentCount > 0) {
    await createBoundSegmentationDocument({
      localSegmentationId: segmentationId,
      studyInstanceUID,
      seriesInstanceUID,
      displaySetInstanceUID: segState?.cachedStats?.displaySetInstanceUID,
      label: segmentationLabel || 'Segmentation',
      labels: Object.fromEntries(
        Object.entries(labelMap).map(([segmentIndex, label]: [string, any]) => [
          Number(segmentIndex),
          {
            name: label?.labelName,
            color: label?.labelColor,
            locked: label?.labelLocked,
          },
        ])
      ),
    }).catch(error => {
      console.warn('Failed to create bound segmentation document during saveAllFrames:', error);
    });
  }

  const hasDynamicSegmentation =
    segmentationService.hasDynamicSegmentation?.(segmentationId) || false;
  const labelmapVolume = getLabelmapVolumeFromData(labelmapData);

  if (hasDynamicSegmentation) {
    const getSnapshots =
      saveScope === 'current-timepoint'
        ? segmentationService.getDynamicSegmentationCurrentTimePointFrameSnapshots
        : segmentationService.getDynamicSegmentationFrameSnapshots;

    const snapshots = getSnapshots
      ? await getSnapshots.call(segmentationService, segmentationId)
      : [];

    logSegmentationTimeline('saveAllFrames:dynamic-snapshots', {
      segmentationId,
      snapshotCount: snapshots.length,
      saveScope,
    });

    for (const snapshot of snapshots) {
      const stableFrameKey =
        getStableFrameKey(snapshot.referencedImageId) || snapshot.referencedImageId;
        const frameData = sanitizeMaskDataForPersistedLabels(snapshot.maskData, labelMap);
        const hasData = frameData.some((v: number) => v !== 0);

      if (!hasData) {
        logSegmentationTimeline(
          deleteEmptyFrames
            ? 'saveAllFrames:delete-empty-frame'
            : 'saveAllFrames:skip-empty-frame-delete',
          {
            segmentationId,
            frameKey: stableFrameKey,
            saveScope,
          }
        );
        if (!deleteEmptyFrames) {
          continue;
        }
        await deleteSegFrame({
          studyInstanceUID,
          seriesInstanceUID,
          frameKey: stableFrameKey,
        });
        continue;
      }

      await saveSegFrame({
        studyInstanceUID,
        seriesInstanceUID,
        frameKey: stableFrameKey,
        frameNumber: snapshot.frameNumber,
        width: snapshot.width,
        height: snapshot.height,
        maskData: frameData,
        labelMap,
        segmentationLabel,
      });
      wroteAnyFrame = true;
    }
  } else if (labelmapVolume) {
    const volumeScalarData = getVolumeScalarData(labelmapVolume);
    const { width, height, numberOfSlices, sliceLength } = getVolumeFrameGeometry(labelmapVolume);
    const candidateIndices = modifiedSlicesToUse?.length
      ? modifiedSlicesToUse
      : Array.from({ length: Math.min(numberOfSlices, referencedImageIds.length) }, (_, i) => i);

    if (volumeScalarData && width && height && sliceLength) {
      for (const i of candidateIndices) {
        if (i < 0 || i >= referencedImageIds.length) continue;

        const referencedImageId = referencedImageIds[i];
        if (!referencedImageId) continue;

        const volumeSliceIndex = getVolumeSliceIndexForReferencedImageId(
          labelmapVolume,
          referencedImageId,
          i
        );
        if (volumeSliceIndex < 0 || volumeSliceIndex >= numberOfSlices) continue;

        const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
        const offset = volumeSliceIndex * sliceLength;
        const sliceScalarData = getVolumeSliceScalarData(labelmapVolume, volumeSliceIndex);
        const frameData =
          sliceScalarData && sliceScalarData.length === sliceLength
            ? new Uint8Array(sliceScalarData)
            : volumeScalarData.slice(offset, offset + sliceLength);
        const sanitizedFrameData = sanitizeMaskDataForPersistedLabels(frameData, labelMap);
        const nonZeroCount = countNonZeroPixels(sanitizedFrameData);
        const hasData = nonZeroCount > 0;

        if (!hasData) {
          logSegmentationTimeline('saveAllFrames:skip-empty-volume-frame', {
            segmentationId,
            displayFrameIndex: i,
            volumeSliceIndex,
            frameKey: stableFrameKey,
            saveScope,
          });
          if (!deleteEmptyFrames) {
            continue;
          }
          await deleteSegFrame({
            studyInstanceUID,
            seriesInstanceUID,
            frameKey: stableFrameKey,
          });
          continue;
        }

        await saveSegFrame({
          studyInstanceUID,
          seriesInstanceUID,
          frameKey: stableFrameKey,
          frameNumber: getFrameNumberFromImageId(referencedImageId),
          width,
          height,
          maskData: sanitizedFrameData,
          labelMap,
          segmentationLabel,
        });
        logSegmentationTimeline('saveAllFrames:saved-volume-frame', {
          segmentationId,
          displayFrameIndex: i,
          volumeSliceIndex,
          frameKey: stableFrameKey,
          frameNumber: getFrameNumberFromImageId(referencedImageId),
          width,
          height,
          nonZeroCount,
          saveScope,
        });
        wroteAnyFrame = true;
      }
    }
  } else {
    for (let i = 0; i < labelmapImageIds.length; i++) {
      const referencedImageId = referencedImageIds[i];
      if (!referencedImageId) continue;
      const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;

      const labelmapImage = cache.getImage(labelmapImageIds[i]);
      if (!labelmapImage) continue;

      const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
      if (!scalarData) continue;

      const frameData = sanitizeMaskDataForPersistedLabels(scalarData, labelMap);
      const hasData = frameData.some((v: number) => v !== 0);
      if (!hasData) {
        logSegmentationTimeline(
          deleteEmptyFrames
            ? 'saveAllFrames:delete-empty-frame'
            : 'saveAllFrames:skip-empty-frame-delete',
          {
            segmentationId,
            frameIndex: i,
            frameKey: stableFrameKey,
            saveScope,
          }
        );
        if (!deleteEmptyFrames) {
          continue;
        }
        await deleteSegFrame({
          studyInstanceUID,
          seriesInstanceUID,
          frameKey: stableFrameKey,
        });
        continue;
      }

      const width: number = labelmapImage.columns ?? labelmapImage.width;
      const height: number = labelmapImage.rows ?? labelmapImage.height;
      if (!width || !height) continue;

      await saveSegFrame({
        studyInstanceUID,
        seriesInstanceUID,
        frameKey: stableFrameKey,
        frameNumber: getFrameNumberFromImageId(referencedImageId),
        width,
        height,
        maskData: frameData,
        labelMap,
        segmentationLabel,
      });
      wroteAnyFrame = true;
    }
  }

  if (!wroteAnyFrame && segmentCount > 0 && referencedImageIds[0] && writeEmptyPlaceholder) {
    const placeholderImageId = labelmapImageIds[0];
    const placeholderImage = placeholderImageId ? cache.getImage(placeholderImageId) : null;
    const width: number = placeholderImage?.columns ?? placeholderImage?.width ?? 0;
    const height: number = placeholderImage?.rows ?? placeholderImage?.height ?? 0;
    const frameNumber = getFrameNumberFromImageId(referencedImageIds[0]);
    const frameKey = getStableFrameKey(referencedImageIds[0]) || referencedImageIds[0];

    if (width && height && frameKey) {
      await saveSegFrame({
        studyInstanceUID,
        seriesInstanceUID,
        frameKey,
        frameNumber,
        width,
        height,
        maskData: new Uint8Array(width * height),
        labelMap,
        segmentationLabel,
      });
    }
  }

  logSegmentationTimeline('saveAllFrames:done', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    saveScope,
    deleteEmptyFrames,
    writeEmptyPlaceholder,
    wroteAnyFrame,
  });
  updatePersistenceStatus(
    servicesManager,
    'synced',
    !wroteAnyFrame && !deleteEmptyFrames
      ? 'No non-empty segmentation frames to autosave. Existing backend masks were preserved.'
      : 'Segmentation changes saved to backend.'
  );
};

export const getManualSaveSegmentationId = (servicesManager: any): string | null => {
  const { segmentationService, viewportGridService } = servicesManager.services;
  const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;

  if (activeViewportId) {
    const activeSegmentation = segmentationService.getActiveSegmentation?.(activeViewportId);
    if (activeSegmentation?.segmentationId) {
      return activeSegmentation.segmentationId;
    }
  }

  const segmentations = segmentationService.getSegmentations?.() ?? [];
  return segmentations[0]?.segmentationId ?? null;
};

/** Restore previously saved frames into a freshly created segmentation's labelmap. */
export const restoreFrames = async (
  segmentationId: string,
  servicesManager: any,
  signal?: AbortSignal
): Promise<void> => {
  const { segmentationService } = servicesManager.services;
  segLoadLog('restoreFrames:ENTER', {
    segmentationId,
    ...snapshotSegState(segmentationService, segmentationId),
    caller: new Error().stack?.split('\n')[2]?.trim(),
  });
  logSegmentationTimeline('restoreFrames:start', {
    segmentationId,
    hasDynamicSegmentation: segmentationService.hasDynamicSegmentation?.(segmentationId) || false,
  });
  updatePersistenceStatus(servicesManager, 'loading', 'Loading saved segmentation from backend...');

  // Give createLabelmapForDisplaySet a tick to fully register images
  await new Promise(resolve => setTimeout(resolve, 0));

  const segState = segmentationService.getSegmentation(segmentationId);
  if (!segState) return;

  const labelmapData = segState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

  const { imageIds: labelmapImageIds, referencedImageIds } =
    getSanitizedLabelmapFrames(labelmapData);
  if (!labelmapImageIds.length || !referencedImageIds.length) return;

  const instance = DicomMetadataStore.getInstanceByImageId(referencedImageIds[0]);
  const seriesInstanceUID = instance?.SeriesInstanceUID;
  const studyInstanceUID = instance?.StudyInstanceUID;
  if (!seriesInstanceUID || !studyInstanceUID) {
    console.warn('[segmentation-load-debug] restoreFrames:no-study-series', {
      segmentationId,
      firstReferencedImageId: referencedImageIds[0],
      studyInstanceUID,
      seriesInstanceUID,
    });
    return;
  }

  segLoadLog('restoreFrames:backend-fetch-start', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    labelmapImageCount: labelmapImageIds.length,
    referencedImageCount: referencedImageIds.length,
    phase: getPhase(segmentationId),
  });
  console.warn('[segmentation-load-debug] restoreFrames:load-start', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    labelmapImageCount: labelmapImageIds.length,
    referencedImageCount: referencedImageIds.length,
  });
  const saved = await loadSegFramesWithTimeout(studyInstanceUID, seriesInstanceUID);
  segLoadLog('restoreFrames:backend-fetch-done', {
    segmentationId,
    phase: getPhase(segmentationId),
    ...summarizeSavedFrames(saved),
    labelMapSample: saved.slice(0, 3).map(f => ({
      frameKey: f.frameKey,
      labelMapKeys: Object.keys(f.labelMap ?? {}),
      segmentationLabel: f.segmentationLabel,
    })),
  });
  console.warn('[segmentation-load-debug] restoreFrames:load-done', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    ...summarizeSavedFrames(saved),
  });
  logSegmentationTimeline('restoreFrames:loaded-backend-frames', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    savedCount: saved.length,
  });

  // Collect the merged label map across all saved frames
  const mergedLabelMap: Record<
    number,
    { labelId: string; labelName: string; labelColor: string; labelLocked?: boolean }
  > = {};
  const persistedSegmentationLabel =
    saved.find(frame => frame.segmentationLabel?.trim())?.segmentationLabel || undefined;
  for (const frame of saved) {
    if (frame.labelMap) {
      Object.assign(mergedLabelMap, frame.labelMap);
    }
  }

  if (persistedSegmentationLabel) {
    segmentationService.addOrUpdateSegmentation({
      segmentationId,
      label: persistedSegmentationLabel,
    });
  }

  segLoadLog('restoreFrames:merged-label-map', {
    segmentationId,
    phase: getPhase(segmentationId),
    mergedLabelMapKeys: Object.keys(mergedLabelMap),
    persistedSegmentationLabel,
    savedCount: saved.length,
  });

  // Add segments matching the stored label map (zero segments if no data)
  // Guard: if the restore was aborted (e.g., user deleted segments while backend fetch was
  // in-flight), do not inject stale segment metadata back into the in-memory state.
  if (signal?.aborted) {
    logSegmentationTimeline('restoreFrames:aborted-before-segment-add', { segmentationId });
    return;
  }
  const sortedSegmentIndices = Object.keys(mergedLabelMap)
    .map(Number)
    .sort((a, b) => a - b);
  for (const segIndex of sortedSegmentIndices) {
    const entry = mergedLabelMap[segIndex];
    try {
      segmentationService.addSegment(segmentationId, {
        segmentIndex: segIndex,
        label: entry.labelName,
        color: hexToRgba255(entry.labelColor || '#FFFFFF'),
        isLocked: Boolean(entry.labelLocked),
        active: segIndex === sortedSegmentIndices[0],
      });
    } catch {
      // best-effort metadata restore
    }
  }

  if (!saved.length) {
    console.warn('[segmentation-load-debug] restoreFrames:no-saved-frames', {
      segmentationId,
      studyInstanceUID,
      seriesInstanceUID,
    });
    return;
  }

  const savedByKey = new Map(saved.map(f => [f.frameKey, f]));
  const modifiedIndices: number[] = [];
  const restoredTimePoints = segmentationService.restoreDynamicSegmentationTimePointBuffers?.(
    segmentationId,
    referencedImageIds,
    savedByKey
  );

  if (segmentationService.hasDynamicSegmentation?.(segmentationId)) {
    console.warn('[segmentation-load-debug] restoreFrames:dynamic-restore-result', {
      segmentationId,
      restoredTimePoints,
      ...summarizeRestoreMatches(referencedImageIds, savedByKey),
    });
    if (restoredTimePoints?.length) {
      logSegmentationTimeline('restoreFrames:restored-dynamic', {
        segmentationId,
        restoredTimePoints,
        savedCount: saved.length,
      });
      cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId);
      updatePersistenceStatus(
        servicesManager,
        'synced',
        `Loaded saved segmentation for ${restoredTimePoints.length} timepoint${
          restoredTimePoints.length === 1 ? '' : 's'
        }.`
      );
    } else {
      logSegmentationTimeline('restoreFrames:no-dynamic-pixels-restored', {
        segmentationId,
        savedCount: saved.length,
      });
      updatePersistenceStatus(
        servicesManager,
        'synced',
        'Checked backend state. No saved segmentation was loaded for this timepoint.'
      );
    }
    return;
  }

  // Prefer writing into the labelmap volume's own images (the ones the renderer reads).
  const csSeg2 = cstSegmentation.state.getSegmentation(segmentationId);
  const restoreVolumeId = (csSeg2?.representationData?.Labelmap as any)?.volumeId;
  const restoreVolume = restoreVolumeId ? cache.getVolume(restoreVolumeId) : null;

  if (restoreVolume) {
    const volumeScalarData = getVolumeScalarData(restoreVolume);
    const { numberOfSlices, sliceLength } = getVolumeFrameGeometry(restoreVolume);
    console.warn('[segmentation-load-debug] restoreFrames:static-volume-target', {
      segmentationId,
      restoreVolumeId,
      numberOfSlices,
      sliceLength,
      hasVolumeScalarData: Boolean(volumeScalarData),
      ...summarizeRestoreMatches(referencedImageIds, savedByKey, sliceLength),
    });

    if (volumeScalarData && sliceLength) {
      for (let i = 0; i < referencedImageIds.length; i++) {
        const referencedImageId = referencedImageIds[i];
        if (!referencedImageId) continue;

        const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
        const frame = savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
        if (!frame || frame.maskData.length !== sliceLength) continue;

        const volumeSliceIndex = getVolumeSliceIndexForReferencedImageId(
          restoreVolume,
          referencedImageId,
          i
        );
        if (volumeSliceIndex < 0 || volumeSliceIndex >= numberOfSlices) continue;

        writeVolumeSliceScalarData(
          restoreVolume,
          volumeSliceIndex,
          frame.maskData,
          volumeScalarData,
          sliceLength
        );
        modifiedIndices.push(volumeSliceIndex);
      }

      restoreVolume.imageData?.modified?.();
      restoreVolume.invalidate?.();
    } else {
      modifiedIndices.push(
        ...applySavedFramesToLabelmapVolume(
          restoreVolume,
          savedByKey,
          segmentationId,
          'restoreFrames'
        )
      );
    }
  } else {
    console.warn('[segmentation-load-debug] restoreFrames:stack-image-target', {
      segmentationId,
      labelmapImageCount: labelmapImageIds.length,
      ...summarizeRestoreMatches(referencedImageIds, savedByKey),
    });
    // Fallback: per-frame derived images (stack viewport, or pre-representation timing).
    for (let i = 0; i < labelmapImageIds.length; i++) {
      const referencedImageId = referencedImageIds[i];
      if (!referencedImageId) continue;
      const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
      const frame = savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
      if (!frame) continue;
      const labelmapImage =
        cache.getImage(labelmapImageIds[i]) ||
        (await imageLoader.loadAndCacheImage(labelmapImageIds[i]));
      const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
      if (!scalarData || scalarData.length !== frame.maskData.length) continue;
      scalarData.set(frame.maskData);
      modifiedIndices.push(i);
    }
  }

  if (modifiedIndices.length) {
    console.warn('[segmentation-load-debug] restoreFrames:restored-static', {
      segmentationId,
      modifiedIndices,
      savedCount: saved.length,
    });
    logSegmentationTimeline('restoreFrames:restored-static', {
      segmentationId,
      modifiedIndices,
      savedCount: saved.length,
    });
    // Do NOT pass modifiedIndices — see earlier comment about dynamic volume bounds.
    cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId);
    updatePersistenceStatus(
      servicesManager,
      'synced',
      `Loaded ${modifiedIndices.length} saved segmentation frame${
        modifiedIndices.length === 1 ? '' : 's'
      } from backend.`
    );
  } else {
    console.warn('[segmentation-load-debug] restoreFrames:no-static-pixels-restored', {
      segmentationId,
      savedCount: saved.length,
      ...summarizeRestoreMatches(referencedImageIds, savedByKey),
    });
    logSegmentationTimeline('restoreFrames:no-static-pixels-restored', {
      segmentationId,
      savedCount: saved.length,
    });
    updatePersistenceStatus(
      servicesManager,
      'synced',
      'Checked backend state. No saved segmentation was loaded.'
    );
  }

  segLoadLog('restoreFrames:EXIT', {
    segmentationId,
    ...snapshotSegState(servicesManager.services.segmentationService, segmentationId),
    modifiedIndices,
    savedCount: saved.length,
  });
};

// ─── Auto-create / restore controller ────────────────────────────────────────

export const getDisplaySetReferenceImageIds = (displaySet: any): string[] => {
  if (displaySet?.isDynamicVolume) {
    const timePoints = displaySet.dynamicVolumeInfo?.timePoints;
    if (timePoints?.length) {
      return timePoints.flat();
    }
  }
  return displaySet?.imageIds ?? [];
};

export const findExistingSegmentationForDisplaySet = (
  displaySet: any,
  segmentationService: any,
  viewportId?: string
): string | undefined => {
  const displaySetReferenceImageIds = getDisplaySetReferenceImageIds(displaySet);
  if (!displaySetReferenceImageIds.length) return;

  const displaySetFrameKeys = new Set(
    displaySetReferenceImageIds.map(imageId => getStableFrameKey(imageId) || imageId)
  );

  const segmentationMatchesDisplaySet = (existingSeg: any) => {
    const labelmapData = existingSeg?.representationData?.[
      toolEnums.SegmentationRepresentations.Labelmap
    ] as { referencedImageIds?: string[] } | undefined;
    const referencedImageIds = labelmapData?.referencedImageIds ?? [];
    if (referencedImageIds.length !== displaySetReferenceImageIds.length) {
      return false;
    }

    return referencedImageIds.every(id => displaySetFrameKeys.has(getStableFrameKey(id) || id));
  };

  const activeSegmentation = viewportId
    ? segmentationService.getActiveSegmentation?.(viewportId)
    : null;
  if (activeSegmentation && segmentationMatchesDisplaySet(activeSegmentation)) {
    return activeSegmentation.segmentationId;
  }

  const segmentations = segmentationService.getSegmentations?.() ?? [];
  for (const existingSeg of segmentations) {
    if (segmentationMatchesDisplaySet(existingSeg)) return existingSeg.segmentationId;
  }
};

export const tryAutoCreateSegmentationFromBackend = async (
  viewportId: string,
  servicesManager: any,
  state?: AutoCreateState
): Promise<void> => {
  if (!viewportId) return;

  segLoadLog('autoCreate:ENTER', { viewportId });

  const {
    segmentationService,
    displaySetService,
    viewportGridService,
    cornerstoneViewportService,
  } = servicesManager.services;

  const { viewports } = viewportGridService.getState();
  const viewport = viewports?.get(viewportId);
  if (!viewport?.displaySetInstanceUIDs?.length) {
    segLoadLog('autoCreate:SKIP-no-display-set-uids', { viewportId });
    return;
  }

  const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];
  const viewportRepresentations =
    segmentationService.getSegmentationRepresentations?.(viewportId) ?? [];
  if (viewportRepresentations.length) {
    const activeSegmentationId = segmentationService.getActiveSegmentation?.(viewportId)?.segmentationId;
    const attachedSegmentationId = viewportRepresentations.some(
      rep => rep.segmentationId === activeSegmentationId
    )
      ? activeSegmentationId
      : viewportRepresentations[0]?.segmentationId;

    if (attachedSegmentationId) {
      segmentationService.setActiveSegmentation?.(viewportId, attachedSegmentationId);
    }

    segLoadLog('autoCreate:SKIP-existing-representation', {
      viewportId,
      displaySetInstanceUID,
      representationCount: viewportRepresentations.length,
      attachedSegmentationId,
    });
    logSegmentationTimeline('autoCreate:skip-existing-viewport-representation', {
      viewportId,
      displaySetInstanceUID,
      representationCount: viewportRepresentations.length,
      attachedSegmentationId,
      segmentationIds: viewportRepresentations.map(rep => rep.segmentationId),
    });
    state?.autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
    return;
  }

  const displaySet = displaySetService?.getDisplaySetByUID(displaySetInstanceUID);
  if (!displaySet) {
    logSegmentationTimeline('autoCreate:skip-missing-display-set', {
      viewportId,
      displaySetInstanceUID,
    });
    return;
  }

  const inProgressSegmentationId = _autoCreateDisplaySetSegmentationIds.get(displaySetInstanceUID);
  if (
    state?.autoCreateInProgressDisplaySetUIDs.has(displaySetInstanceUID) ||
    (inProgressSegmentationId && getPhase(inProgressSegmentationId) !== undefined)
  ) {
    logSegmentationTimeline('autoCreate:skip-in-progress', {
      viewportId,
      displaySetInstanceUID,
      segmentationId: inProgressSegmentationId,
      phase: inProgressSegmentationId ? getPhase(inProgressSegmentationId) : undefined,
    });
    return;
  }

  const cornerstoneViewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
  if (!cornerstoneViewport) {
    segLoadLog('autoCreate:SKIP-no-cornerstone-viewport', { viewportId, displaySetInstanceUID });
    logSegmentationTimeline('autoCreate:skip-cornerstone-viewport-not-ready', {
      viewportId,
      displaySetInstanceUID,
      reason: 'first-load-safe-gate',
    });
    return;
  }
  segLoadLog('autoCreate:cornerstone-viewport-ready', { viewportId, displaySetInstanceUID });

  // Restore existing in-memory segmentation for this display set if one exists
  const existingSegmentationId = findExistingSegmentationForDisplaySet(
    displaySet,
    segmentationService,
    viewportId
  );
  if (existingSegmentationId) {
    const existingPhase = getPhase(existingSegmentationId);
    const firstLoadPending =
      state?.firstLoadPendingSegmentationIds.has(existingSegmentationId) ?? false;
    logSegmentationTimeline('autoCreate:existing-segmentation-found', {
      viewportId,
      displaySetInstanceUID,
      segmentationId: existingSegmentationId,
      firstLoadPending,
      phase: existingPhase,
      restoreInProgress:
        state?.restoreInProgressSegmentationIds.has(existingSegmentationId) ?? false,
      autosaveArmed: getPhase(existingSegmentationId) === 'armed',
      hasDynamicSegmentation:
        segmentationService.hasDynamicSegmentation?.(existingSegmentationId) || false,
    });
    const representationAdded = await addSegmentationRepresentationAndConfirm(
      segmentationService,
      viewportId,
      existingSegmentationId
    );
    if (!representationAdded) {
      logSegmentationTimeline('autoCreate:existing-representation-add-deferred', {
        viewportId,
        displaySetInstanceUID,
        segmentationId: existingSegmentationId,
      });
      return;
    }
    if (firstLoadPending) {
      logSegmentationTimeline('autoCreate:existing-first-load-backend-restore-start', {
        viewportId,
        displaySetInstanceUID,
        segmentationId: existingSegmentationId,
      });
      await restoreFrames(existingSegmentationId, servicesManager);
      state?.firstLoadPendingSegmentationIds.delete(existingSegmentationId);
      logSegmentationTimeline('autoCreate:existing-first-load-backend-restore-done', {
        viewportId,
        displaySetInstanceUID,
        segmentationId: existingSegmentationId,
      });
    }
    const dynamicBufferRestored =
      segmentationService.restoreDynamicSegmentationCurrentTimePointBuffer?.(
        existingSegmentationId
      );
    logSegmentationTimeline('autoCreate:existing-dynamic-buffer-restored', {
      viewportId,
      segmentationId: existingSegmentationId,
      dynamicBufferRestored,
    });
    forceRenderViewportAfterSegmentationRepresentation(
      servicesManager,
      viewportId,
      'existing-segmentation-restored'
    );
    segmentationService.setActiveSegmentation?.(viewportId, existingSegmentationId);
    state?.restoreInProgressSegmentationIds.delete(existingSegmentationId);
    state?.firstLoadPendingSegmentationIds.delete(existingSegmentationId);
    state?.autosaveBlockedUntilBySegmentationId.set(existingSegmentationId, Date.now() + 3000);
    state?.autosaveArmedSegmentationIds.add(existingSegmentationId);
    state?.autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
    if (getPhase(existingSegmentationId) !== 'armed') {
      setPhase(existingSegmentationId, 'armed');
    }
    logSegmentationTimeline('viewportVolumesChanged:representation-restored', {
      viewportId,
      displaySetInstanceUID,
      segmentationId: existingSegmentationId,
      autosaveArmed: true,
    });
    return;
  }

  state?.autoCreateDoneDisplaySetUIDs.delete(displaySetInstanceUID);

  const hasDisplaySetFrames =
    (displaySet.imageIds?.length || 0) > 0 ||
    (displaySet.dynamicVolumeInfo?.timePoints?.length || 0) > 0;
  if (!hasDisplaySetFrames) {
    logSegmentationTimeline('autoCreate:skip-no-display-set-frames', {
      viewportId,
      displaySetInstanceUID,
    });
    return;
  }

  state?.autoCreateInProgressDisplaySetUIDs.add(displaySetInstanceUID);
  const segmentationId = crypto.randomUUID();
  _autoCreateDisplaySetSegmentationIds.set(displaySetInstanceUID, segmentationId);
  setPhase(segmentationId, 'creating');

  logSegmentationTimeline('viewportVolumesChanged:auto-create-begin', {
    viewportId,
    displaySetInstanceUID,
    segmentationId,
    isDynamicVolume: Boolean(displaySet.isDynamicVolume),
    imageIdCount: displaySet.imageIds?.length || 0,
    timePointCount: displaySet.dynamicVolumeInfo?.timePoints?.length || 0,
  });

  try {
    const studyInstanceUID = displaySet.StudyInstanceUID;
    const seriesInstanceUID = displaySet.SeriesInstanceUID;

    if (
      wasSegmentationDeletedForDisplaySet({
        studyInstanceUID,
        seriesInstanceUID,
        displaySetInstanceUID,
      })
    ) {
      logSegmentationTimeline('viewportVolumesChanged:skip-auto-create-after-user-delete', {
        viewportId,
        displaySetInstanceUID,
        studyInstanceUID,
        seriesInstanceUID,
      });
      updatePersistenceStatus(
        servicesManager,
        'synced',
        'Segmentation deleted. Create a new labelmap to start again.'
      );
      state?.autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
      destroyAdapterSegmentation(segmentationId);
      return;
    }

    let saved: Awaited<ReturnType<typeof loadSegFrames>> = [];
    let metadataDocument: Awaited<ReturnType<typeof listSegmentationDocuments>>[number] | undefined;
    try {
      if (studyInstanceUID && seriesInstanceUID) {
        updatePersistenceStatus(
          servicesManager,
          'loading',
          'Checking backend for saved segmentation...'
        );
        segLoadLog('autoCreate:backend-prefetch-START', {
          viewportId,
          segmentationId,
          phase: getPhase(segmentationId),
          isDynamicVolume: Boolean(displaySet.isDynamicVolume),
        });
        console.warn('[segmentation-load-debug] autoCreate:backend-prefetch-start', {
          viewportId,
          displaySetInstanceUID,
          studyInstanceUID,
          seriesInstanceUID,
          isDynamicVolume: Boolean(displaySet.isDynamicVolume),
          imageIdCount: displaySet.imageIds?.length || 0,
          timePointCount: displaySet.dynamicVolumeInfo?.timePoints?.length || 0,
        });
        const metadataDocuments = await listSegmentationDocuments({
          studyInstanceUID,
          seriesInstanceUID,
        });
        metadataDocument = metadataDocuments[0];
        saved = await loadSegFramesWithTimeout(studyInstanceUID, seriesInstanceUID);
        segLoadLog('autoCreate:backend-prefetch-DONE', {
          viewportId,
          segmentationId,
          phase: getPhase(segmentationId),
          savedCount: saved.length,
          ...summarizeSavedFrames(saved),
          labelMapSample: saved.slice(0, 3).map(f => ({
            frameKey: f.frameKey,
            labelMapKeys: Object.keys(f.labelMap ?? {}),
            segmentationLabel: f.segmentationLabel,
          })),
        });
        console.warn('[segmentation-load-debug] autoCreate:backend-prefetch-done', {
          viewportId,
          displaySetInstanceUID,
          studyInstanceUID,
          seriesInstanceUID,
          ...summarizeSavedFrames(saved),
        });
        logSegmentationTimeline('viewportVolumesChanged:backend-prefetch-done', {
          viewportId,
          studyInstanceUID,
          seriesInstanceUID,
          savedCount: saved.length,
          ...summarizeSavedFrames(saved),
        });
      }
    } catch (err) {
      console.error('[segmentation-mode] failed to pre-fetch saved frames', err);
      updatePersistenceStatus(
        servicesManager,
        'error',
        err instanceof Error
          ? err.message
          : 'Failed to check saved segmentation state from backend.'
      );
    }

    if (!saved.length && !metadataDocument) {
      console.warn('[segmentation-load-debug] autoCreate:no-saved-frames-create-empty', {
        viewportId,
        displaySetInstanceUID,
        studyInstanceUID,
        seriesInstanceUID,
      });
      logSegmentationTimeline('viewportVolumesChanged:no-saved-segmentation-create-empty', {
        viewportId,
        displaySetInstanceUID,
        studyInstanceUID,
        seriesInstanceUID,
      });
      state?.autoRestoredSegmentationIds.add(segmentationId);

      let generatedId: string | undefined;
      try {
        generatedId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
          segmentationId,
        });
      } catch (err) {
        state?.autoRestoredSegmentationIds.delete(segmentationId);
        setPhase(segmentationId, 'error');
        console.error('[segmentation-mode] create empty labelmap failed', err);
        return;
      }

      const representationAdded = await addSegmentationRepresentationAndConfirm(
        segmentationService,
        viewportId,
        generatedId
      );
      if (!representationAdded) {
        logSegmentationTimeline('viewportVolumesChanged:empty-representation-add-deferred', {
          viewportId,
          displaySetInstanceUID,
          segmentationId: generatedId,
        });
        return;
      }

      segmentationService.setActiveSegmentation?.(viewportId, generatedId);
      segmentationService.setActiveSegment?.(generatedId, 1);
      state?.autosaveBlockedUntilBySegmentationId.set(generatedId, Date.now() + 1000);
      state?.autosaveArmedSegmentationIds.add(generatedId);
      setPhase(generatedId, 'armed');
      forceRenderViewportAfterSegmentationRepresentation(
        servicesManager,
        viewportId,
        'empty-segmentation-created'
      );
      updatePersistenceStatus(
        servicesManager,
        'synced',
        'Checked backend state. Ready for new segmentation.'
      );
      state?.autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
      return;
    }

    const mergedLabelMap: Record<
      number,
      { labelId: string; labelName: string; labelColor: string; labelLocked?: boolean }
    > = {};
    const persistedSegmentationLabel =
      metadataDocument?.label ||
      saved.find(frame => frame.segmentationLabel?.trim())?.segmentationLabel ||
      undefined;
    Object.assign(mergedLabelMap, buildLabelMapFromSegmentationDocument(metadataDocument));
    for (const frame of saved) {
      if (frame.labelMap) Object.assign(mergedLabelMap, frame.labelMap);
    }

    // If no label_map metadata was stored with the frames, inject a default segment
    // No default segment injection: if the user deleted all segments (or never created any),
    // the panel shows the "No Segment" empty-state placeholder instead of auto-creating a card.
    // segLoadLog will record the empty label map for diagnostics.
    segLoadLog('autoCreate:label-map-after-merge', {
      viewportId,
      segmentationId,
      mergedLabelMapKeys: Object.keys(mergedLabelMap),
      savedCount: saved.length,
    });

    const sortedSegIndices = Object.keys(mergedLabelMap)
      .map(Number)
      .sort((a, b) => a - b);
    const segmentsConfig: Record<number, { label: string; active: boolean; isLocked?: boolean }> =
      {};
    for (const idx of sortedSegIndices) {
      segmentsConfig[idx] = {
        label: mergedLabelMap[idx].labelName,
        active: idx === sortedSegIndices[0],
        isLocked: Boolean(mergedLabelMap[idx].labelLocked),
      };
    }

    segLoadLog('autoCreate:build-segments-config', {
      viewportId,
      segmentationId,
      phase: getPhase(segmentationId),
      mergedLabelMapKeys: Object.keys(mergedLabelMap),
      segmentsConfigKeys: Object.keys(segmentsConfig),
      persistedSegmentationLabel,
      savedCount: saved.length,
    });

    state?.autoRestoredSegmentationIds.add(segmentationId);

    let generatedId: string | undefined;
    try {
      segLoadLog('autoCreate:createLabelmap-START', {
        viewportId,
        segmentationId,
        phase: getPhase(segmentationId),
      });
      generatedId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        label: persistedSegmentationLabel,
        segments: segmentsConfig,
      });
      if (metadataDocument) {
        bindSegmentationDocument(generatedId, metadataDocument);
      }
      segLoadLog('autoCreate:createLabelmap-DONE', {
        viewportId,
        segmentationId,
        generatedId,
        ...snapshotSegState(segmentationService, generatedId as string),
      });
      logSegmentationTimeline('viewportVolumesChanged:labelmap-created', {
        viewportId,
        segmentationId: generatedId,
      });
    } catch (err) {
      state?.autoRestoredSegmentationIds.delete(segmentationId);
      setPhase(segmentationId, 'error');
      console.error('[segmentation-mode] createLabelmapForDisplaySet failed', err);
      return;
    }

    state?.restoreInProgressSegmentationIds.add(generatedId);
    state?.firstLoadPendingSegmentationIds.add(generatedId);
    state?.autosaveArmedSegmentationIds.delete(generatedId);
    setPhase(generatedId, 'restoring');
    logSegmentationTimeline('viewportVolumesChanged:first-load-pending-set', {
      viewportId,
      displaySetInstanceUID,
      segmentationId: generatedId,
    });

    try {
      const representationAdded = await addSegmentationRepresentationAndConfirm(
        segmentationService,
        viewportId,
        generatedId
      );
      if (!representationAdded) {
        logSegmentationTimeline('viewportVolumesChanged:representation-add-deferred', {
          viewportId,
          displaySetInstanceUID,
          segmentationId: generatedId,
        });
        return;
      }
      logSegmentationTimeline('viewportVolumesChanged:representation-added', {
        viewportId,
        segmentationId: generatedId,
        hasDynamicSegmentation: segmentationService.hasDynamicSegmentation?.(generatedId) || false,
      });
      segmentationService.setActiveSegmentation?.(viewportId, generatedId);
    } catch (err) {
      console.error('[segmentation-mode] addSegmentationRepresentation failed', err);
      logSegmentationTimeline('viewportVolumesChanged:representation-add-failed', {
        viewportId,
        segmentationId: generatedId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const savedByKey = new Map(saved.map(f => [f.frameKey, f]));
    const modifiedIndices: number[] = [];
    const segState2 = segmentationService.getSegmentation(generatedId);
    const labelmapData2 = segState2?.representationData?.[
      toolEnums.SegmentationRepresentations.Labelmap
    ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;
    const { imageIds: labelmapImageIds2, referencedImageIds: referencedImageIds2 } =
      getSanitizedLabelmapFrames(labelmapData2);

    logSegmentationTimeline('autoCreate:labelmap-state-before-restore', {
      viewportId,
      segmentationId: generatedId,
      labelmapImageCount: labelmapImageIds2.length,
      referencedImageCount: referencedImageIds2.length,
      ...summarizeLabelmapFrames(labelmapImageIds2),
    });
    console.warn('[segmentation-load-debug] autoCreate:labelmap-state-before-restore', {
      viewportId,
      segmentationId: generatedId,
      labelmapImageCount: labelmapImageIds2.length,
      referencedImageCount: referencedImageIds2.length,
      ...summarizeSavedFrames(saved),
      ...summarizeLabelmapFrames(labelmapImageIds2),
    });

    const restoredTimePoints = segmentationService.restoreDynamicSegmentationTimePointBuffers?.(
      generatedId,
      referencedImageIds2,
      savedByKey
    );
    logSegmentationTimeline('viewportVolumesChanged:restore-attempted', {
      segmentationId: generatedId,
      referencedImageCount: referencedImageIds2.length,
      restoredTimePoints,
      hasDynamicSegmentation: segmentationService.hasDynamicSegmentation?.(generatedId) || false,
    });
    console.warn('[segmentation-load-debug] autoCreate:dynamic-restore-attempted', {
      viewportId,
      segmentationId: generatedId,
      restoredTimePoints,
      hasDynamicSegmentation: segmentationService.hasDynamicSegmentation?.(generatedId) || false,
      ...summarizeRestoreMatches(referencedImageIds2, savedByKey),
    });

    if (!segmentationService.hasDynamicSegmentation?.(generatedId)) {
      const csSeg = cstSegmentation.state.getSegmentation(generatedId);
      const restoreVolumeId = (csSeg?.representationData?.Labelmap as any)?.volumeId;
      const restoreVolume = restoreVolumeId ? cache.getVolume(restoreVolumeId) : null;

      logSegmentationTimeline('autoCreate:static-restore-target', {
        viewportId,
        segmentationId: generatedId,
        restoreVolumeId,
        hasRestoreVolume: Boolean(restoreVolume),
        labelmapImageCount: labelmapImageIds2.length,
      });

      if (restoreVolume) {
        const volumeScalarData = getVolumeScalarData(restoreVolume);
        const { numberOfSlices, sliceLength } = getVolumeFrameGeometry(restoreVolume);
        console.warn('[segmentation-load-debug] autoCreate:static-volume-target', {
          viewportId,
          segmentationId: generatedId,
          restoreVolumeId,
          numberOfSlices,
          sliceLength,
          hasVolumeScalarData: Boolean(volumeScalarData),
          ...summarizeRestoreMatches(referencedImageIds2, savedByKey, sliceLength),
        });
        if (volumeScalarData && sliceLength) {
          for (let i = 0; i < referencedImageIds2.length; i++) {
            const referencedImageId = referencedImageIds2[i];
            if (!referencedImageId) continue;
            const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
            const frame = savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
            if (!frame || frame.maskData.length !== sliceLength) continue;

            const volumeSliceIndex = getVolumeSliceIndexForReferencedImageId(
              restoreVolume,
              referencedImageId,
              i
            );
            if (volumeSliceIndex < 0 || volumeSliceIndex >= numberOfSlices) continue;

            writeVolumeSliceScalarData(
              restoreVolume,
              volumeSliceIndex,
              frame.maskData,
              volumeScalarData,
              sliceLength
            );
            modifiedIndices.push(volumeSliceIndex);
          }
          restoreVolume.imageData?.modified?.();
          restoreVolume.invalidate?.();
        } else {
          modifiedIndices.push(
            ...applySavedFramesToLabelmapVolume(
              restoreVolume,
              savedByKey,
              generatedId,
              'autoCreate'
            )
          );
        }
      } else {
        console.warn('[segmentation-load-debug] autoCreate:stack-image-target', {
          viewportId,
          segmentationId: generatedId,
          labelmapImageCount: labelmapImageIds2.length,
          ...summarizeRestoreMatches(referencedImageIds2, savedByKey),
        });
        for (let i = 0; i < labelmapImageIds2.length; i++) {
          const referencedImageId = referencedImageIds2[i];
          if (!referencedImageId) continue;
          const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
          const frame = savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
          if (!frame) continue;
          const labelmapImage =
            cache.getImage(labelmapImageIds2[i]) ||
            (await imageLoader.loadAndCacheImage(labelmapImageIds2[i]));
          const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
          if (!scalarData || scalarData.length !== frame.maskData.length) continue;
          scalarData.set(frame.maskData);
          modifiedIndices.push(i);
        }
      }
    }

    logSegmentationTimeline('autoCreate:labelmap-state-after-restore', {
      viewportId,
      segmentationId: generatedId,
      modifiedIndices,
      restoredTimePoints,
      ...summarizeLabelmapFrames(labelmapImageIds2),
    });
    console.warn('[segmentation-load-debug] autoCreate:labelmap-state-after-restore', {
      viewportId,
      segmentationId: generatedId,
      modifiedIndices,
      restoredTimePoints,
      ...summarizeLabelmapFrames(labelmapImageIds2),
    });
    segLoadLog('autoCreate:pixels-restored', {
      viewportId,
      generatedId,
      phase: getPhase(generatedId as string),
      modifiedIndices,
      restoredTimePoints,
      ...snapshotSegState(segmentationService, generatedId as string),
    });

    for (const idx of sortedSegIndices) {
      const entry = mergedLabelMap[idx];
      try {
        segmentationService.setSegmentColor(
          viewportId,
          generatedId,
          idx,
          hexToRgba255(entry.labelColor || '#FFFFFF')
        );
      } catch {
        // best-effort
      }
    }

    if (modifiedIndices.length) {
      cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(generatedId);
      updatePersistenceStatus(
        servicesManager,
        'synced',
        `Loaded ${modifiedIndices.length} saved segmentation frame${modifiedIndices.length === 1 ? '' : 's'} from backend.`
      );
    } else if (restoredTimePoints?.length) {
      cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(generatedId);
      updatePersistenceStatus(
        servicesManager,
        'synced',
        `Loaded saved segmentation for ${restoredTimePoints.length} timepoint${restoredTimePoints.length === 1 ? '' : 's'} from backend.`
      );
    } else {
      updatePersistenceStatus(
        servicesManager,
        'synced',
        'Saved segmentation metadata loaded. No pixels were restored into the active view.'
      );
    }

    forceRenderViewportAfterSegmentationRepresentation(
      servicesManager,
      viewportId,
      'backend-segmentation-restored'
    );

    state?.restoreInProgressSegmentationIds.delete(generatedId);
    state?.firstLoadPendingSegmentationIds.delete(generatedId);
    state?.autosaveBlockedUntilBySegmentationId.set(generatedId, Date.now() + 3000);
    state?.autosaveArmedSegmentationIds.add(generatedId);
    setPhase(generatedId, 'armed');
    logSegmentationTimeline('viewportVolumesChanged:init-finished', {
      segmentationId: generatedId,
      autosaveArmed: true,
      firstLoadPending: state?.firstLoadPendingSegmentationIds.has(generatedId) ?? false,
      modifiedIndices,
      restoredTimePoints,
    });
    state?.autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
    segLoadLog('autoCreate:EXIT-success', {
      viewportId,
      generatedId,
      phase: getPhase(generatedId as string),
      ...snapshotSegState(segmentationService, generatedId as string),
    });
  } finally {
    state?.autoCreateInProgressDisplaySetUIDs.delete(displaySetInstanceUID);
    if (_autoCreateDisplaySetSegmentationIds.get(displaySetInstanceUID) === segmentationId) {
      _autoCreateDisplaySetSegmentationIds.delete(displaySetInstanceUID);
    }
  }
};
