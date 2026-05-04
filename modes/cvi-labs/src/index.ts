import { eventTarget } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums, utilities } from '@cornerstonejs/tools';
import {
  initSegmentationToolGroups as initToolGroups,
  ManualContourLabelMenu,
  setupRotatableRectangleROIBehavior,
  segmentationToolbarButtons as toolbarButtons,
  syncManualContourColor,
  writeContourToOhifLabelmap,
} from '@medex/segmentation';
import { setSegmentationPersistenceStatus } from '../../../extensions/cornerstone/src/utils/segmentationPersistenceStatus';
import { saveAllFrames } from '../../segmentation/src/segmentationPersistenceOps';
import { ensureCviSegmentationForViewport } from '../../../specialties/cvi-labs/src/utils/cviSegmentation';
import { CVI_LABELS } from '../../../specialties/cvi-labs/src/stores/cviLabsSegmentationStore';

const id = '@ohif/mode-cvi-labs';

const DEFAULT_BRUSH_SIZE_MM = 3;
const BRUSH_SIZE_MIN_MM = 0.5;
const BRUSH_SIZE_MAX_MM = 99.5;
const TOOL_GROUP_ID = 'default';
const MANUAL_CONTOUR_TOOL_NAME = 'ManualContour';
const BRUSH_TOOL_NAMES = ['CircularBrush', 'CircularEraser'];
const CVI_ACTIVE_LABEL_EVENT = 'cvi-set-active-label';
const ERASER_LABEL_ID = 'eraser';
const ERASER_LABEL_COLOR = '#FFFFFF';

const { segmentation: segmentationUtils } = utilities as typeof utilities & {
  segmentation?: {
    getBrushSizeForToolGroup?: (toolGroupId: string) => number;
  };
};

const setGlobalActiveManualContourLabelId = (labelId: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  (window as Window & { __oviActiveManualContourLabelId?: string }).__oviActiveManualContourLabelId =
    labelId;
};

const setGlobalActiveManualContourColor = (color: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  (window as Window & { __oviActiveManualContourColor?: string }).__oviActiveManualContourColor = color;
};

const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  leftPanel: '@ohif/extension-default.panelModule.seriesList',
};

const cornerstone = {
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
};

const cviLabsPanels = {
  cardiacViewer: '@medex/cvi-labs.panelModule.cardiacViewer',
  segmentation: '@medex/cvi-labs.panelModule.segmentation',
};

const extensionDependencies = {
  '@ohif/extension-default': '3.11.0-beta.11',
  '@ohif/extension-cornerstone': '3.11.0-beta.11',
  '@ohif/extension-cornerstone-dicom-seg': '3.11.0-beta.11',
  '@ohif/extension-cornerstone-dicom-rt': '3.11.0-beta.11',
  '@medex/cvi-labs': '*',
};

