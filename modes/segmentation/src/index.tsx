import { eventTarget, cache } from '@cornerstonejs/core';
import {
  annotation,
  Enums as toolEnums,
  segmentation as cstSegmentation,
} from '@cornerstonejs/tools';
import { id } from './id';
import toolbarButtons from './toolbarButtons';
import initToolGroups from './initToolGroups';
import { syncManualContourColor } from './syncManualContourColor';
import { writeContourToOhifLabelmap } from './writeContourToOhifLabelmap';
import { hexToRgba255 } from '../../../extensions/ovi-labs/src/utils/colorUtils';
import {
  notifySegmentationPersistenceError,
  updatePersistenceStatus,
  logSegmentationTimeline,
  saveAllFrames,
  getManualSaveSegmentationId,
  restoreFrames,
  tryAutoCreateSegmentationFromBackend,
  segLoadLog,
  snapshotSegState,
  getSegStudySeries,
  deleteAllSegFrames,
  type SaveOptions,
  type SaveScope,
} from './segmentationPersistenceOps';
import {
  setPhase,
  getPhase,
  canAutosave,
  markDirty,
  destroy as destroyAdapterSegmentation,
  destroyAll as destroyAdapterState,
} from '../../../medex/segmentation/src/services/SegmentationPersistenceAdapter';
import { resolveSliceIdentity } from '../../../medex/segmentation/src/utils/sliceIdentityResolver';
import { markSegmentationDeletedForDisplaySet } from '../../../medex/segmentation/src/persistence/deletedSegmentationMarkers';
import { deleteBoundSegmentationDocument } from '../../../medex/segmentation/src/persistence/segmentationContractClient';

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

