import { id } from './id';
import toolbarButtons from './toolbarButtons';
import initToolGroups from './initToolGroups';
import { isSuitableForOviLabs } from './utils/seriesValidator';
import setupRotatableRectangleROIBehavior from './utils/setupRotatableRectangleROIBehavior';
import setupManualContourBehavior, {
  showManualContourLabelMenu,
} from './utils/setupManualContourBehavior';
import setupManipulationToolsCursor from './utils/setupManipulationToolsCursor';
import viewportClickCommandsCustomization from './customizations/viewportClickCommandsCustomization';
import './styles.css';

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
      teardownManipulationToolsCursor?.();
      teardownRotatableRectangleROIBehavior = setupRotatableRectangleROIBehavior();
      teardownManualContourBehavior = setupManualContourBehavior(servicesManager);
      teardownManipulationToolsCursor = setupManipulationToolsCursor();

      toolbarService.addButtons(toolbarButtons);
      toolbarService.createButtonSection('primary', [
        'measurementSection',
        'Zoom',
        'WindowLevel',
        'Pan',
        'Layout',
        'MoreTools',
        'Cine',
        'RotatableRectangleROI',
        'ManualContour',
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

      setSeriesFromQuery({ servicesManager, commandsManager });
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
