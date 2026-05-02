import { eventTarget } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import toolbarButtons from '../../ovi-labs/src/toolbarButtons';
import initToolGroups from '../../ovi-labs/src/initToolGroups';
import { saveAllFrames } from '../../segmentation/src/segmentationPersistenceOps';
import { writeContourToOhifLabelmap } from '../../segmentation/src/writeContourToOhifLabelmap';
import { ensureCviSegmentationForViewport } from '../../../specialties/cvi-labs/src/utils/cviSegmentation';

const id = '@ohif/mode-cvi-labs';

const DEFAULT_BRUSH_SIZE_MM = 3;

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
  let _onKeyDown: ((evt: KeyboardEvent) => void) | null = null;
  const _saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

      uiDialogService?.hideAll?.();
      uiModalService?.hide?.();

      initToolGroups(extensionManager, toolGroupService, commandsManager);
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
        'ManualContour',
        'Brush',
        'MaskContour',
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

      const ensureForViewport = async (viewportId?: string) => {
        const context = await ensureCviSegmentationForViewport(servicesManager, viewportId);
        return context?.segmentationId || null;
      };

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
              scheduleAutosave(segmentationId);
            }
          }
        ),
        segmentationService.subscribe(
          segmentationService.EVENTS.SEGMENTATION_MODIFIED,
          ({ segmentationId }: { segmentationId: string }) => {
            if (segmentationId) {
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

      eventTarget.addEventListener(toolEnums.Events.ANNOTATION_COMPLETED, _onContourCompleted);

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

      if (_onKeyDown) {
        window.removeEventListener('keydown', _onKeyDown);
        _onKeyDown = null;
      }

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
                viewportOptions: { viewportType: 'stack' },
              },
            ],
          },
        }),
      },
    ],

    extensions: extensionDependencies,
    hangingProtocol: 'default',
    sopClassHandlers: [ohif.sopClassHandler],
  };
}

const mode = { id, modeFactory, extensionDependencies };
export default mode;
