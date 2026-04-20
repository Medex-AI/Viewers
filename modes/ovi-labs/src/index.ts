import { id } from './id';
import toolbarButtons from './toolbarButtons';
import initToolGroups from './initToolGroups';
import { isSuitableForOviLabs } from './utils/seriesValidator';
import setupRotatableRectangleROIBehavior from './utils/setupRotatableRectangleROIBehavior';
import setupManualContourBehavior, {
  getActiveManualContourLabelId,
  setActiveManualContourLabelId,
  showManualContourLabelMenu,
} from './utils/setupManualContourBehavior';
import setupMaskContourBehavior from './utils/setupMaskContourBehavior';
import setupManipulationToolsCursor from './utils/setupManipulationToolsCursor';
import viewportClickCommandsCustomization from './customizations/viewportClickCommandsCustomization';
import { ensureOviSegmentationForViewport } from '../../../extensions/ovi-labs/src/utils/oviSegmentation';
import './styles.css';
import { annotation } from '@cornerstonejs/tools';
import { getEnabledElement } from '@cornerstonejs/core';

const DEFAULT_BRUSH_SIZE_MM = 3;

const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  leftPanel: '@ohif/extension-default.panelModule.seriesList',
};

const cornerstone = {
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
};

const dicomVideo = {
  sopClassHandler: '@ohif/extension-dicom-video.sopClassHandlerModule.dicom-video',
};

const oviLabsPanels = {
  analysisContainer: '@ohif/extension-ovi-labs.panelModule.analysisContainer',
  segmentation: '@ohif/extension-ovi-labs.panelModule.segmentation',
};

const extensionDependencies = {
  '@ohif/extension-default': '3.11.0-beta.11',
  '@ohif/extension-cornerstone': '3.11.0-beta.11',
  '@ohif/extension-ovi-labs': '3.11.0-beta.11',
  '@ohif/extension-dicom-video': '3.11.0-beta.11',
};

const OVI_LABS_COMMANDS_CONTEXT = 'OVI_LABS';
const MANUAL_CONTOUR_TOOL_NAME = 'ManualContour';
const MASK_CONTOUR_TOOL_NAME = 'MaskContour';
const CONTOUR_CONTEXT_PICK_PROXIMITY_PX = 10;
const setContourMenuDebug = (message: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  (window as Window & { __oviContourDebugInfo?: string }).__oviContourDebugInfo = message;
};

function pointInPolygon(point, polygon) {
  let isInside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];

    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];

  if (dx === 0 && dy === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }

  const t = Math.max(
    0,
    Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy))
  );

  const projection = [start[0] + t * dx, start[1] + t * dy];
  return Math.hypot(point[0] - projection[0], point[1] - projection[1]);
}

function isPointNearContourEdge(point, polygon, isClosed = true) {
  const edgeCount = isClosed ? polygon.length : polygon.length - 1;

  for (let i = 0; i < edgeCount; i++) {
    const start = polygon[i];
    const end = polygon[(i + 1) % polygon.length];
    if (distanceToSegment(point, start, end) <= CONTOUR_CONTEXT_PICK_PROXIMITY_PX) {
      return true;
    }
  }

  return false;
}

function findNearbyContourAnnotation(element, canvasCoordinates) {
  const enabledElement = getEnabledElement(element);
  const viewport = enabledElement?.viewport;
  if (!viewport || !canvasCoordinates) {
    return null;
  }

  const toolNames = [MANUAL_CONTOUR_TOOL_NAME, MASK_CONTOUR_TOOL_NAME];

  for (const toolName of toolNames) {
    const annotations = annotation.state.getAnnotations(toolName, element) || [];
    for (const contour of annotations) {
      const polyline = contour?.data?.contour?.polyline || [];
      if (!polyline.length || contour?.isLocked || contour?.isVisible === false) {
        continue;
      }

      const canvasPoints = polyline.map(point => viewport.worldToCanvas(point));
      const isClosed = contour?.data?.contour?.closed !== false;
      if (
        canvasPoints.length >= 3 &&
        (pointInPolygon(canvasCoordinates, canvasPoints) ||
          isPointNearContourEdge(canvasCoordinates, canvasPoints, isClosed))
      ) {
        return contour;
      }
    }
  }

  return null;
}

