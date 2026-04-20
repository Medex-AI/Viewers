import { eventTarget, cache, imageLoader } from '@cornerstonejs/core';
import {
  annotation,
  Enums as toolEnums,
  segmentation as cstSegmentation,
} from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';
import { id } from './id';
import toolbarButtons from './toolbarButtons';
import initToolGroups from './initToolGroups';
import { syncManualContourColor } from './syncManualContourColor';
import { writeContourToOhifLabelmap } from './writeContourToOhifLabelmap';
import { saveSegFrame, loadSegFrames, deleteSegFrame } from './segmentationStorage';
import { setSegmentationPersistenceStatus } from '../../../extensions/cornerstone/src/utils/segmentationPersistenceStatus';

const DEFAULT_BRUSH_SIZE_MM = 3;
const DEFAULT_BRUSH_TOOL_NAMES = [
  'CircularBrush',
  'SphereBrush',
  'CircularEraser',
  'SphereEraser',
  'ThresholdCircularBrush',
  'ThresholdSphereBrush',
  'ThresholdCircularBrushDynamic',
  'ThresholdSphereBrushDynamic',
];

const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  hangingProtocol: '@ohif/extension-default.hangingProtocolModule.default',
  leftPanel: '@ohif/extension-default.panelModule.seriesList',
};

const cornerstone = {
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
  panelTool: '@ohif/extension-cornerstone.panelModule.panelSegmentationWithTools',
  measurements: '@ohif/extension-cornerstone.panelModule.panelMeasurement',
};

const oviLabs = {
  segmentationExportPanel: '@ohif/extension-ovi-labs.panelModule.segmentationExport',
};

const segmentation = {
  sopClassHandler: '@ohif/extension-cornerstone-dicom-seg.sopClassHandlerModule.dicom-seg',
  viewport: '@ohif/extension-cornerstone-dicom-seg.viewportModule.dicom-seg',
};

const dicomRT = {
  viewport: '@ohif/extension-cornerstone-dicom-rt.viewportModule.dicom-rt',
  sopClassHandler: '@ohif/extension-cornerstone-dicom-rt.sopClassHandlerModule.dicom-rt',
};
/**
 * Just two dependencies to be able to render a viewport with panels in order
 * to make sure that the mode is working.
 */
const extensionDependencies = {
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-seg': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-rt': '^3.0.0',
  '@ohif/extension-ovi-labs': '*',
};

