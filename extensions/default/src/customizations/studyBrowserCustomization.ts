import { utils } from '@ohif/core';
import { isSuitableForOviLabs } from '@ohif/mode-ovi-labs';
const { formatDate } = utils;

const MOTION_ANALYSIS_URL =
  process.env.REACT_APP_MOTION_ANALYSIS_URL || 'http://localhost:8501';

export default {
  'studyBrowser.headerMenu': [
    {
      id: 'motionAnalysis',
      label: 'Motion Analysis',
      iconName: 'ExternalLink',
      onClick: ({ servicesManager }: withAppTypes) => {
        const { viewportGridService, displaySetService, uiNotificationService } =
          servicesManager.services;
        const state = viewportGridService.getState?.();
        const activeViewportId = state?.activeViewportId;
        const activeViewport = state?.viewports?.get?.(activeViewportId);
        const activeDisplaySetUID = activeViewport?.displaySetInstanceUIDs?.[0];

        if (!activeDisplaySetUID) {
          uiNotificationService?.show?.({
            title: 'Motion Analysis',
            message: 'Select a study in the viewer before opening the analysis workspace.',
            type: 'warning',
            duration: 3500,
          });
          return;
        }

        const displaySet = displaySetService.getDisplaySetByUID(activeDisplaySetUID);
        const studyInstanceUID = displaySet?.StudyInstanceUID || displaySet?.studyInstanceUid;

        if (!studyInstanceUID) {
          uiNotificationService?.show?.({
            title: 'Motion Analysis',
            message: 'Unable to determine the StudyInstanceUID for the active viewport.',
            type: 'error',
            duration: 3500,
          });
          return;
        }

        const targetUrl = `${MOTION_ANALYSIS_URL}?study=${encodeURIComponent(studyInstanceUID)}`;
        if (typeof window !== 'undefined') {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
      },
    },
  ],
  'studyBrowser.studyMenuItems': [],
  'studyBrowser.thumbnailMenuItems': [
    {
      id: 'tagBrowser',
      label: 'Tag Browser',
      iconName: 'DicomTagBrowser',
      onClick: ({ commandsManager, displaySetInstanceUID }: withAppTypes) => {
        commandsManager.runCommand('openDICOMTagViewer', {
          displaySetInstanceUID,
        });
      },
    },
    {
      id: 'uterusAnalysis',
      label: 'Uterus Analysis',
      iconName: 'ExternalLink',
      isVisible: ({ displaySetInstanceUID, servicesManager }: withAppTypes) => {
        const { displaySetService } = servicesManager.services;
        const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
        return isSuitableForOviLabs(displaySet);
      },
      onClick: ({ servicesManager, displaySetInstanceUID }: withAppTypes) => {
        const { displaySetService, uiNotificationService } = servicesManager.services;

        if (!displaySetInstanceUID) {
          uiNotificationService?.show?.({
            title: 'Uterus Analysis',
            message: 'No display set selected.',
            type: 'warning',
            duration: 3500,
          });
          return;
        }

        const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
        const studyInstanceUID = displaySet?.StudyInstanceUID || displaySet?.studyInstanceUid;
        const seriesInstanceUID = displaySet?.SeriesInstanceUID || displaySet?.seriesInstanceUid;

        if (!studyInstanceUID || !seriesInstanceUID) {
          uiNotificationService?.show?.({
            title: 'Uterus Analysis',
            message: 'Unable to determine the Study or Series InstanceUID.',
            type: 'error',
            duration: 3500,
          });
          return;
        }

        const targetUrl = `/ovi-labs?StudyInstanceUIDs=${encodeURIComponent(
          studyInstanceUID
        )}&SeriesInstanceUID=${encodeURIComponent(seriesInstanceUID)}`;

        if (typeof window !== 'undefined') {
          window.location.href = targetUrl;
        }
      },
    },
  ],
  'studyBrowser.sortFunctions': [
    {
      label: 'Series Number',
      sortFunction: (a, b) => {
        return a?.SeriesNumber - b?.SeriesNumber;
      },
    },
    {
      label: 'Series Date',
      sortFunction: (a, b) => {
        const dateA = new Date(formatDate(a?.SeriesDate));
        const dateB = new Date(formatDate(b?.SeriesDate));
        return dateB.getTime() - dateA.getTime();
      },
    },
  ],
  'studyBrowser.viewPresets': [
    {
      id: 'list',
      iconName: 'ListView',
      selected: false,
    },
    {
      id: 'thumbnails',
      iconName: 'ThumbnailView',
      selected: true,
    },
  ],
  'studyBrowser.studyMode': 'all',
  'studyBrowser.thumbnailDoubleClickCallback': {
    callbacks: [
      ({ activeViewportId, servicesManager, commandsManager, isHangingProtocolLayout }) =>
        async displaySetInstanceUID => {
          const { hangingProtocolService, uiNotificationService } = servicesManager.services;
          let updatedViewports = [];
          const viewportId = activeViewportId;

          try {
            updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
              viewportId,
              displaySetInstanceUID,
              isHangingProtocolLayout
            );
          } catch (error) {
            console.warn(error);
            uiNotificationService.show({
              title: 'Thumbnail Double Click',
              message: 'The selected display sets could not be added to the viewport.',
              type: 'error',
              duration: 3000,
            });
          }

          commandsManager.run('setDisplaySetsForViewports', {
            viewportsToUpdate: updatedViewports,
          });
        },
    ],
  },
};