function registerOviLabsCommands(commandsManager, servicesManager) {
  commandsManager.createContext(OVI_LABS_COMMANDS_CONTEXT);

  commandsManager.registerCommand(OVI_LABS_COMMANDS_CONTEXT, 'showManualContourLabelMenu', {
    commandFn: ({ nearbyToolData, event }) => {
      if (event?.detail?.event?.defaultPrevented) {
        return;
      }

      if (nearbyToolData?.metadata?.toolName !== MANUAL_CONTOUR_TOOL_NAME) {
        return;
      }

      const { uiDialogService } = servicesManager.services;
      const element = event?.detail?.element;
      showManualContourLabelMenu({ uiDialogService, annotation: nearbyToolData, element });
    },
  });

  commandsManager.registerCommand(OVI_LABS_COMMANDS_CONTEXT, 'showOviLabsContextMenu', {
    commandFn: ({ nearbyToolData, event }) => {
      const element = event?.detail?.element;
      const canvasCoordinates = event?.detail?.currentPoints?.canvas;
      const contourNearbyToolData =
        nearbyToolData?.metadata?.toolName === MANUAL_CONTOUR_TOOL_NAME ||
        nearbyToolData?.metadata?.toolName === MASK_CONTOUR_TOOL_NAME
          ? nearbyToolData
          : findNearbyContourAnnotation(element, canvasCoordinates);
      const fallbackNearbyToolData = commandsManager.runCommand(
        'getNearbyToolData',
        {
          element,
          canvasCoordinates,
        },
        'CORNERSTONE'
      );
      const resolvedNearbyToolData = nearbyToolData || contourNearbyToolData || fallbackNearbyToolData;

      setContourMenuDebug(
        `contextMenu point=${canvasCoordinates?.map(value => Math.round(value)).join(',') || 'none'} direct=${nearbyToolData?.metadata?.toolName || 'none'} contour=${contourNearbyToolData?.metadata?.toolName || 'none'} fallback=${fallbackNearbyToolData?.metadata?.toolName || 'none'} final=${resolvedNearbyToolData?.metadata?.toolName || 'none'}`
      );

      if (!resolvedNearbyToolData) {
        return;
      }

      const toolName = resolvedNearbyToolData?.metadata?.toolName;
      const menuCustomizationId =
        toolName === MANUAL_CONTOUR_TOOL_NAME || toolName === MASK_CONTOUR_TOOL_NAME
          ? 'contourContextMenu'
          : 'measurementsContextMenu';
      setContourMenuDebug(
        `contextMenu final=${toolName || 'none'} menu=${menuCustomizationId}`
      );
      commandsManager.runCommand(
        'showContextMenu',
        {
          menuCustomizationId,
          element,
          event,
          selectorProps: {
            nearbyToolData: resolvedNearbyToolData,
            toolName,
            value: resolvedNearbyToolData,
            uid: resolvedNearbyToolData?.annotationUID,
          },
        },
        'DEFAULT'
      );
    },
  });

  commandsManager.registerCommand(OVI_LABS_COMMANDS_CONTEXT, 'activateOviBrushTool', {
    commandFn: async () => {
      const labelId = getActiveManualContourLabelId();
      await setActiveManualContourLabelId(labelId, servicesManager, 'CircularBrush');
    },
  });
}

function resolveDisplaySetsFromStudy(study) {
  if (Array.isArray(study?.displaySets)) {
    return study.displaySets;
  }

  if (Array.isArray(study?.series)) {
    return study.series.flatMap(series => series.displaySets || []);
  }

  return [];
}

function setSeriesFromQuery({ servicesManager, commandsManager }) {
  if (typeof window === 'undefined') {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const seriesInstanceUID =
    params.get('SeriesInstanceUID') || params.get('series') || params.get('SeriesUID');

  if (!seriesInstanceUID) {
    return;
  }

  const {
    displaySetService,
    viewportGridService,
    hangingProtocolService,
    uiNotificationService,
  } = servicesManager.services;

  const displaySet = displaySetService.getDisplaySetsForSeries(seriesInstanceUID)?.[0];
  if (!displaySet) {
    uiNotificationService?.show?.({
      title: 'Ovi Labs',
      message: 'Unable to locate the requested series for this study.',
      type: 'warning',
      duration: 3500,
    });
    return;
  }

  const state = viewportGridService.getState?.();
  const activeViewportId = state?.activeViewportId;

  if (!activeViewportId) {
    return;
  }

  let updatedViewports = [];
  try {
    updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
      activeViewportId,
      displaySet.displaySetInstanceUID,
      state?.isHangingProtocolLayout
    );
  } catch (error) {
    console.warn(error);
    uiNotificationService?.show?.({
      title: 'Ovi Labs',
      message: 'Unable to load the requested series into the active viewport.',
      type: 'error',
      duration: 3500,
    });
    return;
  }

  commandsManager.run('setDisplaySetsForViewports', { viewportsToUpdate: updatedViewports });
}

