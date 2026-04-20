import { getEnabledElement, getEnabledElementByIds, utilities as csUtils } from '@cornerstonejs/core';
import { annotation } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';

const TOOL_NAME = 'ManualContour';
const DEFAULT_FILL_OPACITY = 0.2;

export const getManualContourAnnotations = (frameOfReferenceUID?: string): any[] => {
  const annotationManager = annotation.state.getAnnotationManager();
  if (!annotationManager) {
    return [];
  }

  if (frameOfReferenceUID) {
    return annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];
  }

  const frames = annotationManager.getFramesOfReference() || [];
  return frames.flatMap(frame => annotationManager.getAnnotations(frame, TOOL_NAME) || []);
};

export const copyContourPoints = (points: number[][] = []): number[][] =>
  points.map(point => [...point]);

export const createManualContourAnnotation = ({
  sourceAnnotation,
  referencedImageId,
  frameNumber,
  seriesInstanceUID,
  studyInstanceUID,
}: {
  sourceAnnotation: any;
  referencedImageId?: string;
  frameNumber?: number;
  seriesInstanceUID?: string;
  studyInstanceUID?: string;
}) => {
  const contourPoints = copyContourPoints(sourceAnnotation?.data?.contour?.polyline || []);
  const now = Date.now();
  const metadata = {
    ...(sourceAnnotation?.metadata || {}),
    toolName: TOOL_NAME,
  } as Record<string, any>;
  if (referencedImageId) {
    metadata.referencedImageId = referencedImageId;
  }

  return {
    annotationUID: csUtils.uuidv4(),
    highlighted: false,
    isLocked: false,
    isVisible: true,
    invalidated: true,
    metadata,
    data: {
      ...(sourceAnnotation?.data || {}),
      fillColor: sourceAnnotation?.data?.fillColor || sourceAnnotation?.data?.labelColor,
      fillOpacity: sourceAnnotation?.data?.fillOpacity ?? DEFAULT_FILL_OPACITY,
      renderFill: sourceAnnotation?.data?.renderFill ?? true,
      contour: {
        ...(sourceAnnotation?.data?.contour || {}),
        polyline: contourPoints,
      },
      handles: {
        ...(sourceAnnotation?.data?.handles || {}),
        points: contourPoints,
        activeHandleIndex: null,
      },
      createdAt: now,
      modifiedAt: now,
      frameNumber,
      seriesInstanceUID,
      studyInstanceUID,
    },
  };
};

export const getSeriesIdentifiersFromViewport = (
  servicesManager: any,
  viewport: any,
  viewportInfo: any
): { seriesInstanceUID?: string; studyInstanceUID?: string } => {
  const displaySetService = servicesManager?.services?.displaySetService;
  const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
  const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
  if (displaySetInstanceUID && displaySetService?.getDisplaySetByUID) {
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
    return {
      seriesInstanceUID: displaySet?.SeriesInstanceUID,
      studyInstanceUID: displaySet?.StudyInstanceUID,
    };
  }

  const imageId = viewport?.getCurrentImageId?.();
  if (imageId) {
    const instance = DicomMetadataStore.getInstanceByImageId(imageId);
    return {
      seriesInstanceUID: instance?.SeriesInstanceUID,
      studyInstanceUID: instance?.StudyInstanceUID,
    };
  }

  return {};
};

export const getSeriesIdentifiersFromAnnotation = (
  contour: any
): { seriesInstanceUID?: string; studyInstanceUID?: string } => {
  const seriesInstanceUID = contour?.data?.seriesInstanceUID;
  const studyInstanceUID = contour?.data?.studyInstanceUID;
  if (seriesInstanceUID || studyInstanceUID) {
    return { seriesInstanceUID, studyInstanceUID };
  }

  const imageId = contour?.metadata?.referencedImageId;
  if (imageId) {
    const instance = DicomMetadataStore.getInstanceByImageId(imageId);
    return {
      seriesInstanceUID: instance?.SeriesInstanceUID,
      studyInstanceUID: instance?.StudyInstanceUID,
    };
  }

  return {};
};

export const resolveReferencedImageId = (evt: any): { imageId?: string; viewport?: any } => {
  const element = evt?.detail?.element;
  if (element) {
    const enabledElement = getEnabledElement(element);
    const viewport = enabledElement?.viewport;
    const imageId = viewport?.getCurrentImageId?.();
    return { imageId, viewport };
  }

  const { viewportId, renderingEngineId } = evt?.detail || {};
  if (viewportId && renderingEngineId) {
    const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
    const viewport = enabledElement?.viewport;
    const imageId = viewport?.getCurrentImageId?.();
    return { imageId, viewport };
  }

  return {};
};

export const resolveFrameNumber = (viewport: any): number | undefined => {
  const currentIndex = viewport?.getCurrentImageIdIndex?.();
  if (currentIndex !== undefined && currentIndex !== null) {
    return currentIndex + 1;
  }

  const frameNumber =
    viewport?.getFrameNumber?.() ?? viewport?.getCurrentFrameNumber?.() ?? undefined;
  if (typeof frameNumber === 'number' && !Number.isNaN(frameNumber)) {
    return frameNumber;
  }

  return undefined;
};

export const getContourFrameKey = (
  contour: any
): { type: 'imageId' | 'frameNumber' | 'unknown'; value: any } => {
  const imageId = contour?.metadata?.referencedImageId;
  if (imageId) {
    return { type: 'imageId', value: imageId };
  }

  const frameNumber = contour?.data?.frameNumber || contour?.metadata?.frameNumber;
  if (frameNumber !== undefined) {
    return { type: 'frameNumber', value: frameNumber };
  }

  return { type: 'unknown', value: undefined };
};