const notifySegmentationPersistenceError = (
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

const updatePersistenceStatus = (
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

const logSegmentationTimeline = (phase: string, details?: Record<string, unknown>) => {
  console.debug('[segmentation-mode][timeline]', {
    ts: new Date().toISOString(),
    phase,
    ...(details || {}),
  });
};

const getFrameNumberFromImageId = (imageId?: string): number => {
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

const getStableFrameKey = (referencedImageId?: string): string | null => {
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

const getSanitizedLabelmapFrames = (
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

const hexToRgba = (hex: string): [number, number, number, number] => {
  const normalized = hex.replace('#', '');
  const safeHex = normalized.length === 6 ? normalized : 'FFFFFF';
  const r = parseInt(safeHex.slice(0, 2), 16);
  const g = parseInt(safeHex.slice(2, 4), 16);
  const b = parseInt(safeHex.slice(4, 6), 16);
  return [r, g, b, 255];
};

const rgbaToHex = (color?: number[] | null): string => {
  if (!Array.isArray(color) || color.length < 3) {
    return '#FFFFFF';
  }

  return `#${color
    .slice(0, 3)
    .map(value => Math.max(0, Math.min(255, Number(value) || 0)).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
};

const buildPersistedLabelMap = (segmentationId: string, servicesManager: any) => {
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

const applySavedFramesToLabelmapVolume = (
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


type SaveScope = 'current-timepoint' | 'all-timepoints';

/** Read labelmap frames for a segmentation and save them to the backend. */
const saveAllFrames = async (
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

const getManualSaveSegmentationId = (servicesManager: any): string | null => {
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
const restoreFrames = async (segmentationId: string, servicesManager: any): Promise<void> => {
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
        color: hexToRgba(entry.labelColor || '#FFFFFF'),
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
  // volumeId is set by handleVolumeViewport after addSegmentationRepresentation; it may
  // not be present yet if this runs before the representation is registered (stack path).
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

function modeFactory({ modeConfiguration }) {
  let _unsubscribeSegmentModified: (() => void) | null = null;
  let _onContourCompleted: ((evt: Event) => void) | null = null;
  let _unsubscribeSegmentDataModified: (() => void) | null = null;
  let _unsubscribeSegmentationModifiedAutosave: (() => void) | null = null;
  let _unsubscribeSegmentationRepresentationModifiedAutosave: (() => void) | null = null;
  let _unsubscribeSegmentationAdded: (() => void) | null = null;
  let _unsubscribeViewportDataChanged: (() => void) | null = null;
  let _onKeyDown: ((evt: KeyboardEvent) => void) | null = null;
  const _saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const _autoRestoredSegmentationIds = new Set<string>();
  const _restoreInProgressSegmentationIds = new Set<string>();
  const _autosaveArmedSegmentationIds = new Set<string>();

  return {
    /**
     * Mode ID, which should be unique among modes used by the viewer. This ID
     * is used to identify the mode in the viewer's state.
     */
    id,
    routeName: 'segmentation',
    /**
     * Mode name, which is displayed in the viewer's UI in the workList, for the
     * user to select the mode.
     */
    displayName: 'Segmentation',
    /**
     * Runs when the Mode Route is mounted to the DOM. Usually used to initialize
     * Services and other resources.
     */
    onModeEnter: ({ servicesManager, extensionManager, commandsManager }: withAppTypes) => {
      const {
        measurementService,
        toolbarService,
        toolGroupService,
        customizationService,
        segmentationService,
        displaySetService,
        viewportGridService,
        cornerstoneViewportService,
        uiNotificationService,
      } = servicesManager.services;

      measurementService.clearMeasurements();

      // Init Default and SR ToolGroups
      initToolGroups(extensionManager, toolGroupService, commandsManager);
      commandsManager.runCommand('setBrushSize', {
        value: DEFAULT_BRUSH_SIZE_MM,
        toolNames: DEFAULT_BRUSH_TOOL_NAMES,
      });

      toolbarService.addButtons(toolbarButtons);

      toolbarService.createButtonSection('primary', [
        'WindowLevel',
        'Pan',
        'Zoom',
        'TrackballRotate',
        'Capture',
        'Layout',
        'Crosshairs',
        'MoreTools',
      ]);

      toolbarService.createButtonSection('moreToolsSection', [
        'Reset',
        'rotate-right',
        'flipHorizontal',
        'ReferenceLines',
        'ImageOverlayViewer',
        'StackScroll',
        'invert',
        'Cine',
        'Magnify',
        'TagBrowser',
      ]);

      toolbarService.createButtonSection('segmentationToolbox', [
        'SegmentationUtilities',
        'SegmentationTools',
      ]);
      toolbarService.createButtonSection('segmentationToolboxUtilitySection', [
        'LabelmapSlicePropagation',
        'InterpolateLabelmap',
        'SegmentBidirectional',
      ]);
      toolbarService.createButtonSection('segmentationToolboxToolsSection', [
        'BrushTools',
        'MarkerLabelmap',
        'RegionSegmentPlus',
        'Shapes',
      ]);
      toolbarService.createButtonSection('brushToolsSection', [
        'ManualContour',
        'Brush',
        'Eraser',
        'Threshold',
      ]);

      // Auto-activate contour editing when the first segment is added so the
      // user can start drawing without an extra click.
      let hasAutoActivatedContour = false;
      const { unsubscribe } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        (data: any) => {
          const { segmentationId } = data || {};

          // Sync ManualContour stroke/fill color to the active segment's color
          try {
            const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
            if (activeViewportId && segmentationId) {
              syncManualContourColor(activeViewportId, segmentationId, segmentationService);
            }
          } catch {
            // best-effort
          }

          if (hasAutoActivatedContour) {
            return;
          }
          const segmentation = segmentationService.getSegmentation(segmentationId);
          const hasSegments = Object.values(segmentation?.segments ?? {}).some(Boolean);
          if (!hasSegments) {
            return;
          }
          hasAutoActivatedContour = true;
          commandsManager.runCommand('setToolActiveToolbar', { toolName: 'ManualContour' });
        }
      );
      _unsubscribeSegmentModified = unsubscribe;

      // Rasterize ManualContour annotations into the active labelmap segment
      // when the user closes a contour, so the fill appears like a brush stroke.
      _onContourCompleted = (evt: Event) => {
        const completedAnnotation = (evt as CustomEvent).detail?.annotation;
        if (completedAnnotation?.metadata?.toolName !== 'ManualContour') {
          return;
        }

        const referencedImageId = completedAnnotation.metadata?.referencedImageId;
        const worldPolyline =
          completedAnnotation.data?.contour?.polyline || completedAnnotation.data?.handles?.points;

        if (!referencedImageId || !worldPolyline?.length) {
          return;
        }

        const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
        if (!activeViewportId) {
          return;
        }

        void writeContourToOhifLabelmap({
          servicesManager,
          viewportId: activeViewportId,
          referencedImageId,
          worldPolyline,
        }).then(result => {
          if (result) {
            annotation.state.removeAnnotation(completedAnnotation.annotationUID);
          }
        });
      };

      eventTarget.addEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);

      const scheduleAutosave = (
        segmentationId: string,
        saveScope: SaveScope,
        reason: string
      ) => {
        if (
          _restoreInProgressSegmentationIds.has(segmentationId) ||
          !_autosaveArmedSegmentationIds.has(segmentationId)
        ) {
          logSegmentationTimeline('autosave:ignored', {
            segmentationId,
            reason,
            restoreInProgress: _restoreInProgressSegmentationIds.has(segmentationId),
            autosaveArmed: _autosaveArmedSegmentationIds.has(segmentationId),
          });
          return;
        }

        logSegmentationTimeline('autosave:scheduled', {
          segmentationId,
          reason,
          saveScope,
        });
        updatePersistenceStatus(
          servicesManager,
          'dirty',
          'Unsaved segmentation changes. Saving will start automatically.'
        );

        const existing = _saveDebounceTimers.get(segmentationId);
        if (existing) {
          clearTimeout(existing);
        }

        _saveDebounceTimers.set(
          segmentationId,
          setTimeout(() => {
            _saveDebounceTimers.delete(segmentationId);
            logSegmentationTimeline('autosave:debounce-fired', {
              segmentationId,
              reason,
              saveScope,
            });
            void saveAllFrames(segmentationId, servicesManager, saveScope).catch(error => {
              console.error('[segmentation-mode] autosave:error', {
                segmentationId,
                reason,
                saveScope,
                error,
              });
              updatePersistenceStatus(
                servicesManager,
                'error',
                error instanceof Error
                  ? error.message
                  : 'Failed to save segmentation changes to backend.'
              );
              notifySegmentationPersistenceError(
                servicesManager,
                error,
                'Segmentation Save Requires Login'
              );
            });
          }, 500)
        );
      };

      // Persist labelmap pixel data whenever a brush stroke modifies it
      const { unsubscribe: unsubDataModified } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
        ({ segmentationId }: { segmentationId: string }) => {
          scheduleAutosave(segmentationId, 'current-timepoint', 'data-modified');
        }
      );
      _unsubscribeSegmentDataModified = unsubDataModified;

      const { unsubscribe: unsubSegModifiedAutosave } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        ({ segmentationId }: { segmentationId: string }) => {
          scheduleAutosave(segmentationId, 'all-timepoints', 'segmentation-modified');
        }
      );
      _unsubscribeSegmentationModifiedAutosave = unsubSegModifiedAutosave;

      const { unsubscribe: unsubSegRepresentationModifiedAutosave } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
        ({ segmentationId }: { segmentationId: string }) => {
          scheduleAutosave(segmentationId, 'all-timepoints', 'representation-modified');
        }
      );
      _unsubscribeSegmentationRepresentationModifiedAutosave =
        unsubSegRepresentationModifiedAutosave;

      // Restore previously saved frames whenever a new segmentation is created
      const { unsubscribe: unsubSegAdded } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_ADDED,
        ({ segmentationId }: { segmentationId: string }) => {
          if (_autoRestoredSegmentationIds.has(segmentationId)) return;
          _restoreInProgressSegmentationIds.add(segmentationId);
          _autosaveArmedSegmentationIds.delete(segmentationId);
          logSegmentationTimeline('segmentationAdded:begin-restore', {
            segmentationId,
          });
          void restoreFrames(segmentationId, servicesManager)
            .catch(error => {
              console.error('[segmentation-mode] restore:error', {
                segmentationId,
                error,
              });
              updatePersistenceStatus(
                servicesManager,
                'error',
                error instanceof Error
                  ? error.message
                  : 'Failed to load saved segmentation from backend.'
              );
              notifySegmentationPersistenceError(
                servicesManager,
                error,
                'Segmentation Load Requires Login'
              );
            })
            .finally(() => {
              _restoreInProgressSegmentationIds.delete(segmentationId);
              _autosaveArmedSegmentationIds.add(segmentationId);
              logSegmentationTimeline('segmentationAdded:restore-finished', {
                segmentationId,
                autosaveArmed: true,
              });
            });
        }
      );
      _unsubscribeSegmentationAdded = unsubSegAdded;

      // Auto-create a labelmap once the active viewport has usable display-set data.
      // `VIEWPORT_VOLUMES_CHANGED` is sufficient for volume paths, but stack/initial
      // selected-instance entry can miss it, so we also listen to `VIEWPORT_DATA_CHANGED`
      // and run one immediate attempt after subscriptions are installed.
      const _autoCreateDoneDisplaySetUIDs = new Set<string>();
      const _autoCreateInProgressDisplaySetUIDs = new Set<string>();
      const tryAutoCreateSegmentationFromBackend = async () => {
        const viewportId = viewportGridService.getActiveViewportId?.();
        if (!viewportId) return;
        const { viewports } = viewportGridService.getState();
        const viewport = viewports?.get(viewportId);
        if (!viewport?.displaySetInstanceUIDs?.length) return;

        const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];
        if (
          _autoCreateDoneDisplaySetUIDs.has(displaySetInstanceUID) ||
          _autoCreateInProgressDisplaySetUIDs.has(displaySetInstanceUID)
        ) {
          return;
        }

        const viewportRepresentations =
          segmentationService.getSegmentationRepresentations?.(viewportId) ?? [];
        if (viewportRepresentations.length) {
          _autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
          return;
        }

        const displaySet = displaySetService?.getDisplaySetByUID(displaySetInstanceUID);
        if (!displaySet) return;
        const hasDisplaySetFrames =
          (displaySet.imageIds?.length || 0) > 0 ||
          (displaySet.dynamicVolumeInfo?.timePoints?.length || 0) > 0;
        if (!hasDisplaySetFrames) {
          return;
        }

        _autoCreateInProgressDisplaySetUIDs.add(displaySetInstanceUID);

        logSegmentationTimeline('viewportVolumesChanged:auto-create-begin', {
          viewportId,
          displaySetInstanceUID,
          isDynamicVolume: Boolean(displaySet.isDynamicVolume),
          imageIdCount: displaySet.imageIds?.length || 0,
          timePointCount: displaySet.dynamicVolumeInfo?.timePoints?.length || 0,
        });

        try {
          const studyInstanceUID = displaySet.StudyInstanceUID;
          const seriesInstanceUID = displaySet.SeriesInstanceUID;

          // Fetch saved frames from backend before creating labelmap
          let saved: Awaited<ReturnType<typeof loadSegFrames>> = [];
          try {
            if (studyInstanceUID && seriesInstanceUID) {
              updatePersistenceStatus(
                servicesManager,
                'loading',
                'Checking backend for saved segmentation...'
              );
              saved = await loadSegFrames(studyInstanceUID, seriesInstanceUID);
              logSegmentationTimeline('viewportVolumesChanged:backend-prefetch-done', {
                viewportId,
                studyInstanceUID,
                seriesInstanceUID,
                savedCount: saved.length,
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

          // Build merged label map and segment config from saved data
          const mergedLabelMap: Record<
            number,
            { labelId: string; labelName: string; labelColor: string; labelLocked?: boolean }
          > = {};
          const persistedSegmentationLabel =
            saved.find(frame => frame.segmentationLabel?.trim())?.segmentationLabel || undefined;
          for (const frame of saved) {
            if (frame.labelMap) Object.assign(mergedLabelMap, frame.labelMap);
          }
          const sortedSegIndices = Object.keys(mergedLabelMap)
            .map(Number)
            .sort((a, b) => a - b);
          const segmentsConfig: Record<number, { label: string; active: boolean; isLocked?: boolean }> = {};
          for (const idx of sortedSegIndices) {
            segmentsConfig[idx] = {
              label: mergedLabelMap[idx].labelName,
              active: idx === sortedSegIndices[0],
              isLocked: Boolean(mergedLabelMap[idx].labelLocked),
            };
          }

          // Pre-register the ID so SEGMENTATION_ADDED skips restoreFrames for this one
          const segmentationId = crypto.randomUUID();
          _autoRestoredSegmentationIds.add(segmentationId);

          let generatedId: string | undefined;
          try {
            generatedId = await segmentationService.createLabelmapForDisplaySet(displaySet, {
              segmentationId,
              label: persistedSegmentationLabel,
              segments: segmentsConfig, // {} → zero segments when no saved data
            });
            logSegmentationTimeline('viewportVolumesChanged:labelmap-created', {
              viewportId,
              segmentationId: generatedId,
            });
          } catch (err) {
            _autoRestoredSegmentationIds.delete(segmentationId);
            console.error('[segmentation-mode] createLabelmapForDisplaySet failed', err);
            return;
          }

          _restoreInProgressSegmentationIds.add(generatedId);
          _autosaveArmedSegmentationIds.delete(generatedId);

          try {
            await segmentationService.addSegmentationRepresentation(viewportId, {
              segmentationId: generatedId,
              type: toolEnums.SegmentationRepresentations.Labelmap,
            });
            logSegmentationTimeline('viewportVolumesChanged:representation-added', {
              viewportId,
              segmentationId: generatedId,
              hasDynamicSegmentation:
                segmentationService.hasDynamicSegmentation?.(generatedId) || false,
            });
          } catch (err) {
            console.error('[segmentation-mode] addSegmentationRepresentation failed', err);
            logSegmentationTimeline('viewportVolumesChanged:representation-add-failed', {
              viewportId,
              segmentationId: generatedId,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          if (!saved.length) {
            updatePersistenceStatus(
              servicesManager,
              'synced',
              'No saved segmentation found yet. New edits will autosave here.'
            );
            _restoreInProgressSegmentationIds.delete(generatedId);
            _autosaveArmedSegmentationIds.add(generatedId);
            logSegmentationTimeline('viewportVolumesChanged:no-backend-data', {
              segmentationId: generatedId,
              autosaveArmed: true,
            });
            return;
          }

          // Write restored pixel data into the images the renderer actually reads.
          // For volume viewports, handleVolumeViewport sets representationData.Labelmap.volumeId
          // to a derived volume whose .imageIds are the images that
          // updateTextureImagesUsingVoxelManager samples. For dynamic (4D) datasets these
          // are DIFFERENT from the per-frame images created by createAndCacheDerivedLabelmapImages,
          // so we must write into the volume's own images.
          const savedByKey = new Map(saved.map(f => [f.frameKey, f]));
          const modifiedIndices: number[] = [];
          const segState2 = segmentationService.getSegmentation(generatedId);
          const labelmapData2 = segState2?.representationData?.[
            toolEnums.SegmentationRepresentations.Labelmap
          ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;
          const { imageIds: labelmapImageIds2, referencedImageIds: referencedImageIds2 } =
            getSanitizedLabelmapFrames(labelmapData2);

          const restoredTimePoints = segmentationService.restoreDynamicSegmentationTimePointBuffers?.(
            generatedId,
            referencedImageIds2,
            savedByKey
          );
          logSegmentationTimeline('viewportVolumesChanged:restore-attempted', {
            segmentationId: generatedId,
            referencedImageCount: referencedImageIds2.length,
            restoredTimePoints,
            hasDynamicSegmentation:
              segmentationService.hasDynamicSegmentation?.(generatedId) || false,
          });

          if (segmentationService.hasDynamicSegmentation?.(generatedId)) {
            if (restoredTimePoints?.length) {
              console.debug('[segmentation-mode] autoCreate:applied-timepoints', {
                segmentationId: generatedId,
                timePoints: restoredTimePoints,
              });
            }
          } else {
            const csSeg = cstSegmentation.state.getSegmentation(generatedId);
            const restoreVolumeId = (csSeg?.representationData?.Labelmap as any)?.volumeId;
            const restoreVolume = restoreVolumeId ? cache.getVolume(restoreVolumeId) : null;

            if (restoreVolume) {
              modifiedIndices.push(
                ...applySavedFramesToLabelmapVolume(
                  restoreVolume,
                  savedByKey,
                  generatedId,
                  'autoCreate'
                )
              );
            } else {
              // Stack-viewport fallback: write into per-frame derived images.
              for (let i = 0; i < labelmapImageIds2.length; i++) {
                const referencedImageId = referencedImageIds2[i];
                if (!referencedImageId) continue;
                const stableFrameKey = getStableFrameKey(referencedImageId) || referencedImageId;
                const frame =
                  savedByKey.get(stableFrameKey) || savedByKey.get(referencedImageId);
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

          // Set segment colors after representation is registered
          for (const idx of sortedSegIndices) {
            const entry = mergedLabelMap[idx];
            try {
              segmentationService.setSegmentColor(
                viewportId,
                generatedId,
                idx,
                hexToRgba(entry.labelColor || '#FFFFFF')
              );
            } catch {
              // best-effort
            }
          }

          if (modifiedIndices.length) {
            // Do NOT pass modifiedIndices — see restoreFrames for the full explanation.
            cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(generatedId);
            updatePersistenceStatus(
              servicesManager,
              'synced',
              `Loaded ${modifiedIndices.length} saved segmentation frame${
                modifiedIndices.length === 1 ? '' : 's'
              } from backend.`
            );
          } else if (restoredTimePoints?.length) {
            cstSegmentation.triggerSegmentationEvents.triggerSegmentationDataModified(generatedId);
            updatePersistenceStatus(
              servicesManager,
              'synced',
              `Loaded saved segmentation for ${restoredTimePoints.length} timepoint${
                restoredTimePoints.length === 1 ? '' : 's'
              } from backend.`
            );
          } else {
            updatePersistenceStatus(
              servicesManager,
              'synced',
              'Saved segmentation metadata loaded. No pixels were restored into the active view.'
            );
          }
          _restoreInProgressSegmentationIds.delete(generatedId);
          _autosaveArmedSegmentationIds.add(generatedId);
          logSegmentationTimeline('viewportVolumesChanged:init-finished', {
            segmentationId: generatedId,
            autosaveArmed: true,
            modifiedIndices,
            restoredTimePoints,
          });
          _autoCreateDoneDisplaySetUIDs.add(displaySetInstanceUID);
        } finally {
          _autoCreateInProgressDisplaySetUIDs.delete(displaySetInstanceUID);
        }
      };

      const { unsubscribe: unsubViewportVolumes } = cornerstoneViewportService.subscribe(
        cornerstoneViewportService.EVENTS.VIEWPORT_VOLUMES_CHANGED,
        () => {
          void tryAutoCreateSegmentationFromBackend();
        }
      );
      const { unsubscribe: unsubViewportData } = cornerstoneViewportService.subscribe(
        cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
        () => {
          void tryAutoCreateSegmentationFromBackend();
        }
      );
      const { unsubscribe: unsubActiveViewport } = viewportGridService.subscribe(
        viewportGridService.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED,
        () => {
          void tryAutoCreateSegmentationFromBackend();
        }
      );
      _unsubscribeViewportDataChanged = () => {
        unsubViewportVolumes();
        unsubViewportData();
        unsubActiveViewport();
      };
      void tryAutoCreateSegmentationFromBackend();

      _onKeyDown = (evt: KeyboardEvent) => {
        const isSaveShortcut = (evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 's';
        if (!isSaveShortcut) {
          return;
        }

        evt.preventDefault();

        const segmentationId = getManualSaveSegmentationId(servicesManager);
        if (!segmentationId) {
          uiNotificationService?.show?.({
            title: 'Segmentation Save',
            message: 'No active segmentation is available to save.',
            type: 'warning',
          });
          return;
        }

        const existing = _saveDebounceTimers.get(segmentationId);
        if (existing) {
          clearTimeout(existing);
          _saveDebounceTimers.delete(segmentationId);
        }

        void saveAllFrames(segmentationId, servicesManager, 'all-timepoints')
          .then(() => {})
          .catch(error => {
            console.error('[segmentation-mode] manualSave:error', {
              segmentationId,
              error,
            });
            uiNotificationService?.show?.({
              title: 'Segmentation Save Failed',
              message: error instanceof Error ? error.message : 'Failed to save segmentation mask.',
              type: 'error',
            });
          });
      };

      window.addEventListener('keydown', _onKeyDown);
    },
    onModeExit: ({ servicesManager }: withAppTypes) => {
      const {
        toolGroupService,
        syncGroupService,
        segmentationService,
        cornerstoneViewportService,
        uiDialogService,
        uiModalService,
      } = servicesManager.services;

      _unsubscribeSegmentModified?.();
      _unsubscribeSegmentModified = null;

      if (_onContourCompleted) {
        eventTarget.removeEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);
        _onContourCompleted = null;
      }

      _unsubscribeSegmentDataModified?.();
      _unsubscribeSegmentDataModified = null;
      _unsubscribeSegmentationModifiedAutosave?.();
      _unsubscribeSegmentationModifiedAutosave = null;
      _unsubscribeSegmentationRepresentationModifiedAutosave?.();
      _unsubscribeSegmentationRepresentationModifiedAutosave = null;
      _unsubscribeSegmentationAdded?.();
      _unsubscribeSegmentationAdded = null;
      _unsubscribeViewportDataChanged?.();
      _unsubscribeViewportDataChanged = null;
      _autoRestoredSegmentationIds.clear();
      _restoreInProgressSegmentationIds.clear();
      _autosaveArmedSegmentationIds.clear();
      if (_onKeyDown) {
        window.removeEventListener('keydown', _onKeyDown);
        _onKeyDown = null;
      }
      _saveDebounceTimers.forEach(t => clearTimeout(t));
      _saveDebounceTimers.clear();

      uiDialogService.hideAll();
      uiModalService.hide();
      toolGroupService.destroy();
      syncGroupService.destroy();
      segmentationService.destroy();
      cornerstoneViewportService.destroy();
    },
    /** */
    validationTags: {
      study: [],
      series: [],
    },
    /**
     * A boolean return value that indicates whether the mode is valid for the
     * modalities of the selected studies. Currently we don't have stack viewport
     * segmentations and we should exclude them
     */
    isValidMode: ({ modalities }) => {
      // Don't show the mode if the selected studies have only one modality
      // that is not supported by the mode
      const modalitiesArray = modalities.split('\\');
      return {
        valid:
          modalitiesArray.length === 1
            ? !['SM', 'ECG', 'OT', 'DOC'].includes(modalitiesArray[0])
            : true,
        description:
          'The mode does not support studies that ONLY include the following modalities: SM, OT, DOC',
      };
    },
    /**
     * Mode Routes are used to define the mode's behavior. A list of Mode Route
     * that includes the mode's path and the layout to be used. The layout will
     * include the components that are used in the layout. For instance, if the
     * default layoutTemplate is used (id: '@ohif/extension-default.layoutTemplateModule.viewerLayout')
     * it will include the leftPanels, rightPanels, and viewports. However, if
     * you define another layoutTemplate that includes a Footer for instance,
     * you should provide the Footer component here too. Note: We use Strings
     * to reference the component's ID as they are registered in the internal
     * ExtensionManager. The template for the string is:
     * `${extensionId}.{moduleType}.${componentId}`.
     */
    routes: [
      {
        path: 'template',
        layoutTemplate: ({ location, servicesManager }) => {
          return {
            id: ohif.layout,
            props: {
              leftPanels: [ohif.leftPanel],
              leftPanelResizable: true,
              rightPanels: [
                cornerstone.panelTool,
                cornerstone.measurements,
              ],
              rightPanelResizable: true,
              // leftPanelClosed: true,
              viewports: [
                {
                  namespace: cornerstone.viewport,
                  displaySetsToDisplay: [ohif.sopClassHandler],
                },
                {
                  namespace: segmentation.viewport,
                  displaySetsToDisplay: [segmentation.sopClassHandler],
                },
                {
                  namespace: dicomRT.viewport,
                  displaySetsToDisplay: [dicomRT.sopClassHandler],
                },
              ],
            },
          };
        },
      },
    ],
    /** List of extensions that are used by the mode */
    extensions: extensionDependencies,
    /** HangingProtocol used by the mode */
    // Commented out to just use the most applicable registered hanging protocol
    // The example is used for a grid layout to specify that as a preferred layout
    hangingProtocol: ['@ohif/mnGrid'],
    /** SopClassHandlers used by the mode */
    sopClassHandlers: [ohif.sopClassHandler, segmentation.sopClassHandler, dicomRT.sopClassHandler],
  };
}

const mode = {
  id,
  modeFactory,
  extensionDependencies,
};

export default mode;
