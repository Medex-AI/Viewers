import { useEffect, useState, memo, useCallback } from 'react';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';

const ActiveViewportBehavior = memo(
  ({ servicesManager, viewportId }: withAppTypes<{ viewportId: string }>) => {
    const {
      displaySetService,
      cineService,
      segmentationService,
      viewportGridService,
      customizationService,
      cornerstoneViewportService,
    } = servicesManager.services;

    const [activeViewportId, setActiveViewportId] = useState(viewportId);

    const handleCineEnable = useCallback(() => {
      if (cineService.isViewportCineClosed(activeViewportId)) {
        return;
      }

      const displaySetInstanceUIDs =
        viewportGridService.getDisplaySetsUIDsForViewport(activeViewportId);

      if (!displaySetInstanceUIDs) {
        return;
      }

      const displaySets = displaySetInstanceUIDs.map(uid =>
        displaySetService.getDisplaySetByUID(uid)
      );

      if (!displaySets.length) {
        return;
      }

      const modalities = displaySets.map(displaySet => displaySet?.Modality);
      const isDynamicVolume = displaySets.some(displaySet => displaySet?.isDynamicVolume);

      const sourceModalities = customizationService.getCustomization('autoCineModalities');

      const requiresCine = modalities.some(modality => sourceModalities.includes(modality));

      if ((requiresCine || isDynamicVolume) && !cineService.getState().isCineEnabled) {
        cineService.setIsCineEnabled(true);
      }
    }, [
      activeViewportId,
      cineService,
      viewportGridService,
      displaySetService,
      customizationService,
    ]);

    const ensureActiveViewportSegmentationRepresentations = useCallback(() => {
      const currentViewportId = viewportGridService.getActiveViewportId();
      if (!currentViewportId) {
        return;
      }

      const displaySetInstanceUIDs =
        viewportGridService.getDisplaySetsUIDsForViewport(currentViewportId) || [];
      if (!displaySetInstanceUIDs.length) {
        return;
      }

      const activeDisplaySets = displaySetInstanceUIDs
        .map(uid => displaySetService.getDisplaySetByUID(uid))
        .filter(Boolean);
      if (!activeDisplaySets.length) {
        return;
      }

      const viewportImageIds =
        cornerstoneViewportService.getCornerstoneViewport(currentViewportId)?.getImageIds?.() || [];
      const activeImageIds = new Set(
        viewportImageIds.length
          ? viewportImageIds
          : activeDisplaySets.flatMap(displaySet => displaySet?.imageIds || [])
      );
      const activeSeriesInstanceUIDs = new Set(
        activeDisplaySets.map(displaySet => displaySet?.SeriesInstanceUID).filter(Boolean)
      );
      if (!activeImageIds.size) {
        return;
      }

      const existingRepresentationIds = new Set(
        (segmentationService.getSegmentationRepresentations(currentViewportId) || []).map(
          representation => representation.segmentationId
        )
      );

      const segmentations = segmentationService.getSegmentations?.() || [];

      segmentations.forEach(segmentation => {
        if (existingRepresentationIds.has(segmentation.segmentationId)) {
          return;
        }

        const labelmapData = segmentation?.representationData?.[
          csToolsEnums.SegmentationRepresentations.Labelmap
        ] as { referencedImageIds?: string[] } | undefined;
        const referencedImageIds = labelmapData?.referencedImageIds || [];
        const referencedSeriesInstanceUIDs = new Set(
          referencedImageIds
            .map(imageId => DicomMetadataStore.getInstanceByImageId(imageId)?.SeriesInstanceUID)
            .filter(Boolean)
        );
        const matchesSeries = Array.from(referencedSeriesInstanceUIDs).some(seriesInstanceUID =>
          activeSeriesInstanceUIDs.has(seriesInstanceUID)
        );
        const matchesActiveViewport = referencedImageIds.some(imageId => activeImageIds.has(imageId));

        if (!matchesSeries && !matchesActiveViewport) {
          return;
        }

        void segmentationService.addSegmentationRepresentation(currentViewportId, {
          segmentationId: segmentation.segmentationId,
          type: csToolsEnums.SegmentationRepresentations.Labelmap,
        });
      });
    }, [viewportGridService, displaySetService, segmentationService, cornerstoneViewportService]);

    useEffect(() => {
      const subscription = viewportGridService.subscribe(
        viewportGridService.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED,
        ({ viewportId }) => {
          setActiveViewportId(viewportId);
          ensureActiveViewportSegmentationRepresentations();
        }
      );

      return () => subscription.unsubscribe();
    }, [viewportId, viewportGridService, ensureActiveViewportSegmentationRepresentations]);

    useEffect(() => {
      const subscription = cornerstoneViewportService.subscribe(
        cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED,
        () => {
          const activeViewportId = viewportGridService.getActiveViewportId();
          setActiveViewportId(activeViewportId);
          handleCineEnable();
          ensureActiveViewportSegmentationRepresentations();
        }
      );

      return () => subscription.unsubscribe();
    }, [
      viewportId,
      cornerstoneViewportService,
      viewportGridService,
      handleCineEnable,
      ensureActiveViewportSegmentationRepresentations,
    ]);

    useEffect(() => {
      handleCineEnable();
      ensureActiveViewportSegmentationRepresentations();
    }, [handleCineEnable, ensureActiveViewportSegmentationRepresentations]);

    return null;
  },
  arePropsEqual
);

ActiveViewportBehavior.displayName = 'ActiveViewportBehavior';

function arePropsEqual(prevProps, nextProps) {
  return (
    prevProps.viewportId === nextProps.viewportId &&
    prevProps.servicesManager === nextProps.servicesManager
  );
}

export default ActiveViewportBehavior;