function modeFactory({ modeConfiguration }) {
  let _unsubscribeSegmentModified: (() => void) | null = null;
  let _unsubscribeRepresentationColorSync: (() => void) | null = null;
  let _unsubscribeActiveSegmentColorSync: (() => void) | null = null;
  let _onContourCompleted: ((evt: Event) => void) | null = null;
  let _onContourModeChanged: ((evt: Event) => void) | null = null;
  let _unsubscribeSegmentDataModified: (() => void) | null = null;
  let _unsubscribeSegmentationModifiedAutosave: (() => void) | null = null;
  let _unsubscribeSegmentationRepresentationModifiedAutosave: (() => void) | null = null;
  let _unsubscribeSegmentationAdded: (() => void) | null = null;
  let _unsubscribeViewportDataChanged: (() => void) | null = null;
  let _unsubscribeSegmentationRemovedHandler: (() => void) | null = null;
  let _onKeyDown: ((evt: KeyboardEvent) => void) | null = null;
  // Pixel save debounce — driven by DATA_MODIFIED and SEGMENTATION_MODIFIED (add/delete/rename).
  const _saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const _saveDebounceOptions = new Map<string, Partial<SaveOptions>>();
  // Metadata save debounce — driven by REPRESENTATION_MODIFIED (color, visibility, lock).
  // Kept separate so representation events never reset the pixel-save timer, which was the
  // root cause of the HUD staying "Unsaved" indefinitely after a segment delete.
  const _metaDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const _segStudySeriesMap = new Map<string, { studyInstanceUID: string; seriesInstanceUID: string }>();
  // Tracks in-flight restore AbortControllers keyed by segmentationId.
  // When a SEGMENTATION_MODIFIED fires while a restore is in-flight (e.g., user deletes a
  // segment before restoreFrames finishes loading from backend), the controller is aborted so
  // that restoreFrames does not re-inject stale segment metadata.
  const _restoreAbortControllers = new Map<string, AbortController>();
  // Scoped diagnostic logger — no-op in production builds.
  const logDiag =
    process.env.NODE_ENV !== 'production'
      ? (msg: string, data?: unknown) => console.warn('[segmentation-diag]', msg, data)
      : (_msg: string, _data?: unknown) => {};

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
        'ManualContourEraser',
        'Brush',
        'Eraser',
        'Threshold',
      ]);

      const moveBrushPixelsToRenderSlice = (
        segmentationId: string,
        rawSlices: number[] | undefined,
        renderSlices: number[] | undefined,
        segmentIndex?: number
      ) => {
        const rawSlice = rawSlices?.[0];
        const renderSlice = renderSlices?.[0];
        if (
          rawSlice === undefined ||
          renderSlice === undefined ||
          rawSlice === renderSlice ||
          rawSlice < 0 ||
          renderSlice < 0
        ) {
          return false;
        }

        const segmentation = cstSegmentation.state.getSegmentation(segmentationId);
        const labelmapData = segmentation?.representationData?.[
          toolEnums.SegmentationRepresentations.Labelmap
        ] as any;
        const volumeId = labelmapData?.volumeId;
        const labelmapVolume = volumeId ? cache.getVolume(volumeId) : null;
        const dimensions =
          (labelmapVolume as any)?.dimensions ||
          (labelmapVolume as any)?.imageData?.getDimensions?.();
        const width = dimensions?.[0] || 0;
        const height = dimensions?.[1] || 0;
        const imageIds = (labelmapVolume as any)?.imageIds ?? labelmapData?.imageIds ?? [];
        const sampleImage = imageIds[0] ? cache.getImage(imageIds[0]) : null;
        const stackWidth = sampleImage?.columns ?? sampleImage?.width ?? 0;
        const stackHeight = sampleImage?.rows ?? sampleImage?.height ?? 0;
        const resolvedWidth = width || stackWidth;
        const resolvedHeight = height || stackHeight;
        const numberOfSlices = dimensions?.[2] || imageIds.length || 0;
        const sliceLength = resolvedWidth * resolvedHeight;
        const scalarData = (labelmapVolume as any)?.voxelManager?.getScalarData?.();
        const getImageScalarData = (imageId?: string) => {
          if (!imageId) {
            return undefined;
          }

          try {
            return cache.getImage(imageId)?.voxelManager?.getScalarData?.();
          } catch {
            return undefined;
          }
        };
        const rawImageScalarData = getImageScalarData(imageIds[rawSlice]);
        const renderImageScalarData = getImageScalarData(imageIds[renderSlice]);

        if (
          !sliceLength ||
          rawSlice >= numberOfSlices ||
          renderSlice >= numberOfSlices ||
          (!scalarData && (!rawImageScalarData || !renderImageScalarData))
        ) {
          return false;
        }

        const rawOffset = rawSlice * sliceLength;
        const renderOffset = renderSlice * sliceLength;
        let moved = false;
        let movedCount = 0;
        const readRawValue = (index: number) =>
          rawImageScalarData?.[index] ?? scalarData?.[rawOffset + index] ?? 0;

        for (let i = 0; i < sliceLength; i++) {
          const value = readRawValue(i);
          if (value === 0) {
            continue;
          }
          if (segmentIndex !== undefined && value !== segmentIndex) {
            continue;
          }

          if (renderImageScalarData) {
            renderImageScalarData[i] = value;
          }
          if (rawImageScalarData) {
            rawImageScalarData[i] = 0;
          }
          if (scalarData) {
            scalarData[renderOffset + i] = value;
            scalarData[rawOffset + i] = 0;
          }
          moved = true;
          movedCount += 1;
        }

        if (moved) {
          (labelmapVolume as any).imageData?.modified?.();
          (labelmapVolume as any).invalidate?.();
          logDiag('moved brush pixels', {
            segmentationId,
            segmentIndex,
            rawSlice,
            renderSlice,
            movedCount,
            volumeId,
          });
        } else {
          logDiag('no brush pixels moved', {
            segmentationId,
            segmentIndex,
            rawSlice,
            renderSlice,
            volumeId,
          });
        }

        return moved;
      };

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
          commandsManager.runCommand('setManualContourMode', { mode: 'draw' });
          commandsManager.runCommand('setToolActiveToolbar', { toolName: 'ManualContour' });
        }
      );
      _unsubscribeSegmentModified = unsubscribe;

      const { unsubscribe: unsubscribeRepresentationColorSync } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
        (data: any) => {
          const { segmentationId } = data || {};
          try {
            const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
            if (activeViewportId && segmentationId) {
              syncManualContourColor(activeViewportId, segmentationId, segmentationService);
            }
          } catch {
            // best-effort
          }
        }
      );
      _unsubscribeRepresentationColorSync = unsubscribeRepresentationColorSync;

      const { unsubscribe: unsubscribeActiveSegmentColorSync } = segmentationService.subscribe(
        segmentationService.EVENTS.ACTIVE_SEGMENT_MODIFIED,
        (data: any) => {
          const { segmentationId } = data || {};
          try {
            const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
            if (activeViewportId && segmentationId) {
              syncManualContourColor(activeViewportId, segmentationId, segmentationService);
            }
          } catch {
            // best-effort
          }
        }
      );
      _unsubscribeActiveSegmentColorSync = unsubscribeActiveSegmentColorSync;

      // Re-sync color when draw/erase mode switches so the cursor turns white in erase mode
      _onContourModeChanged = () => {
        try {
          const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
          const activeSegmentation = segmentationService.getActiveSegmentation?.(activeViewportId);
          const segmentationId =
            activeSegmentation?.id || activeSegmentation?.segmentationId;
          if (activeViewportId && segmentationId) {
            syncManualContourColor(activeViewportId, segmentationId, segmentationService);
          }
        } catch {
          // best-effort
        }
      };
      window.addEventListener('medex:manual-contour-mode-changed', _onContourModeChanged);

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

        logDiag('tool:contour', {
          eventReferencedImageId: referencedImageId,
          pointCount: worldPolyline.length,
        });

        void writeContourToOhifLabelmap({
          servicesManager,
          viewportId: activeViewportId,
          referencedImageId,
          worldPolyline,
          mode:
            typeof window !== 'undefined' && (window as any).__medexManualContourMode === 'erase'
              ? 'erase'
              : 'draw',
        }).then(result => {
          if (result) {
            annotation.state.removeAnnotation(completedAnnotation.annotationUID);
          }
        });
      };

      eventTarget.addEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);

      if (typeof window !== 'undefined') {
        (window as any).__medexSegmentationTestApi = {
          completeManualContour: ({
            viewportId,
            referencedImageId,
            worldPolyline,
            mode,
          }: {
            viewportId?: string;
            referencedImageId: string;
            worldPolyline: number[][];
            mode?: 'draw' | 'erase';
          }) => {
            const activeViewportId =
              viewportId || viewportGridService?.getState?.()?.activeViewportId;
            if (!activeViewportId) {
              return Promise.resolve(null);
            }

            return writeContourToOhifLabelmap({
              servicesManager,
              viewportId: activeViewportId,
              referencedImageId,
              worldPolyline,
              mode: mode === 'erase' ? 'erase' : 'draw',
            });
          },
          saveActiveSegmentation: async () => {
            const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
            const activeSegmentation = activeViewportId
              ? segmentationService?.getActiveSegmentation?.(activeViewportId)
              : null;
            const segmentationId = activeSegmentation?.segmentationId || activeSegmentation?.id;
            if (!segmentationId) {
              return null;
            }

            await saveAllFrames(segmentationId, servicesManager, 'all-timepoints', {
              deleteEmptyFrames: false,
              writeEmptyPlaceholder: false,
            });
            return segmentationId;
          },
        };
      }

      const scheduleAutosave = (
        segmentationId: string,
        saveScope: SaveScope,
        reason: string,
        saveOptions: Partial<SaveOptions> = {}
      ) => {
        if (!canAutosave(segmentationId)) {
          logSegmentationTimeline('autosave:ignored', {
            segmentationId,
            reason,
            phase: getPhase(segmentationId),
          });
          return;
        }

        logSegmentationTimeline('autosave:scheduled', {
          segmentationId,
          reason,
          saveScope,
          modifiedSlicesToUse: saveOptions.modifiedSlicesToUse,
        });
        logDiag('autosave scheduled', {
          segmentationId,
          reason,
          saveScope,
          modifiedSlicesToUse: saveOptions.modifiedSlicesToUse,
        });
        updatePersistenceStatus(
          servicesManager,
          'dirty',
          'Unsaved segmentation changes. Saving will start automatically.'
        );

        const pendingOptions = _saveDebounceOptions.get(segmentationId);
        const mergedModifiedSlices = Array.from(
          new Set([
            ...(pendingOptions?.modifiedSlicesToUse ?? []),
            ...(saveOptions.modifiedSlicesToUse ?? []),
          ])
        );
        _saveDebounceOptions.set(segmentationId, {
          ...pendingOptions,
          ...saveOptions,
          ...(mergedModifiedSlices.length ? { modifiedSlicesToUse: mergedModifiedSlices } : {}),
        });

        const existing = _saveDebounceTimers.get(segmentationId);
        if (existing) {
          clearTimeout(existing);
        }

        _saveDebounceTimers.set(
          segmentationId,
          setTimeout(() => {
            _saveDebounceTimers.delete(segmentationId);
            if (!canAutosave(segmentationId)) {
              _saveDebounceOptions.delete(segmentationId);
              logSegmentationTimeline('autosave:debounce-ignored', {
                segmentationId,
                reason,
                saveScope,
                phase: getPhase(segmentationId),
              });
              return;
            }
            logSegmentationTimeline('autosave:debounce-fired', {
              segmentationId,
              reason,
              saveScope,
            });
            const pendingSaveOptions = _saveDebounceOptions.get(segmentationId) ?? {};
            _saveDebounceOptions.delete(segmentationId);
            logDiag('autosave fired', {
              segmentationId,
              reason,
              saveScope,
              modifiedSlicesToUse: pendingSaveOptions.modifiedSlicesToUse,
            });
            void saveAllFrames(segmentationId, servicesManager, saveScope, {
              deleteEmptyFrames: false,
              writeEmptyPlaceholder: false,
              ...pendingSaveOptions,
            }).catch(error => {
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
          }, 1500)
        );
      };

      // Metadata-only save debounce: re-saves labelMap on existing backend frames without
      // touching pixel data. Uses its own timer so it never resets the pixel-save debounce.
      const scheduleMetadataSave = (segmentationId: string) => {
        if (!canAutosave(segmentationId)) return;

        // Only update the HUD to dirty if there is no pixel save already in flight —
        // if the pixel save is pending, it will handle the dirty→synced transition.
        if (!_saveDebounceTimers.has(segmentationId)) {
          updatePersistenceStatus(
            servicesManager,
            'dirty',
            'Unsaved segmentation changes. Saving will start automatically.'
          );
        }

        const existing = _metaDebounceTimers.get(segmentationId);
        if (existing) clearTimeout(existing);

        _metaDebounceTimers.set(
          segmentationId,
          setTimeout(() => {
            _metaDebounceTimers.delete(segmentationId);
            if (!canAutosave(segmentationId)) return;
            // Skip if a pixel save is about to fire — it will carry the updated labelMap.
            if (_saveDebounceTimers.has(segmentationId)) return;
            logSegmentationTimeline('autosave:metadata-debounce-fired', { segmentationId });
            void saveAllFrames(segmentationId, servicesManager, 'all-timepoints', {
              deleteEmptyFrames: false,
              writeEmptyPlaceholder: false,
            }).catch(error => {
              console.error('[segmentation-mode] metadata-autosave:error', { segmentationId, error });
              updatePersistenceStatus(
                servicesManager,
                'error',
                error instanceof Error ? error.message : 'Failed to save segmentation changes to backend.'
              );
            });
          }, 1500)
        );
      };

      // Persist labelmap pixel data whenever a brush stroke modifies it
      const { unsubscribe: unsubDataModified } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
        ({
          segmentationId,
          modifiedSlicesToUse,
          segmentIndex,
        }: {
          segmentationId: string;
          modifiedSlicesToUse?: number[];
          segmentIndex?: number;
        }) => {
          const viewportId = viewportGridService.getState().activeViewportId;
          const identity = viewportId
            ? resolveSliceIdentity(viewportId, segmentationId, {
                cornerstoneViewportService,
                viewportGridService,
                displaySetService,
              })
            : null;
          const k = identity?.k ?? -1;
          const rendererModifiedSlices = k >= 0 ? [k] : modifiedSlicesToUse;
          const movedBrushPixels = moveBrushPixelsToRenderSlice(
            segmentationId,
            modifiedSlicesToUse,
            rendererModifiedSlices,
            segmentIndex
          );

          if (identity) {
            markDirty(segmentationId, identity.timePointIndex);
          }

          logDiag('tool:brush-or-eraser', {
            viewportId,
            frameKey: identity?.frameKey,
            displaySetIndex: identity?.displaySetIndex,
            k,
            segmentationId,
            segmentIndex,
            modifiedSlicesToUse,
            rendererModifiedSlices,
            movedBrushPixels,
          });

          scheduleAutosave(segmentationId, 'current-timepoint', 'data-modified', {
            modifiedSlicesToUse: rendererModifiedSlices,
          });
        }
      );
      _unsubscribeSegmentDataModified = unsubDataModified;

      const { unsubscribe: unsubSegModifiedAutosave } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        ({ segmentationId }: { segmentationId: string }) => {
          const segmentation = segmentationService.getSegmentation(segmentationId);
          if (!segmentation) {
            logSegmentationTimeline('segmentation-modified:skip-autosave-removed', {
              segmentationId,
            });
            return;
          }
          // If a restore is in-flight for this segmentation (user modified state before
          // restoreFrames finished loading), abort the restore so it does not re-inject
          // stale backend segment metadata over the user's current in-memory state.
          const existingController = _restoreAbortControllers.get(segmentationId);
          if (existingController) {
            logSegmentationTimeline('segmentation-modified:aborting-in-flight-restore', {
              segmentationId,
            });
            existingController.abort();
            _restoreAbortControllers.delete(segmentationId);
          }
          // Lazily cache the study/series so the whole-seg-removed handler can
          // still look it up after the segmentation has been destroyed.
          if (!_segStudySeriesMap.has(segmentationId)) {
            const ids = getSegStudySeries(segmentationId, servicesManager);
            if (ids) {
              _segStudySeriesMap.set(segmentationId, ids);
            }
          }
          scheduleAutosave(segmentationId, 'all-timepoints', 'segmentation-modified', {
            deleteEmptyFrames: true,
          });
        }
      );
      _unsubscribeSegmentationModifiedAutosave = unsubSegModifiedAutosave;

      // Handle whole-segmentation removal: when SEGMENTATION_MODIFIED fires but
      // the segmentation is gone, delete all its backend frames.
      const { unsubscribe: unsubSegRemovedHandler } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        ({ segmentationId }: { segmentationId: string }) => {
          if (segmentationService.getSegmentation(segmentationId) != null) {
            return; // still alive — the autosave subscriber handles it
          }
          const existingTimer = _saveDebounceTimers.get(segmentationId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            _saveDebounceTimers.delete(segmentationId);
          }
          const existingMetaTimer = _metaDebounceTimers.get(segmentationId);
          if (existingMetaTimer) {
            clearTimeout(existingMetaTimer);
            _metaDebounceTimers.delete(segmentationId);
          }
          _saveDebounceOptions.delete(segmentationId);

          const ids = _segStudySeriesMap.get(segmentationId);
          if (!ids) {
            updatePersistenceStatus(servicesManager, 'synced', 'Segmentation deleted.');
            destroyAdapterSegmentation(segmentationId);
            return; // no study/series recorded — nothing to clean up
          }
          const { studyInstanceUID, seriesInstanceUID } = ids;
          markSegmentationDeletedForDisplaySet(ids);
          logSegmentationTimeline('segmentation-removed:delete-all-frames', {
            segmentationId,
            studyInstanceUID,
            seriesInstanceUID,
            displaySetInstanceUID: ids.displaySetInstanceUID,
          });
          updatePersistenceStatus(
            servicesManager,
            'dirty',
            'Unsaved segmentation changes. Saving will start automatically.'
          );
          void Promise.allSettled([
            deleteAllSegFrames(studyInstanceUID, seriesInstanceUID),
            deleteBoundSegmentationDocument(segmentationId),
          ])
            .then(() => {
              updatePersistenceStatus(servicesManager, 'synced', 'Segmentation deleted.');
              _segStudySeriesMap.delete(segmentationId);
              destroyAdapterSegmentation(segmentationId);
            })
            .catch(error => {
              console.error('[segmentation-mode] segmentation-removed:delete-all-frames:error', {
                segmentationId,
                error,
              });
              updatePersistenceStatus(
                servicesManager,
                'error',
                error instanceof Error ? error.message : 'Failed to delete segmentation from backend.'
              );
            });
        }
      );
      _unsubscribeSegmentationRemovedHandler = unsubSegRemovedHandler;

      const { unsubscribe: unsubSegRepresentationModifiedAutosave } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
        ({ segmentationId }: { segmentationId: string }) => {
          // Use the separate metadata debounce so representation events (color, visibility, lock)
          // do NOT reset the pixel-save debounce timer.
          scheduleMetadataSave(segmentationId);
        }
      );
      _unsubscribeSegmentationRepresentationModifiedAutosave =
        unsubSegRepresentationModifiedAutosave;

      // Restore previously saved frames whenever a new segmentation is created
      const { unsubscribe: unsubSegAdded } = segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_ADDED,
        ({ segmentationId }: { segmentationId: string }) => {
          const currentPhase = getPhase(segmentationId);
          if (!_segStudySeriesMap.has(segmentationId)) {
            const ids = getSegStudySeries(segmentationId, servicesManager);
            if (ids) {
              _segStudySeriesMap.set(segmentationId, ids);
            }
          }
          segLoadLog('SEGMENTATION_ADDED:fired', {
            segmentationId,
            ...snapshotSegState(segmentationService, segmentationId),
          });
          if (currentPhase === 'armed') {
            segLoadLog('SEGMENTATION_ADDED:skip-already-armed', { segmentationId });
            return;
          }
          if (currentPhase === 'restoring' || currentPhase === 'creating') {
            segLoadLog('SEGMENTATION_ADDED:skip-autoCreate-owns-restore', {
              segmentationId,
              currentPhase,
            });
            return;
          }
          segLoadLog('SEGMENTATION_ADDED:proceeding-with-restoreFrames', {
            segmentationId,
            currentPhase,
          });
          setPhase(segmentationId, 'restoring');
          logSegmentationTimeline('segmentationAdded:begin-restore', {
            segmentationId,
          });
          const restoreAbortController = new AbortController();
          _restoreAbortControllers.set(segmentationId, restoreAbortController);
          void restoreFrames(segmentationId, servicesManager, restoreAbortController.signal)
            .catch(error => {
              setPhase(segmentationId, 'error');
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
              _restoreAbortControllers.delete(segmentationId);
              const phaseBeforeArm = getPhase(segmentationId);
              if (phaseBeforeArm === 'restoring') {
                setPhase(segmentationId, 'armed');
              }
              segLoadLog('SEGMENTATION_ADDED:restoreFrames-finally', {
                segmentationId,
                phaseBeforeArm,
                phaseAfter: getPhase(segmentationId),
                ...snapshotSegState(segmentationService, segmentationId),
              });
              logSegmentationTimeline('segmentationAdded:restore-finished', {
                segmentationId,
                phase: getPhase(segmentationId),
              });
            });
        }
      );
      _unsubscribeSegmentationAdded = unsubSegAdded;

      // Auto-create a labelmap once a viewport has usable display-set data.
      // We scan the current grid instead of depending only on the active viewport,
      // because initial layout mount can happen before a click establishes one.
      const _tryAutoCreateForViewport = (viewportId: string) =>
        tryAutoCreateSegmentationFromBackend(viewportId, servicesManager);

      const { unsubscribe: unsubViewportData } = cornerstoneViewportService.subscribe(
        cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
        (event: any) => {
          logSegmentationTimeline('event:viewport-data-changed', event);
          const viewportId = event?.viewportId ?? event?.detail?.viewportId;
          segLoadLog('VIEWPORT_DATA_CHANGED:fired', { viewportId });
          if (viewportId) {
            void _tryAutoCreateForViewport(viewportId);
          }
        }
      );
      _unsubscribeViewportDataChanged = unsubViewportData;

      const { viewports: initialViewports } = viewportGridService.getState();
      for (const [viewportId] of initialViewports ?? []) {
        void _tryAutoCreateForViewport(viewportId);
      }

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
        _saveDebounceOptions.delete(segmentationId);
        const existingMeta = _metaDebounceTimers.get(segmentationId);
        if (existingMeta) {
          clearTimeout(existingMeta);
          _metaDebounceTimers.delete(segmentationId);
        }

        logDiag('manual full save fired', {
          segmentationId,
          saveScope: 'all-timepoints',
        });
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
      _unsubscribeRepresentationColorSync?.();
      _unsubscribeRepresentationColorSync = null;
      _unsubscribeActiveSegmentColorSync?.();
      _unsubscribeActiveSegmentColorSync = null;

      if (_onContourCompleted) {
        eventTarget.removeEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);
        _onContourCompleted = null;
      }
      if (_onContourModeChanged) {
        window.removeEventListener('medex:manual-contour-mode-changed', _onContourModeChanged);
        _onContourModeChanged = null;
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
      _unsubscribeSegmentationRemovedHandler?.();
      _unsubscribeSegmentationRemovedHandler = null;
      destroyAdapterState();
      if (_onKeyDown) {
        window.removeEventListener('keydown', _onKeyDown);
        _onKeyDown = null;
      }
      if (typeof window !== 'undefined') {
        delete (window as any).__medexSegmentationTestApi;
      }
      _saveDebounceTimers.forEach(t => clearTimeout(t));
      _saveDebounceTimers.clear();
      _saveDebounceOptions.clear();
      _metaDebounceTimers.forEach(t => clearTimeout(t));
      _metaDebounceTimers.clear();
      _segStudySeriesMap.clear();
      // Abort and clear any in-flight restores so they don't race with mode teardown.
      _restoreAbortControllers.forEach(controller => controller.abort());
      _restoreAbortControllers.clear();

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
                oviLabs.segmentationExportPanel,
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
