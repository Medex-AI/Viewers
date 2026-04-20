import { cache, imageLoader, utilities as csUtils } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums, segmentation } from '@cornerstonejs/tools';
import { maskToContours } from './maskToContour';
import { rasterizePolygonToMask } from './rasterizeContour';

const MANUAL_CONTOUR_TOOL_NAME = 'ManualContour';

export const OVI_SEGMENTATION_LABELS = [
  { id: 'uterineCavity', name: 'Uterine cavity', color: '#22D3EE', segmentIndex: 1 },
  { id: 'endometrium', name: 'Endometrium', color: '#F472B6', segmentIndex: 2 },
  { id: 'myometrium', name: 'Myometrium', color: '#FBBF24', segmentIndex: 3 },
  { id: 'junctionalZone', name: 'Junctional zone', color: '#60A5FA', segmentIndex: 4 },
] as const;

export type OviSegmentationLabel = (typeof OVI_SEGMENTATION_LABELS)[number];

export const OVI_SEGMENTATION_ID_PREFIX = 'ovi-labs';
let hasShownTemporalVolumeSegmentationWarning = false;

const pushOviBrushDebug = (message: string, details?: Record<string, unknown>) => {
  if (typeof window === 'undefined') {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    message,
    ...(details || {}),
  };

  const debugWindow = window as Window & {
    __oviBrushDebugLog?: Array<Record<string, unknown>>;
    __oviBrushDebugLast?: Record<string, unknown>;
  };

  debugWindow.__oviBrushDebugLog = debugWindow.__oviBrushDebugLog || [];
  debugWindow.__oviBrushDebugLog.push(payload);
  debugWindow.__oviBrushDebugLast = payload;
  console.debug('[OVI Brush Debug]', payload);
};

const labelById = new Map<string, OviSegmentationLabel>(
  OVI_SEGMENTATION_LABELS.map(label => [label.id, label])
);
const labelBySegmentIndex = new Map<number, OviSegmentationLabel>(
  OVI_SEGMENTATION_LABELS.map(label => [label.segmentIndex, label])
);

export const getOviSegmentationIdForDisplaySet = (displaySetInstanceUID: string) =>
  `${OVI_SEGMENTATION_ID_PREFIX}:${displaySetInstanceUID}`;

export const getOviLabelById = (labelId?: string | null) =>
  (labelId ? labelById.get(labelId) : undefined) || OVI_SEGMENTATION_LABELS[0];

export const getOviLabelBySegmentIndex = (segmentIndex?: number | null) =>
  (typeof segmentIndex === 'number' ? labelBySegmentIndex.get(segmentIndex) : undefined) ||
  OVI_SEGMENTATION_LABELS[0];

export const getOviSegmentIndexForLabelId = (labelId?: string | null) =>
  getOviLabelById(labelId).segmentIndex;