function modeFactory() {
  let _unsubscribeViewportDataChanged: (() => void) | null = null;
  let _segmentationSubscriptions: Array<{ unsubscribe?: () => void }> = [];
  let _displaySetSubscriptions: Array<{ unsubscribe?: () => void }> = [];
  let _onContourCompleted: ((evt: Event) => void) | null = null;
  let _onToolActivated: ((evt: Event) => void) | null = null;
  let _onKeyDown: ((evt: KeyboardEvent) => void) | null = null;
  let _teardownRotatableRectangleROIBehavior: (() => void) | null = null;
  const _saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let _activeManualContourLabelId = CVI_LABELS[0].id;
  let _lastNonEraserManualContourLabelId = CVI_LABELS[0].id;
  let _currentBrushSize = DEFAULT_BRUSH_SIZE_MM;

  return {
    id,
    routeName: 'cvi-labs',
    displayName: 'Cvi Labs',

    onModeEnter: ({ servicesManager, extensionManager, commandsManager }: withAppTypes) => {
      const {
        toolbarService,
        toolGroupService,
        cornerstoneViewportService,
        viewportGridService,
        segmentationService,
        displaySetService,
        uiDialogService,
        uiModalService,
      } = servicesManager.services;

      const clampBrushSize = (value: number) =>
        Math.min(BRUSH_SIZE_MAX_MM, Math.max(BRUSH_SIZE_MIN_MM, Number(value) || DEFAULT_BRUSH_SIZE_MM));

      const getBrushSize = () => {
        const brushSize = segmentationUtils?.getBrushSizeForToolGroup?.(TOOL_GROUP_ID);
        if (typeof brushSize === 'number' && !Number.isNaN(brushSize)) {
          _currentBrushSize = clampBrushSize(brushSize);
        }

        return _currentBrushSize;
      };

      const setBrushSize = (value: number) => {
        const brushSize = clampBrushSize(value);
        _currentBrushSize = brushSize;
        commandsManager.runCommand('setBrushSize', {
          value: brushSize,
          toolNames: BRUSH_TOOL_NAMES,
        });
      };

      const getManualContourMenuPosition = (sourceToolName = MANUAL_CONTOUR_TOOL_NAME) => {
        if (typeof window === 'undefined') {
          return undefined;
        }

        const panelWidth = 240;
        const margin = 16;
        const toolButton =
          window.document?.querySelector(`[data-tool="${sourceToolName}"]`) ||
          window.document?.querySelector(`[data-tool="Brush"]`) ||
          window.document?.querySelector(`[data-tool="${MANUAL_CONTOUR_TOOL_NAME}"]`);

        if (toolButton instanceof HTMLElement) {
          const rect = toolButton.getBoundingClientRect();
          const x = Math.min(
            window.innerWidth - panelWidth - margin,
            Math.max(margin, rect.left + rect.width / 2 - panelWidth / 2)
          );
          const y = Math.min(window.innerHeight - margin, rect.bottom + 8);
          return { x, y };
        }

        return {
          x: Math.max(margin, window.innerWidth - panelWidth - margin),
          y: 96,
        };
      };

      const updateActiveCviLabel = async (labelId: string, sourceToolName = MANUAL_CONTOUR_TOOL_NAME) => {
        const isEraser = labelId === ERASER_LABEL_ID;
        const label = CVI_LABELS.find(item => item.id === labelId) || CVI_LABELS[0];
        const context = await ensureForViewport(viewportGridService?.getState?.()?.activeViewportId);
        const viewportId = context?.viewportId || viewportGridService?.getState?.()?.activeViewportId;
        const segmentationId = context?.segmentationId;

        _activeManualContourLabelId = isEraser ? ERASER_LABEL_ID : label.id;
        if (!isEraser) {
          _lastNonEraserManualContourLabelId = label.id;
        }

        commandsManager.runCommand('setManualContourMode', {
          mode: isEraser ? 'erase' : 'draw',
        });

        setGlobalActiveManualContourLabelId(isEraser ? _lastNonEraserManualContourLabelId : label.id);
        setGlobalActiveManualContourColor(isEraser ? ERASER_LABEL_COLOR : label.color);
        window?.dispatchEvent?.(
          new CustomEvent(CVI_ACTIVE_LABEL_EVENT, {
            detail: {
              labelId: isEraser ? ERASER_LABEL_ID : label.id,
              sourceToolName,
              _isFromTool: true,
            },
          })
        );

        if (!isEraser && viewportId && segmentationId) {
          segmentationService.setActiveSegmentation(viewportId, segmentationId);
          segmentationService.setActiveSegment(segmentationId, label.segmentIndex);
          syncManualContourColor(viewportId, segmentationId, segmentationService);
        }
      };

      const showManualContourLabelMenu = (sourceToolName = MANUAL_CONTOUR_TOOL_NAME) => {
        uiDialogService?.hide?.('manual-contour-label');
        uiDialogService?.show?.({
          id: 'manual-contour-label',
          title: '',
          content: ManualContourLabelMenu,
          unstyled: true,
          showOverlay: false,
          shouldCloseOnOverlayClick: true,
          shouldCloseOnEsc: true,
          containerClassName: 'shadow-none',
          defaultPosition: getManualContourMenuPosition(sourceToolName),
          contentProps: {
            labelData: CVI_LABELS.map(item => ({
              label: item.name,
              value: item.id,
              color: item.color,
            })),
            initialLabel:
              _activeManualContourLabelId === ERASER_LABEL_ID
                ? _lastNonEraserManualContourLabelId
                : _activeManualContourLabelId,
            brushSize: getBrushSize(),
            showBrushSizeControl: BRUSH_TOOL_NAMES.includes(sourceToolName),
            onBrushSizeChange: (value: number) => setBrushSize(value),
            onSelect: (value: string) => {
              if (!value) {
                return;
              }

              void updateActiveCviLabel(value, sourceToolName);
            },
          },
        });
      };

      uiDialogService?.hideAll?.();
      uiModalService?.hide?.();

      initToolGroups(extensionManager, toolGroupService, commandsManager);
      _teardownRotatableRectangleROIBehavior?.();
      _teardownRotatableRectangleROIBehavior = setupRotatableRectangleROIBehavior();
      commandsManager.runCommand('setBrushSize', {
        value: DEFAULT_BRUSH_SIZE_MM,
        toolNames: ['CircularBrush', 'CircularEraser'],
      });

      toolbarService.addButtons(toolbarButtons);
      toolbarService.createButtonSection('primary', [
        'DebugProbe',
        'measurementSection',
        'Zoom',
        'WindowLevel',
        'Pan',
        'Layout',
        'MoreTools',
        'Cine',
        'RotatableRectangleROI',
        'ContourTools',
        'BrushTools',
        'MaskContour',
      ]);
      toolbarService.createButtonSection('contourToolsSection', [
        'ManualContour',
        'ManualContourEraser',
      ]);
      toolbarService.createButtonSection('brushToolsSection', [
        'Brush',
        'Eraser',
      ]);
      toolbarService.createButtonSection('measurementSection', [
        'Length',
        'Bidirectional',
        'EllipticalROI',
        'RectangleROI',
        'CircleROI',
      ]);
      toolbarService.createButtonSection('moreToolsSection', [
        'Reset',
        'RotateRight',
        'FlipHorizontal',
        'StackScroll',
        'Invert',
        'CalibrationLine',
      ]);

      const scheduleAutosave = (segmentationId: string) => {
        const existing = _saveDebounceTimers.get(segmentationId);
        if (existing) {
          clearTimeout(existing);
        }

        _saveDebounceTimers.set(
          segmentationId,
          setTimeout(() => {
            _saveDebounceTimers.delete(segmentationId);
            void saveAllFrames(segmentationId, servicesManager, 'all-timepoints', {
              deleteEmptyFrames: false,
              writeEmptyPlaceholder: false,
            }).catch(error => {
              console.error('[cvi-labs] autosave:error', { segmentationId, error });
            });
          }, 1500)
        );
      };

      const markSegmentationDirty = (segmentationId: string) => {
        const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
        const activeSegmentation = activeViewportId
          ? segmentationService.getActiveSegmentation(activeViewportId)
          : null;

        if (!activeViewportId || !activeSegmentation) {
          return;
        }

        const activeSegmentationId = activeSegmentation.segmentationId || activeSegmentation.id;
        if (activeSegmentationId !== segmentationId) {
          return;
        }

        setSegmentationPersistenceStatus(activeViewportId, {
          kind: 'dirty',
          message: 'Segmentation has unsaved changes.',
        });
      };

      const ensureForViewport = async (viewportId?: string) => {
        return ensureCviSegmentationForViewport(servicesManager, viewportId);
      };

      void updateActiveCviLabel(_activeManualContourLabelId);

      const activeViewportId = viewportGridService?.getState?.()?.activeViewportId;
      void ensureForViewport(activeViewportId);
      window.setTimeout(() => {
        const retryViewportId = viewportGridService?.getState?.()?.activeViewportId;
        void ensureForViewport(retryViewportId);
      }, 250);
      window.setTimeout(() => {
        const retryViewportId = viewportGridService?.getState?.()?.activeViewportId;
        void ensureForViewport(retryViewportId);
      }, 1000);

      _unsubscribeViewportDataChanged = cornerstoneViewportService.subscribe(
        cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
        ({ viewportId }: { viewportId?: string }) => {
          void ensureForViewport(viewportId);
        }
      ).unsubscribe;

      if (displaySetService?.subscribe) {
        const ensureActiveViewportSegmentation = () => {
          const retryViewportId = viewportGridService?.getState?.()?.activeViewportId;
          void ensureForViewport(retryViewportId);
        };

        _displaySetSubscriptions = [
          displaySetService.subscribe(
            displaySetService.EVENTS.DISPLAY_SETS_CHANGED,
            ensureActiveViewportSegmentation
          ),
          displaySetService.subscribe(
            displaySetService.EVENTS.DISPLAY_SETS_ADDED,
            ensureActiveViewportSegmentation
          ),
        ];
      }

      _segmentationSubscriptions = [
        segmentationService.subscribe(
          segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
          ({ segmentationId }: { segmentationId: string }) => {
            if (segmentationId) {
              markSegmentationDirty(segmentationId);
              scheduleAutosave(segmentationId);
            }
          }
        ),
        segmentationService.subscribe(
          segmentationService.EVENTS.SEGMENTATION_MODIFIED,
          ({ segmentationId }: { segmentationId: string }) => {
            if (segmentationId) {
              markSegmentationDirty(segmentationId);
              scheduleAutosave(segmentationId);
            }
          }
        ),
      ];

      _onContourCompleted = (evt: Event) => {
        const completedAnnotation = (evt as CustomEvent).detail?.annotation;
        if (completedAnnotation?.metadata?.toolName !== 'ManualContour') {
          return;
        }

        const referencedImageId = completedAnnotation.metadata?.referencedImageId;
        const worldPolyline =
          completedAnnotation.data?.contour?.polyline || completedAnnotation.data?.handles?.points;
        const viewportId = viewportGridService?.getState?.()?.activeViewportId;
        if (!referencedImageId || !worldPolyline?.length || !viewportId) {
          return;
        }

        void ensureForViewport(viewportId)
          .then(() =>
            writeContourToOhifLabelmap({
              servicesManager,
              viewportId,
              referencedImageId,
              worldPolyline,
              mode:
                typeof window !== 'undefined' && (window as any).__medexManualContourMode === 'erase'
                  ? 'erase'
                  : 'draw',
            })
          )
          .then(result => {
            if (result) {
              annotation.state.removeAnnotation(completedAnnotation.annotationUID);
            }
          });
      };

      _onToolActivated = (evt: Event) => {
        const { toolGroupId, toolName } = (evt as CustomEvent).detail || {};
        if (toolGroupId !== TOOL_GROUP_ID) {
          return;
        }

        if (toolName === MANUAL_CONTOUR_TOOL_NAME) {
          const isEraseMode =
            typeof window !== 'undefined' &&
            (window as any).__medexManualContourMode === 'erase';
          if (!isEraseMode) {
            void updateActiveCviLabel(
              _activeManualContourLabelId,
              MANUAL_CONTOUR_TOOL_NAME
            ).then(() => {
              showManualContourLabelMenu(MANUAL_CONTOUR_TOOL_NAME);
            });
          }
          return;
        }

        if (BRUSH_TOOL_NAMES.includes(toolName)) {
          const labelId =
            toolName === 'CircularEraser' || _activeManualContourLabelId === ERASER_LABEL_ID
              ? _lastNonEraserManualContourLabelId
              : _activeManualContourLabelId;
          void updateActiveCviLabel(labelId, toolName).then(() => {
            showManualContourLabelMenu(toolName);
          });
          return;
        }

        uiDialogService?.hide?.('manual-contour-label');
      };

      eventTarget.addEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);
      eventTarget.addEventListener(toolEnums.Events.TOOL_ACTIVATED, _onToolActivated);

      if (typeof window !== 'undefined') {
        (window as any).__medexSegmentationTestApi = {
          completeManualContour: async ({
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
            const targetViewportId =
              viewportId || viewportGridService?.getState?.()?.activeViewportId;
            if (!targetViewportId) {
              return Promise.resolve(null);
            }

            await ensureForViewport(targetViewportId);

            return writeContourToOhifLabelmap({
              servicesManager,
              viewportId: targetViewportId,
              referencedImageId,
              worldPolyline,
              mode: mode === 'erase' ? 'erase' : 'draw',
            });
          },
          saveActiveSegmentation: async () => {
            const viewportId = viewportGridService?.getState?.()?.activeViewportId;
            const activeSegmentation = viewportId
              ? segmentationService?.getActiveSegmentation?.(viewportId)
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
          getActiveManualContourLabelId: () => _activeManualContourLabelId,
          getManualContourMode: () =>
            typeof window !== 'undefined' ? (window as any).__medexManualContourMode || 'draw' : 'draw',
        };
      }

      _onKeyDown = (evt: KeyboardEvent) => {
        const isSaveShortcut = (evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 's';
        if (!isSaveShortcut) {
          return;
        }

        evt.preventDefault();
        const viewportId = viewportGridService?.getState?.()?.activeViewportId;
        const activeSegmentation = viewportId
          ? segmentationService?.getActiveSegmentation?.(viewportId)
          : null;
        const segmentationId = activeSegmentation?.segmentationId || activeSegmentation?.id;
        if (segmentationId) {
          void saveAllFrames(segmentationId, servicesManager, 'all-timepoints');
        }
      };

      window.addEventListener('keydown', _onKeyDown);
    },
    onModeExit: ({ servicesManager }: withAppTypes) => {
      const { toolGroupService, syncGroupService, uiDialogService, uiModalService } = servicesManager.services;

      _saveDebounceTimers.forEach(timer => clearTimeout(timer));
      _saveDebounceTimers.clear();
      _segmentationSubscriptions.forEach(subscription => subscription.unsubscribe?.());
      _segmentationSubscriptions = [];
      _displaySetSubscriptions.forEach(subscription => subscription.unsubscribe?.());
      _displaySetSubscriptions = [];
      _unsubscribeViewportDataChanged?.();
      _unsubscribeViewportDataChanged = null;

      if (_onContourCompleted) {
        eventTarget.removeEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);
        _onContourCompleted = null;
      }

      if (_onToolActivated) {
        eventTarget.removeEventListener(toolEnums.Events.TOOL_ACTIVATED, _onToolActivated);
        _onToolActivated = null;
      }

      if (_onKeyDown) {
        window.removeEventListener('keydown', _onKeyDown);
        _onKeyDown = null;
      }

      _teardownRotatableRectangleROIBehavior?.();
      _teardownRotatableRectangleROIBehavior = null;

      if (typeof window !== 'undefined') {
        delete (window as any).__medexSegmentationTestApi;
      }

      uiDialogService?.hideAll?.();
      uiModalService?.hide?.();
      toolGroupService.destroy();
      syncGroupService?.destroy?.();
    },

    validationTags: { study: [], series: [] },

    isValidMode: ({ modalities }: { modalities: string }) => {
      const list = modalities.split('\\');
      return {
        valid: list.includes('MR'),
        description: 'Cvi Labs requires cardiac MR studies.',
      };
    },

    routes: [
      {
        path: 'cvi-labs',
        layoutTemplate: () => ({
          id: ohif.layout,
          props: {
            leftPanels: [ohif.leftPanel],
            leftPanelResizable: true,
            rightPanels: [cviLabsPanels.cardiacViewer, cviLabsPanels.segmentation],
            rightPanelResizable: true,
            viewports: [
              {
                namespace: cornerstone.viewport,
                displaySetsToDisplay: [ohif.sopClassHandler],
              },
            ],
          },
        }),
      },
    ],

    extensions: extensionDependencies,
    hangingProtocol: ['@ohif/mnGrid'],
    sopClassHandlers: [ohif.sopClassHandler],
  };
}

const mode = { id, modeFactory, extensionDependencies };
export default mode;
