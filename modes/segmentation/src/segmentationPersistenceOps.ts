import { cache, imageLoader } from '@cornerstonejs/core';
import { Enums as toolEnums, segmentation as cstSegmentation } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';
import { saveSegFrame, loadSegFrames, deleteSegFrame } from './segmentationStorage';
import { setSegmentationPersistenceStatus } from '../../../extensions/cornerstone/src/utils/segmentationPersistenceStatus';
import { hexToRgba255, rgbaToHex } from '../../../extensions/ovi-labs/src/utils/colorUtils';

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

export const logSegmentationTimeline = (phase: string, details?: Record<string, unknown>) => {
  console.debug('[segmentation-mode][timeline]', {
    ts: new Date().toISOString(),
    phase,
    ...(details || {}),
  });
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
    Object.entries(segState?.segments || {}).map(([segmentIndex, segment]: [string, any]) => [
      Number(segmentIndex),
      {
        labelId: String(segmentIndex),
        labelName: segment?.label || `Segment ${segmentIndex}`,
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

export const applySavedFramesToLabelmapVolume = (
  restoreVolume: any,
  savedByKey: Map<string, { maskData: Uint8Array }>,
  segmentationId: string,
  logPrefix: string
): number[] => {
  const modifiedIndices: number[] = [];
  let volumeScalarData: Uint8Array | undefined;
  try {
    volumeScalarData = restoreVolume?.voxelManager?.getScalarData?.() as Uint8Array | undefined;
  } catch (error) {
    console.debug('[segmentation-mode] applySavedFramesToLabelmapVolume:no-volume-scalar-data', {
      segmentationId,
      logPrefix,
      error,
      volumeId: restoreVolume?.volumeId,
    });
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
    console.debug(`[segmentation-mode] ${logPrefix}:applied-frame`, {
      segmentationId,
      frameIndex: i,
      frameKey: stableFrameKey,
      pixelCount: frame.maskData.length,
    });
  }

  return modifiedIndices;
};

// ─── Save / restore ───────────────────────────────────────────────────────────

export type SaveScope = 'current-timepoint' | 'all-timepoints';

/** Read labelmap frames for a segmentation and save them to the backend. */
export const saveAllFrames = async (
  segmentationId: string,
  servicesManager: any,
  saveScope: SaveScope = 'all-timepoints'
): Promise<void> => {
  const { segmentationService } = servicesManager.services;
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
  if (!seriesInstanceUID || !studyInstanceUID) return;

  logSegmentationTimeline('saveAllFrames:start', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    hasDynamicSegmentation: segmentationService.hasDynamicSegmentation?.(segmentationId) || false,
    saveScope,
  });
  updatePersistenceStatus(servicesManager, 'saving', 'Saving segmentation changes to backend...');

  console.debug('[segmentation-mode] saveAllFrames:start', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    frameCount: labelmapImageIds.length,
  });

  const labelMap = buildPersistedLabelMap(segmentationId, servicesManager);
  const segmentationLabel = segState.label;
  const segmentCount = Object.keys(labelMap).length;
  let wroteAnyFrame = false;

  const hasDynamicSegmentation =
    segmentationService.hasDynamicSegmentation?.(segmentationId) || false;

  if (hasDynamicSegmentation) {
    const getSnapshots =
      saveScope === 'current-timepoint'
        ? segmentationService.getDynamicSegmentationCurrentTimePointFrameSnapshots
        : segmentationService.getDynamicSegmentationFrameSnapshots;

    const snapshots = getSnapshots ? await getSnapshots.call(segmentationService, segmentationId) : [];

    logSegmentationTimeline('saveAllFrames:dynamic-snapshots', {
      segmentationId,
      snapshotCount: snapshots.length,
      saveScope,
    });

    for (const snapshot of snapshots) {
      const stableFrameKey = getStableFrameKey(snapshot.referencedImageId) || snapshot.referencedImageId;
      const hasData = snapshot.maskData.some((v: number) => v !== 0);

      if (!hasData) {
        console.debug('[segmentation-mode] saveAllFrames:delete-empty-frame', {
          segmentationId,
          frameKey: stableFrameKey,
        });
        await deleteSegFrame({
          studyInstanceUID,
          seriesInstanceUID,
          frameKey: stableFrameKey,
        });
        continue;
      }

      console.debug('[segmentation-mode] saveAllFrames:save-frame', {
        segmentationId,
        frameKey: stableFrameKey,
        width: snapshot.width,
        height: snapshot.height,
        frameNumber: snapshot.frameNumber,
      });
      await saveSegFrame({
        studyInstanceUID,
        seriesInstanceUID,
        frameKey: stableFrameKey,
        frameNumber: snapshot.frameNumber,
        width: snapshot.width,
        height: snapshot.height,
        maskData: new Uint8Array(snapshot.maskData),
        labelMap,
        segmentationLabel,
      });
      wroteAnyFrame = true;
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

      const hasData = scalarData.some((v: number) => v !== 0);
      if (!hasData) {
        console.debug('[segmentation-mode] saveAllFrames:delete-empty-frame', {
          segmentationId,
          frameIndex: i,
          frameKey: stableFrameKey,
        });
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

      console.debug('[segmentation-mode] saveAllFrames:save-frame', {
        segmentationId,
        frameIndex: i,
        frameKey: stableFrameKey,
        width,
        height,
        nonZero: true,
      });
      await saveSegFrame({
        studyInstanceUID,
        seriesInstanceUID,
        frameKey: stableFrameKey,
        frameNumber: getFrameNumberFromImageId(referencedImageId),
        width,
        height,
        maskData: new Uint8Array(scalarData),
        labelMap,
        segmentationLabel,
      });
      wroteAnyFrame = true;
    }
  }

  if (!wroteAnyFrame && segmentCount > 0 && referencedImageIds[0]) {
    const placeholderImageId = labelmapImageIds[0];
    const placeholderImage = placeholderImageId ? cache.getImage(placeholderImageId) : null;
    const width: number = placeholderImage?.columns ?? placeholderImage?.width ?? 0;
    const height: number = placeholderImage?.rows ?? placeholderImage?.height ?? 0;
    const frameNumber = getFrameNumberFromImageId(referencedImageIds[0]);
    const frameKey = getStableFrameKey(referencedImageIds[0]) || referencedImageIds[0];

    if (width && height && frameKey) {
      console.debug('[segmentation-mode] saveAllFrames:save-placeholder-frame', {
        segmentationId,
        frameKey,
        width,
        height,
        segmentCount,
      });
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

  console.debug('[segmentation-mode] saveAllFrames:done', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
  });
  logSegmentationTimeline('saveAllFrames:done', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    saveScope,
  });
  updatePersistenceStatus(servicesManager, 'synced', 'Segmentation changes saved to backend.');
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
export const restoreFrames = async (segmentationId: string, servicesManager: any): Promise<void> => {
  const { segmentationService } = servicesManager.services;
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
  if (!seriesInstanceUID || !studyInstanceUID) return;

  const saved = await loadSegFrames(studyInstanceUID, seriesInstanceUID);
  logSegmentationTimeline('restoreFrames:loaded-backend-frames', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    savedCount: saved.length,
  });
  console.debug('[segmentation-mode] restoreFrames:loaded', {
    segmentationId,
    studyInstanceUID,
    seriesInstanceUID,
    savedCount: saved.length,
    viewportFrameCount: labelmapImageIds.length,
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

  // Add segments matching the stored label map (zero segments if no data)
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
    } catch (err) {
      console.debug('[segmentation-mode] restoreFrames:addSegment-error', { segIndex, err });
    }
  }

  if (!saved.length) return;

  const savedByKey = new Map(saved.map(f => [f.frameKey, f]));
  const modifiedIndices: number[] = [];
  const restoredTimePoints = segmentationService.restoreDynamicSegmentationTimePointBuffers?.(
    segmentationId,
    referencedImageIds,
    savedByKey
  );

  if (segmentationService.hasDynamicSegmentation?.(segmentationId)) {
    if (restoredTimePoints?.length) {
      logSegmentationTimeline('restoreFrames:restored-dynamic', {
        segmentationId,
        restoredTimePoints,
        savedCount: saved.length,
      });
      console.debug('[segmentation-mode] restoreFrames:applied-timepoints', {
        segmentationId,
        timePoints: restoredTimePoints,
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
    modifiedIndices.push(
      ...applySavedFramesToLabelmapVolume(
        restoreVolume,
        savedByKey,
        segmentationId,
        'restoreFrames'
      )
    );
  } else {
    // Fallback: per-frame derived images (stack viewport, or pre-representation timing).
    for (let i = 0; i < labelmapImageIds.length; i++) {
      const referencedImageId = referencedImageIds[i];
      if (!referencedImageId) continue;
      const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
      const frame =
        savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
      if (!frame) continue;
      const labelmapImage =
        cache.getImage(labelmapImageIds[i]) ||
        (await imageLoader.loadAndCacheImage(labelmapImageIds[i]));
      const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
      if (!scalarData || scalarData.length !== frame.maskData.length) continue;
      scalarData.set(frame.maskData);
      modifiedIndices.push(i);
      console.debug('[segmentation-mode] restoreFrames:applied-frame', {
        segmentationId,
        frameIndex: i,
        frameKey: stableFrameKey,
        pixelCount: frame.maskData.length,
      });
    }
  }

  if (modifiedIndices.length) {
    logSegmentationTimeline('restoreFrames:restored-static', {
      segmentationId,
      modifiedIndices,
      savedCount: saved.length,
    });
    console.debug('[segmentation-mode] restoreFrames:trigger-modified', {
      segmentationId,
      modifiedIndices,
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
};