const getDisplaySetContext = (servicesManager, viewportId?: string) => {
  const { viewportGridService, cornerstoneViewportService, displaySetService } =
    servicesManager?.services || {};
  const targetViewportId = viewportId || viewportGridService?.getState?.()?.activeViewportId;
  if (!targetViewportId || !cornerstoneViewportService || !displaySetService) {
    return null;
  }

  const viewportInfo = cornerstoneViewportService.getViewportInfo?.(targetViewportId);
  const viewport = cornerstoneViewportService.getCornerstoneViewport?.(targetViewportId);
  const displaySetInstanceUID = viewportInfo?.getDisplaySetOptions?.()?.[0]?.displaySetInstanceUID;
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

const isStackSegmentationSafeContext = context => {
  const viewportType = context?.viewportInfo?.getViewportType?.()?.toLowerCase?.() || '';
  const displaySetViewportType = context?.displaySet?.viewportType?.toLowerCase?.() || '';

  return viewportType === 'stack' || (!viewportType && displaySetViewportType === 'stack');
};

const ensureConfiguredSegments = (servicesManager, viewportId: string, segmentationId: string) => {
  const { segmentationService } = servicesManager.services;
  const existing = segmentationService.getSegmentation(segmentationId);
  const previousActive = segmentationService.getActiveSegment(viewportId)?.segmentIndex ?? 1;

  OVI_SEGMENTATION_LABELS.forEach(label => {
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

export const ensureOviSegmentationForViewport = async (servicesManager, viewportId?: string) => {
  const { segmentationService, uiNotificationService } = servicesManager?.services || {};
  const context = getDisplaySetContext(servicesManager, viewportId);
  if (!segmentationService || !context) {
    pushOviBrushDebug('ensureOviSegmentationForViewport: missing prerequisites', {
      hasSegmentationService: Boolean(segmentationService),
      hasContext: Boolean(context),
      viewportId,
    });
    return null;
  }

  if (!isStackSegmentationSafeContext(context)) {
    pushOviBrushDebug('ensureOviSegmentationForViewport: non-stack context rejected', {
      viewportId: context.viewportId,
      displaySetInstanceUID: context.displaySetInstanceUID,
      viewportType: context?.viewportInfo?.getViewportType?.(),
      displaySetViewportType: context?.displaySet?.viewportType,
    });
    if (!hasShownTemporalVolumeSegmentationWarning) {
      uiNotificationService?.show?.({
        title: 'OVI Labs Segmentation',
        message:
          'Canonical labelmap segmentation is temporarily limited to stack-based studies. Contour annotations remain available for this temporal volume dataset.',
        type: 'warning',
        duration: 4000,
      });
      hasShownTemporalVolumeSegmentationWarning = true;
    }
    return null;
  }

  const { viewportId: targetViewportId, displaySet, displaySetInstanceUID } = context;
  const segmentationId = getOviSegmentationIdForDisplaySet(displaySetInstanceUID);
  let segmentationState = segmentationService.getSegmentation(segmentationId);
  pushOviBrushDebug('ensureOviSegmentationForViewport: begin', {
    viewportId: targetViewportId,
    displaySetInstanceUID,
    segmentationId,
    hasExistingSegmentation: Boolean(segmentationState),
  });

  if (!segmentationState) {
    await segmentationService.createLabelmapForDisplaySet(displaySet, {
      segmentationId,
      label: 'OVI Labs Segmentation',
      segments: Object.fromEntries(
        OVI_SEGMENTATION_LABELS.map(label => [
          label.segmentIndex,
          {
            label: label.name,
            active: label.segmentIndex === 1,
          },
        ])
      ),
    });
    segmentationState = segmentationService.getSegmentation(segmentationId);
    pushOviBrushDebug('ensureOviSegmentationForViewport: created labelmap', {
      viewportId: targetViewportId,
      segmentationId,
      hasSegmentationAfterCreate: Boolean(segmentationState),
    });
  }

  const representations = segmentationService.getSegmentationRepresentations(targetViewportId, {
    segmentationId,
    type: toolEnums.SegmentationRepresentations.Labelmap,
  });
  if (!representations.length) {
    await segmentationService.addSegmentationRepresentation(targetViewportId, {
      segmentationId,
      type: toolEnums.SegmentationRepresentations.Labelmap,
    });
    pushOviBrushDebug('ensureOviSegmentationForViewport: added representation', {
      viewportId: targetViewportId,
      segmentationId,
      representationType: toolEnums.SegmentationRepresentations.Labelmap,
    });
  }

  segmentationService.setActiveSegmentation(targetViewportId, segmentationId);
  ensureConfiguredSegments(servicesManager, targetViewportId, segmentationId);
  if (!segmentationService.getActiveSegment(targetViewportId)?.segmentIndex) {
    segmentationService.setActiveSegment(segmentationId, 1);
  }
  pushOviBrushDebug('ensureOviSegmentationForViewport: completed', {
    viewportId: targetViewportId,
    segmentationId,
    activeSegmentation: segmentationService.getActiveSegmentation?.(targetViewportId),
    activeSegmentViewport: segmentationService.getActiveSegment?.(targetViewportId),
    activeSegmentSegmentation: segmentationService.getActiveSegment?.(segmentationId),
    representationCount:
      segmentationService.getSegmentationRepresentations(targetViewportId, {
        segmentationId,
        type: toolEnums.SegmentationRepresentations.Labelmap,
      })?.length || 0,
  });

  return {
    ...context,
    segmentationId,
    segmentation: segmentationService.getSegmentation(segmentationId),
  };
};

const getFrameLabelmap = async (segmentationState, referencedImageId?: string) => {
  const labelmapData = segmentationState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

  const referencedImageIds = labelmapData?.referencedImageIds || [];
  const imageIds = labelmapData?.imageIds || [];
  if (!imageIds.length) {
    return null;
  }

  const frameIndex = referencedImageId ? referencedImageIds.indexOf(referencedImageId) : 0;
  if (frameIndex < 0 || !imageIds[frameIndex]) {
    return null;
  }

  const labelmapImageId = imageIds[frameIndex];
  const labelmapImage =
    cache.getImage(labelmapImageId) || (await imageLoader.loadAndCacheImage(labelmapImageId));
  const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
  const width = labelmapImage?.columns || labelmapImage?.width;
  const height = labelmapImage?.rows || labelmapImage?.height;

  if (!scalarData || !width || !height) {
    return null;
  }

  return {
    frameIndex,
    labelmapImageId,
    referencedImageId: referencedImageIds[frameIndex],
    width,
    height,
    scalarData: scalarData as Uint8Array,
  };
};

export const readOviSegmentationFrame = async ({
  servicesManager,
  viewportId,
  referencedImageId,
}: {
  servicesManager: any;
  viewportId?: string;
  referencedImageId?: string;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  if (!context) {
    return null;
  }

  const frame = await getFrameLabelmap(context.segmentation, referencedImageId);
  if (!frame) {
    return null;
  }

  const labelMap = Object.fromEntries(
    OVI_SEGMENTATION_LABELS.map(label => [
      label.segmentIndex,
      {
        labelId: label.id,
        labelName: label.name,
        labelColor: label.color,
      },
    ])
  );

  return {
    ...context,
    ...frame,
    referencedImageId: frame.referencedImageId,
    maskData: new Uint8Array(frame.scalarData),
    labelMap,
  };
};

const getAllFrameLabelmaps = async segmentationState => {
  const labelmapData = segmentationState?.representationData?.[
    toolEnums.SegmentationRepresentations.Labelmap
  ] as { imageIds?: string[]; referencedImageIds?: string[] } | undefined;

  const imageIds = labelmapData?.imageIds || [];
  const referencedImageIds = labelmapData?.referencedImageIds || [];
  if (!imageIds.length) {
    return [];
  }

  const frames = await Promise.all(
    imageIds.map(async (labelmapImageId, frameIndex) => {
      const labelmapImage =
        cache.getImage(labelmapImageId) || (await imageLoader.loadAndCacheImage(labelmapImageId));
      const scalarData = labelmapImage?.voxelManager?.getScalarData?.();
      const width = labelmapImage?.columns || labelmapImage?.width;
      const height = labelmapImage?.rows || labelmapImage?.height;

      if (!scalarData || !width || !height) {
        return null;
      }

      return {
        frameIndex,
        labelmapImageId,
        referencedImageId: referencedImageIds[frameIndex],
        width,
        height,
        scalarData: scalarData as Uint8Array,
      };
    })
  );

  return frames.filter(Boolean);
};

export const writeMaskToActiveSegmentation = async ({
  servicesManager,
  viewportId,
  referencedImageId,
  maskData,
}: {
  servicesManager: any;
  viewportId?: string;
  referencedImageId?: string;
  maskData: Uint8Array;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  if (!context?.segmentation || !maskData?.length) {
    return null;
  }

  const frame = await getFrameLabelmap(context.segmentation, referencedImageId);
  if (!frame || frame.scalarData.length !== maskData.length) {
    return null;
  }

  frame.scalarData.set(maskData);
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    context.segmentationId,
    [frame.frameIndex]
  );

  return {
    ...context,
    ...frame,
  };
};

export const clearOviSegmentPixels = async ({
  servicesManager,
  viewportId,
  labelId,
  referencedImageId,
}: {
  servicesManager: any;
  viewportId?: string;
  labelId: string;
  referencedImageId?: string;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  if (!context?.segmentation) {
    return null;
  }

  const segmentIndex = getOviSegmentIndexForLabelId(labelId);
  const targetFrames = referencedImageId
    ? [await getFrameLabelmap(context.segmentation, referencedImageId)].filter(Boolean)
    : await getAllFrameLabelmaps(context.segmentation);

  if (!targetFrames.length) {
    return null;
  }

  const modifiedFrameIndices: number[] = [];
  targetFrames.forEach(frame => {
    let didModify = false;
    for (let i = 0; i < frame.scalarData.length; i += 1) {
      if (frame.scalarData[i] === segmentIndex) {
        frame.scalarData[i] = 0;
        didModify = true;
      }
    }
    if (didModify) {
      modifiedFrameIndices.push(frame.frameIndex);
    }
  });

  if (!modifiedFrameIndices.length) {
    return {
      ...context,
      modifiedFrameIndices,
    };
  }

  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    context.segmentationId,
    modifiedFrameIndices,
    segmentIndex
  );

  return {
    ...context,
    modifiedFrameIndices,
  };
};

export const setOviSegmentVisibility = async ({
  servicesManager,
  viewportId,
  labelId,
  visible,
}: {
  servicesManager: any;
  viewportId?: string;
  labelId: string;
  visible: boolean;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  const { segmentationService } = servicesManager?.services || {};
  if (!context?.viewportId || !context?.segmentationId || !segmentationService) {
    return null;
  }

  segmentationService.setSegmentVisibility(
    context.viewportId,
    context.segmentationId,
    getOviSegmentIndexForLabelId(labelId),
    visible
  );

  return context;
};

export const setOviSegmentOpacity = async ({
  servicesManager,
  viewportId,
  labelId,
  opacity,
}: {
  servicesManager: any;
  viewportId?: string;
  labelId: string;
  opacity: number;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  const { segmentationService } = servicesManager?.services || {};
  const label = getOviLabelById(labelId);
  if (!context?.viewportId || !context?.segmentationId || !segmentationService || !label) {
    return null;
  }

  const alpha = Math.max(0, Math.min(255, Math.round(opacity * 255)));
  const rgbaColor = [
    parseInt(label.color.slice(1, 3), 16),
    parseInt(label.color.slice(3, 5), 16),
    parseInt(label.color.slice(5, 7), 16),
    alpha,
  ] as [number, number, number, number];

  segmentationService.setSegmentColor(
    context.viewportId,
    context.segmentationId,
    label.segmentIndex,
    rgbaColor
  );

  return context;
};

export const writeContourToActiveSegmentation = async ({
  servicesManager,
  viewportId,
  referencedImageId,
  worldPolyline,
  segmentIndex,
}: {
  servicesManager: any;
  viewportId?: string;
  referencedImageId?: string;
  worldPolyline: number[][];
  segmentIndex: number;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  if (!context?.viewport || !context.segmentation || !referencedImageId || !worldPolyline?.length) {
    return null;
  }

  const frame = await getFrameLabelmap(context.segmentation, referencedImageId);
  if (!frame) {
    return null;
  }

  const polygon = worldPolyline.map(worldPoint => {
    const indexPoint = context.viewport.worldToIndex
      ? context.viewport.worldToIndex(worldPoint)
      : csUtils.worldToImageCoords(referencedImageId, worldPoint as [number, number, number]);
    return [indexPoint[0], indexPoint[1]] as [number, number];
  });

  rasterizePolygonToMask(frame.scalarData, polygon, segmentIndex, frame.width, frame.height);
  segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    context.segmentationId,
    [frame.frameIndex],
    segmentIndex
  );

  return {
    ...context,
    ...frame,
  };
};

export const syncDerivedContoursFromSegmentation = async ({
  servicesManager,
  viewportId,
  referencedImageId,
  modelType = 'manual',
}: {
  servicesManager: any;
  viewportId?: string;
  referencedImageId?: string;
  modelType?: string;
}) => {
  const frame = await readOviSegmentationFrame({
    servicesManager,
    viewportId,
    referencedImageId,
  });
  if (!frame?.viewport || !frame?.viewportInfo?.element || !frame.referencedImageId) {
    return null;
  }

  const element = frame.viewportInfo.element as HTMLElement;
  const frameOfReferenceUID = frame.viewport.getFrameOfReferenceUID?.();
  if (!frameOfReferenceUID) {
    return null;
  }

  const annotationManager = annotation.state.getAnnotationManager();
  if (!annotationManager) {
    return null;
  }

  const existing =
    annotationManager.getAnnotations(frameOfReferenceUID, MANUAL_CONTOUR_TOOL_NAME) || [];
  existing.forEach(existingAnnotation => {
    if (
      existingAnnotation.metadata?.referencedImageId === frame.referencedImageId &&
      (existingAnnotation.data?.modelType || 'manual') === modelType
    ) {
      annotation.state.removeAnnotation(existingAnnotation.annotationUID);
    }
  });

  const now = Date.now();
  Object.entries(frame.labelMap).forEach(([segmentIndexString, labelInfo]) => {
    const segmentIndex = Number(segmentIndexString);
    const contours = maskToContours(frame.maskData, frame.width, frame.height, segmentIndex);
    contours.forEach(contour => {
      if (contour.length < 3) {
        return;
      }

      const worldPoints = contour.map(point =>
        csUtils.imageToWorldCoords(frame.referencedImageId, point as [number, number])
      );
      const annotationUID = csUtils.uuidv4();
      annotationManager.addAnnotation({
        annotationUID,
        highlighted: false,
        isLocked: false,
        isVisible: true,
        invalidated: true,
        metadata: {
          toolName: MANUAL_CONTOUR_TOOL_NAME,
          FrameOfReferenceUID: frameOfReferenceUID,
          referencedImageId: frame.referencedImageId,
        },
        data: {
          contour: {
            polyline: worldPoints,
            closed: true,
          },
          handles: {
            points: worldPoints,
            activeHandleIndex: null,
          },
          labelId: labelInfo.labelId,
          labelName: labelInfo.labelName,
          labelColor: labelInfo.labelColor,
          fillColor: labelInfo.labelColor,
          fillOpacity: 0.2,
          renderFill: true,
          modelType,
          derivedFromSegmentation: true,
          createdAt: now,
          modifiedAt: now,
        },
      });

      annotation.config.style.setAnnotationStyles(annotationUID, {
        color: labelInfo.labelColor,
        colorHighlighted: labelInfo.labelColor,
        colorSelected: labelInfo.labelColor,
        fillColor: labelInfo.labelColor,
        fillOpacity: 0.2,
      });
    });
  });

  return frame;
};

/**
 * Read all labelmap frames from the currently active segmentation in the given viewport.
 * Works generically for both OVI Labs and OHIF segmentation mode, because it reads
 * directly from `segmentationService.getActiveSegmentation` rather than the
 * OVI-Labs-specific segmentation ID.
 */
export const readActiveSegmentationFrames = async ({
  servicesManager,
  viewportId,
}: {
  servicesManager: any;
  viewportId?: string;
}): Promise<
  Array<{
    frameIndex: number;
    labelmapImageId: string;
    referencedImageId: string | undefined;
    width: number;
    height: number;
    scalarData: Uint8Array;
  }>
> => {
  const { viewportGridService, segmentationService } = servicesManager?.services || {};
  const targetViewportId = viewportId || viewportGridService?.getState?.()?.activeViewportId;
  if (!targetViewportId || !segmentationService) return [];

  const activeSegmentation = segmentationService.getActiveSegmentation(targetViewportId);
  if (!activeSegmentation) return [];

  const frames = await getAllFrameLabelmaps(activeSegmentation);
  return frames.filter(Boolean) as Array<{
    frameIndex: number;
    labelmapImageId: string;
    referencedImageId: string | undefined;
    width: number;
    height: number;
    scalarData: Uint8Array;
  }>;
};

export const syncAllDerivedContoursFromSegmentation = async ({
  servicesManager,
  viewportId,
  modelType = 'manual',
}: {
  servicesManager: any;
  viewportId?: string;
  modelType?: string;
}) => {
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  if (!context?.segmentation) {
    return [];
  }

  const frames = await getAllFrameLabelmaps(context.segmentation);
  await Promise.all(
    frames.map(frame =>
      syncDerivedContoursFromSegmentation({
        servicesManager,
        viewportId: context.viewportId,
        referencedImageId: frame.referencedImageId,
        modelType,
      })
    )
  );

  return frames;
};
