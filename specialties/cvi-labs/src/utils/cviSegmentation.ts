import { DicomMetadataStore } from '@ohif/core';
import { Enums as toolEnums } from '@cornerstonejs/tools';
import { getStableFrameKey, tryAutoCreateSegmentationFromBackend } from '../../../../modes/segmentation/src/segmentationPersistenceOps';
import { CVI_LABELS } from '../stores/cviLabsSegmentationStore';

export const CVI_SEGMENTATION_ID_PREFIX = 'cvi-labs';
export const CVI_SEGMENTATION_NAME = 'Cvi Lab';

const getSeriesInstanceUIDFromImageId = (imageId?: string | null) => {
  if (!imageId) {
    return null;
  }

  const metadataSeriesInstanceUID = DicomMetadataStore.getInstanceByImageId(imageId)?.SeriesInstanceUID;
  if (metadataSeriesInstanceUID) {
    return metadataSeriesInstanceUID;
  }

  const match = imageId.match(/\/series\/([^/]+)\/instances\//i);
  return match?.[1] || null;
};

const getDisplaySetContext = (servicesManager, viewportId?: string) => {
  const { viewportGridService, cornerstoneViewportService, displaySetService } =
    servicesManager?.services || {};
  const targetViewportId = viewportId || viewportGridService?.getState?.()?.activeViewportId;
  if (!targetViewportId || !cornerstoneViewportService || !displaySetService) {
    return null;
  }

  const viewportInfo = cornerstoneViewportService.getViewportInfo?.(targetViewportId);
  const viewport = cornerstoneViewportService.getCornerstoneViewport?.(targetViewportId);
  const preferredDisplaySetInstanceUID =
    viewportInfo?.getDisplaySetOptions?.()?.[0]?.displaySetInstanceUID;
  const currentImageId = viewport?.getCurrentImageId?.();
  const seriesInstanceUID = getSeriesInstanceUIDFromImageId(currentImageId);
  const seriesDisplaySet = seriesInstanceUID
    ? displaySetService.getDisplaySetsForSeries?.(seriesInstanceUID)?.[0] ||
      displaySetService.getActiveDisplaySets?.()?.find(ds => ds.SeriesInstanceUID === seriesInstanceUID) ||
      Array.from(displaySetService.getDisplaySetCache?.()?.values?.() || []).find(
        ds => ds.SeriesInstanceUID === seriesInstanceUID
      )
    : null;
  const displaySetInstanceUID = preferredDisplaySetInstanceUID || seriesDisplaySet?.displaySetInstanceUID;
  if (!displaySetInstanceUID) {
    return null;
  }

  const displaySet = displaySetService.getDisplaySetByUID?.(displaySetInstanceUID);
  if (!displaySet) {
    return null;
  }

  return {
    viewportId: targetViewportId,
    viewportInfo,
    viewport,
    displaySet,
    displaySetInstanceUID,
  };
};

const getDisplaySetFrameKeys = (displaySet, viewport) => {
  const displaySetImageIds = displaySet?.imageIds?.length
    ? displaySet.imageIds
    : viewport?.getImageIds?.() || [];
  return new Set(displaySetImageIds.map(imageId => getStableFrameKey(imageId) || imageId));
};

const isFrameSetMatch = (displaySet, viewport, segmentationState) => {
  const labelmapData = segmentationState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { referencedImageIds?: string[] } | undefined;
  const referencedImageIds = labelmapData?.referencedImageIds ?? [];
  const displaySetFrameKeys = getDisplaySetFrameKeys(displaySet, viewport);

  if (!referencedImageIds.length || referencedImageIds.length !== displaySetFrameKeys.size) {
    return false;
  }

  return referencedImageIds.every(imageId => displaySetFrameKeys.has(getStableFrameKey(imageId) || imageId));
};

export const isCviCompatibleSegmentation = (segmentationState?: any) => {
  if (!segmentationState?.segments) {
    return false;
  }

  const segmentIndices = Object.keys(segmentationState.segments)
    .map(Number)
    .filter(index => segmentationState.segments?.[index]);
  const expectedIndices = CVI_LABELS.map(label => label.segmentIndex);

  if (
    segmentIndices.length !== expectedIndices.length ||
    segmentIndices.some(index => !expectedIndices.includes(index))
  ) {
    return false;
  }

  return CVI_LABELS.every(
    label => segmentationState.segments?.[label.segmentIndex]?.label === label.name
  );
};

export const getCviSegmentationIdForDisplaySet = (displaySetInstanceUID: string) =>
  `${CVI_SEGMENTATION_ID_PREFIX}:${displaySetInstanceUID}`;

const ensureConfiguredSegments = (servicesManager, viewportId: string, segmentationId: string) => {
  const { segmentationService } = servicesManager.services;
  const existing = segmentationService.getSegmentation(segmentationId);
  const previousActive = segmentationService.getActiveSegment(viewportId)?.segmentIndex ?? 1;

  CVI_LABELS.forEach(label => {
    if (!existing?.segments?.[label.segmentIndex]) {
      segmentationService.addSegment(segmentationId, {
        segmentIndex: label.segmentIndex,
        label: label.name,
      });
    } else if (existing.segments[label.segmentIndex].label !== label.name) {
      segmentationService.setSegmentLabel(segmentationId, label.segmentIndex, label.name);
    }

    const rgbaColor = [
      parseInt(label.color.slice(1, 3), 16),
      parseInt(label.color.slice(3, 5), 16),
      parseInt(label.color.slice(5, 7), 16),
      255,
    ] as [number, number, number, number];

    segmentationService.setSegmentColor(viewportId, segmentationId, label.segmentIndex, rgbaColor);
  });

  segmentationService.setActiveSegment(segmentationId, previousActive);
};

const findCompatibleCviSegmentationForDisplaySet = (
  displaySet,
  viewport,
  segmentationService,
  viewportId?: string
) => {
  const segmentations = (segmentationService?.getSegmentations?.() || []).filter(
    segmentation =>
      isCviCompatibleSegmentation(segmentation) && isFrameSetMatch(displaySet, viewport, segmentation)
  );

  const activeSegmentation = viewportId
    ? segmentationService?.getActiveSegmentation?.(viewportId)
    : null;
  if (
    activeSegmentation?.segmentationId &&
    segmentations.some(segmentation => segmentation.segmentationId === activeSegmentation.segmentationId)
  ) {
    return activeSegmentation;
  }

  return (
    segmentations.find(segmentation => segmentation.label === CVI_SEGMENTATION_NAME) ||
    segmentations[0]
  );
};

export const ensureCviSegmentationForViewport = async (servicesManager, viewportId?: string) => {
  const { segmentationService } = servicesManager?.services || {};
  const context = getDisplaySetContext(servicesManager, viewportId);
  if (!segmentationService || !context?.displaySet || !context.viewportId) {
    return null;
  }

  try {
    await tryAutoCreateSegmentationFromBackend(context.viewportId, servicesManager);
  } catch {
    // Best-effort: Cvi should still create a compatible editable labelmap when restore fails.
  }

  const compatibleSegmentation = findCompatibleCviSegmentationForDisplaySet(
    context.displaySet,
    context.viewport,
    segmentationService,
    context.viewportId
  );
  const segmentationId =
    compatibleSegmentation?.segmentationId || getCviSegmentationIdForDisplaySet(context.displaySetInstanceUID);

  if (!compatibleSegmentation && !segmentationService.getSegmentation(segmentationId)) {
    await segmentationService.createLabelmapForDisplaySet(context.displaySet, {
      segmentationId,
      label: CVI_SEGMENTATION_NAME,
      segments: Object.fromEntries(
        CVI_LABELS.map(label => [
          label.segmentIndex,
          {
            label: label.name,
            active: label.segmentIndex === 1,
          },
        ])
      ),
    });
  }

  const representations = segmentationService.getSegmentationRepresentations(context.viewportId, {
    segmentationId,
    type: toolEnums.SegmentationRepresentations.Labelmap,
  });
  if (!representations.length) {
    await segmentationService.addSegmentationRepresentation(context.viewportId, {
      segmentationId,
      type: toolEnums.SegmentationRepresentations.Labelmap,
    });
  }

  segmentationService.setActiveSegmentation(context.viewportId, segmentationId);
  ensureConfiguredSegments(servicesManager, context.viewportId, segmentationId);
  if (!segmentationService.getActiveSegment(context.viewportId)?.segmentIndex) {
    segmentationService.setActiveSegment(segmentationId, 1);
  }

  return {
    ...context,
    segmentationId,
    segmentation: segmentationService.getSegmentation(segmentationId),
  };
};

export const activateCviCompatibleSegmentation = async ({
  servicesManager,
  viewportId,
  segmentationId,
}: {
  servicesManager: any;
  viewportId?: string;
  segmentationId: string;
}) => {
  const { segmentationService } = servicesManager?.services || {};
  const context = getDisplaySetContext(servicesManager, viewportId);
  const segmentationState = segmentationService?.getSegmentation?.(segmentationId);

  if (
    !context?.viewportId ||
    !context?.displaySet ||
    !segmentationService ||
    !isCviCompatibleSegmentation(segmentationState) ||
    !isFrameSetMatch(context.displaySet, context.viewport, segmentationState)
  ) {
    return null;
  }

  const representations = segmentationService.getSegmentationRepresentations(context.viewportId, {
    segmentationId,
    type: toolEnums.SegmentationRepresentations.Labelmap,
  });
  if (!representations.length) {
    await segmentationService.addSegmentationRepresentation(context.viewportId, {
      segmentationId,
      type: toolEnums.SegmentationRepresentations.Labelmap,
    });
  }

  segmentationService.setActiveSegmentation(context.viewportId, segmentationId);
  ensureConfiguredSegments(servicesManager, context.viewportId, segmentationId);

  return {
    ...context,
    segmentationId,
    segmentation: segmentationService.getSegmentation(segmentationId),
  };
};

export const listCompatibleCviSegmentations = (servicesManager, viewportId?: string) => {
  const { segmentationService } = servicesManager?.services || {};
  const context = getDisplaySetContext(servicesManager, viewportId);
  if (!segmentationService || !context?.displaySet) {
    return [];
  }

  return (segmentationService.getSegmentations?.() || []).filter(
    segmentation =>
      isCviCompatibleSegmentation(segmentation) &&
      isFrameSetMatch(context.displaySet, context.viewport, segmentation)
  );
};
