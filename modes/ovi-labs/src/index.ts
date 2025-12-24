import { id } from './id';
import toolbarButtons from './toolbarButtons';
import initToolGroups from './initToolGroups';
import { isSuitableForOviLabs } from './utils/seriesValidator';

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
  roiViewer: '@ohif/extension-ovi-labs.panelModule.roiViewer',
  fftAnalysis: '@ohif/extension-ovi-labs.panelModule.fftAnalysis',
  kymographs: '@ohif/extension-ovi-labs.panelModule.kymographs',
  analysisPlots: '@ohif/extension-ovi-labs.panelModule.analysisPlots',
};

const extensionDependencies = {
  '@ohif/extension-default': '3.11.0-beta.11',
  '@ohif/extension-cornerstone': '3.11.0-beta.11',
  '@ohif/extension-ovi-labs': '3.11.0-beta.11',
  '@ohif/extension-dicom-video': '3.11.0-beta.11',
};

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
  return {
    id,
    routeName: 'ovi-labs',
    displayName: 'Ovi Labs',
    onModeEnter: ({ servicesManager, extensionManager, commandsManager }: withAppTypes) => {
      const { toolbarService, toolGroupService, uiDialogService, uiModalService } =
        servicesManager.services;

      uiDialogService?.hideAll?.();
      uiModalService?.hide?.();

      initToolGroups(extensionManager, toolGroupService);

      toolbarService.addButtons(toolbarButtons);
      toolbarService.createButtonSection('primary', [
        'measurementSection',
        'Zoom',
        'WindowLevel',
        'Pan',
        'Layout',
        'MoreTools',
        'Cine',
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
              rightPanels: [
                oviLabsPanels.roiViewer,
                oviLabsPanels.fftAnalysis,
                oviLabsPanels.kymographs,
                oviLabsPanels.analysisPlots,
              ],
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