function modeFactory({ modeConfiguration }) {
  let teardownRotatableRectangleROIBehavior;
  let teardownManualContourBehavior;
  let teardownMaskContourBehavior;
  let teardownManipulationToolsCursor;
  let commandsManagerRef;

  return {
    id,
    routeName: 'ovi-labs',
    displayName: 'Ovi Labs',
    onModeEnter: ({ servicesManager, extensionManager, commandsManager }: withAppTypes) => {
      const { toolbarService, toolGroupService, uiDialogService, uiModalService, customizationService } =
        servicesManager.services;

      uiDialogService?.hideAll?.();
      uiModalService?.hide?.();

      commandsManagerRef = commandsManager;
      registerOviLabsCommands(commandsManager, servicesManager);

      // Set custom viewport click commands to disable context menu for ManualContour and RotatableRectangleROI
      customizationService?.addModeCustomizations?.([
        {
          id: 'cornerstoneViewportClickCommands',
          ...viewportClickCommandsCustomization.cornerstoneViewportClickCommands,
        },
      ]);

      initToolGroups(extensionManager, toolGroupService);
      teardownRotatableRectangleROIBehavior?.();
      teardownManualContourBehavior?.();
      teardownMaskContourBehavior?.();
      teardownManipulationToolsCursor?.();
      teardownRotatableRectangleROIBehavior = setupRotatableRectangleROIBehavior();
      teardownManualContourBehavior = setupManualContourBehavior(servicesManager);
      teardownMaskContourBehavior = setupMaskContourBehavior(servicesManager);
      teardownManipulationToolsCursor = setupManipulationToolsCursor();
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

      try {
        toolGroupService.setToolActive('default', 'WindowLevel', { mouseButton: 1 });
      } catch (error) {
        console.warn('Failed to pre-activate WindowLevel in OVI Labs mode:', error);
      }

      setSeriesFromQuery({ servicesManager, commandsManager });
      void ensureOviSegmentationForViewport(servicesManager);
    },
    onModeExit: ({ servicesManager }: withAppTypes) => {
      const { toolGroupService, uiDialogService, uiModalService } = servicesManager.services;
      uiDialogService.hideAll();
      uiModalService.hide();
      toolGroupService.destroy();
      commandsManagerRef?.clearContext?.(OVI_LABS_COMMANDS_CONTEXT);
      commandsManagerRef = undefined;
      teardownRotatableRectangleROIBehavior?.();
      teardownRotatableRectangleROIBehavior = undefined;
      teardownManualContourBehavior?.();
      teardownManualContourBehavior = undefined;
      teardownMaskContourBehavior?.();
      teardownMaskContourBehavior = undefined;
      teardownManipulationToolsCursor?.();
      teardownManipulationToolsCursor = undefined;
    },
    validationTags: {
      study: [],
      series: [],
    },
    isValidMode: ({ modalities, study }) => {
      const displaySets = resolveDisplaySetsFromStudy(study);
      if (displaySets.length) {
        return {
          valid: displaySets.some(isSuitableForOviLabs),
          description: 'Ovi Labs requires sagittal cine MR series with sufficient frames.',
        };
      }

      const modalitiesList = modalities.split('\\');
      return {
        valid: modalitiesList.includes('MR'),
        description: 'Ovi Labs requires MR studies.',
      };
    },
    routes: [
      {
        path: 'ovi-labs',
        layoutTemplate: () => {
          return {
            id: ohif.layout,
            props: {
              leftPanels: [ohif.leftPanel],
              leftPanelResizable: true,
              rightPanels: [oviLabsPanels.analysisContainer, oviLabsPanels.segmentation],
              rightPanelResizable: true,
              viewports: [
                {
                  namespace: cornerstone.viewport,
                  displaySetsToDisplay: [ohif.sopClassHandler],
                  viewportOptions: {
                    viewportType: 'stack',
                  },
                },
              ],
            },
          };
        },
      },
    ],
    extensions: extensionDependencies,
    hangingProtocol: 'default',
    sopClassHandlers: [dicomVideo.sopClassHandler, ohif.sopClassHandler],
    ...modeConfiguration,
  };
}

const mode = {
  id,
  modeFactory,
  extensionDependencies,
};

export { checkSagittalOrientation, isSuitableForOviLabs } from './utils/seriesValidator';
export default mode;
