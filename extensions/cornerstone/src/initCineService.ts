import { cache, Types } from '@cornerstonejs/core';
import { utilities } from '@cornerstonejs/tools';

function _isVolumeViewport(
  viewport: Types.IViewport | Types.IBaseVolumeViewport | null | undefined
): viewport is Types.IBaseVolumeViewport {
  return Boolean(
    viewport && typeof (viewport as Types.IBaseVolumeViewport).getAllVolumeIds === 'function'
  );
}

function _getVolumeFromViewport(viewport: Types.IBaseVolumeViewport) {
  const volumeIds = viewport.getAllVolumeIds();
  const volumes = volumeIds.map(id => cache.getVolume(id));
  const dynamicVolume = volumes.find(volume => volume.isDynamicVolume());

  return dynamicVolume ?? volumes[0];
}

/**
 * Return all viewports that needs to be synchronized with the source
 * viewport passed as parameter when cine is updated.
 * @param servicesManager ServiceManager
 * @param srcViewportIndex Source viewport index
 * @returns array with viewport information.
 */
function _getSyncedViewports(servicesManager: AppTypes.ServicesManager, srcViewportId) {
  const { viewportGridService, cornerstoneViewportService } = servicesManager.services;

  const { viewports: viewportsStates } = viewportGridService.getState();
  const srcViewportState = viewportsStates.get(srcViewportId);

  if (srcViewportState?.viewportOptions?.viewportType !== 'volume') {
    return [];
  }

  const srcViewport = cornerstoneViewportService.getCornerstoneViewport(srcViewportId);
  if (!_isVolumeViewport(srcViewport)) {
    return [];
  }

  const srcVolume = _getVolumeFromViewport(srcViewport);

  if (!srcVolume?.isDynamicVolume()) {
    return [];
  }

  const { volumeId: srcVolumeId } = srcVolume;

  return Array.from(viewportsStates.values())
    .filter(({ viewportId }) => {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);

      return (
        viewportId !== srcViewportId &&
        _isVolumeViewport(viewport) &&
        viewport.hasVolumeId?.(srcVolumeId)
      );
    })
    .map(({ viewportId }) => ({ viewportId }));
}

function initCineService(servicesManager: AppTypes.ServicesManager) {
  const { cineService } = servicesManager.services;

  const getSyncedViewports = viewportId => {
    return _getSyncedViewports(servicesManager, viewportId);
  };

  const playClip = (element, playClipOptions) => {
    return utilities.cine.playClip(element, playClipOptions);
  };

  const stopClip = (element, stopClipOptions) => {
    return utilities.cine.stopClip(element, stopClipOptions);
  };

  cineService.setServiceImplementation({
    getSyncedViewports,
    playClip,
    stopClip,
  });
}

export default initCineService;
