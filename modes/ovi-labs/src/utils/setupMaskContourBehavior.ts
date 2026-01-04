import {
  eventTarget,
  getEnabledElement,
  getEnabledElementByIds,
  utilities as csUtils,
} from '@cornerstonejs/core';
import { annotation, Enums, utilities } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';

const TOOL_NAME = 'MaskContour';
const TOOL_GROUP_ID = 'default';
const MASK_LABEL = { id: 'mask', label: 'Mask', color: '#94A3B8' };

let isMaskContourActive = false;
let activeViewportHintTargets: HTMLElement[] = [];

const applyToolGroupStyle = () => {
  const toolGroupStyles = annotation.config.style.getToolGroupToolStyles(TOOL_GROUP_ID) || {};
  const toolSpecificStyles = toolGroupStyles[TOOL_NAME] || {};
  annotation.config.style.setToolGroupToolStyles(TOOL_GROUP_ID, {
    ...toolGroupStyles,
    [TOOL_NAME]: {
      ...toolSpecificStyles,
      color: MASK_LABEL.color,
      colorHighlighted: MASK_LABEL.color,
      colorSelected: MASK_LABEL.color,
      lineDash: [6, 4],
      lineDashSelected: [6, 4],
    },
  });
};

const applyAnnotationStyle = (annotationUID: string) => {
  annotation.config.style.setAnnotationStyles(annotationUID, {
    color: MASK_LABEL.color,
    colorHighlighted: MASK_LABEL.color,
    colorSelected: MASK_LABEL.color,
    lineDash: [6, 4],
    lineDashSelected: [6, 4],
  });
};

const updateMaskAnnotation = (annotationToUpdate, element: HTMLElement | undefined) => {
  if (!annotationToUpdate) return;

  const enabledElement = element ? getEnabledElement(element) : undefined;
  const viewport = enabledElement?.viewport;
  const currentImageId = viewport?.getCurrentImageId?.();
  const instance = currentImageId ? DicomMetadataStore.getInstanceByImageId(currentImageId) : null;

  annotationToUpdate.data = {
    ...annotationToUpdate.data,
    labelId: MASK_LABEL.id,
    labelName: MASK_LABEL.label,
    labelColor: MASK_LABEL.color,
    modelType: 'mask',
    frameNumber: instance?.frameNumber ?? viewport?.getCurrentImageIdIndex?.() + 1,
    seriesInstanceUID: instance?.SeriesInstanceUID,
    studyInstanceUID: instance?.StudyInstanceUID,
    modifiedAt: Date.now(),
  };

  if (annotationToUpdate.metadata && currentImageId) {
    annotationToUpdate.metadata.referencedImageId = currentImageId;
  }

  applyAnnotationStyle(annotationToUpdate.annotationUID);
};

const getMaskAnnotations = (frameOfReferenceUID?: string) => {
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

const getSeriesIdentifiersFromAnnotation = contour => {
  const seriesInstanceUID = contour?.data?.seriesInstanceUID;
  const studyInstanceUID = contour?.data?.studyInstanceUID;

  if (seriesInstanceUID && studyInstanceUID) {
    return { seriesInstanceUID, studyInstanceUID };
  }

  const imageId = contour?.metadata?.referencedImageId;
  if (!imageId) {
    return {};
  }

  const instance = DicomMetadataStore.getInstanceByImageId(imageId);
  return {
    seriesInstanceUID: instance?.SeriesInstanceUID,
    studyInstanceUID: instance?.StudyInstanceUID,
  };
};

const getSeriesIdentifiersFromViewport = (servicesManager, viewport, viewportInfo) => {
  const displaySetService = servicesManager?.services?.displaySetService;
  const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
  const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
  if (displaySetInstanceUID) {
    const displaySet = displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID);
    if (displaySet?.SeriesInstanceUID) {
      return {
        seriesInstanceUID: displaySet.SeriesInstanceUID,
        studyInstanceUID: displaySet.StudyInstanceUID,
      };
    }
  }

  const currentImageId = viewport?.getCurrentImageId?.();
  if (!currentImageId) {
    return {};
  }

  const instance = DicomMetadataStore.getInstanceByImageId(currentImageId);
  return {
    seriesInstanceUID: instance?.SeriesInstanceUID,
    studyInstanceUID: instance?.StudyInstanceUID,
  };
};

const getContourFrameKey = contour => {
  const imageId = contour?.metadata?.referencedImageId;
  if (imageId) {
    return { type: 'imageId', value: imageId };
  }

  const frameNumber = contour?.data?.frameNumber || contour?.metadata?.frameNumber;
  if (frameNumber) {
    return { type: 'frameNumber', value: frameNumber };
  }

  return { type: 'unknown', value: undefined };
};

const resolveFrameNumber = viewport => {
  if (!viewport) return undefined;
  const index = viewport.getCurrentImageIdIndex?.();
  if (typeof index === 'number') {
    return index + 1;
  }
  return undefined;
};

const getActiveViewportContext = servicesManager => {
  const viewportGridService = servicesManager?.services?.viewportGridService;
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
  const state = viewportGridService?.getState?.();
  const activeViewportId = state?.activeViewportId;
  if (!activeViewportId || !cornerstoneViewportService) {
    return {};
  }

  const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
  const viewportInfo = cornerstoneViewportService.getViewportInfo?.(activeViewportId);
  return {
    activeViewportId,
    viewport,
    element: viewportInfo?.element,
    viewportInfo,
  };
};

const isMaskContourToolActive = servicesManager => {
  const toolGroupService = servicesManager?.services?.toolGroupService;
  const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);
  return activeTool === TOOL_NAME;
};

const removeMaskContourHints = () => {
  activeViewportHintTargets.forEach(target => {
    const hint = target.querySelector('.ovi-mask-contour-hint');
    if (hint) {
      hint.remove();
    }
  });
  activeViewportHintTargets = [];
};

const renderMaskContourHints = () => {
  removeMaskContourHints();
  if (typeof document === 'undefined') {
    return;
  }

  const viewports = Array.from(document.querySelectorAll('[data-viewport-uid]'));
  activeViewportHintTargets = viewports.filter(node => node instanceof HTMLElement) as HTMLElement[];

  activeViewportHintTargets.forEach(target => {
    const hint = document.createElement('div');
    hint.className = 'ovi-mask-contour-hint';
    const lineOne = document.createElement('div');
    lineOne.textContent = 'Right-click: add/remove point';
    const lineTwo = document.createElement('div');
    lineTwo.textContent = 'Cmd/Ctrl+V: paste previous mask';
    hint.append(lineOne, lineTwo);
    target.appendChild(hint);
  });
};

const copyContourPoints = (points: number[][] = []) => points.map(point => [...point]);

const createMaskContourAnnotation = ({
  sourceAnnotation,
  referencedImageId,
  frameNumber,
  seriesInstanceUID,
  studyInstanceUID,
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

const removeOtherMasksInFrame = (annotationToUpdate, element: HTMLElement | undefined) => {
  const frameOfReferenceUID = annotationToUpdate?.metadata?.FrameOfReferenceUID;
  const annotationManager = annotation.state.getAnnotationManager();
  if (!frameOfReferenceUID || !annotationManager) {
    return;
  }

  const currentImageId = annotationToUpdate?.metadata?.referencedImageId;
  const currentFrameNumber = annotationToUpdate?.data?.frameNumber;

  const existingAnnotations =
    annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];

  existingAnnotations.forEach(existingAnnotation => {
    if (existingAnnotation.annotationUID === annotationToUpdate.annotationUID) {
      return;
    }

    const sameImageId =
      currentImageId && existingAnnotation.metadata?.referencedImageId === currentImageId;
    const sameFrame =
      currentFrameNumber && existingAnnotation.data?.frameNumber === currentFrameNumber;

    if (sameImageId || sameFrame) {
      annotation.state.removeAnnotation(existingAnnotation.annotationUID);
    }
  });

  const viewportIdsToRender = element
    ? utilities.viewportFilters.getViewportIdsWithToolToRender(element, TOOL_NAME)
    : [];
  if (viewportIdsToRender.length) {
    utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  }
};

const setupMaskContourBehavior = servicesManager => {
  applyToolGroupStyle();

  const onToolActivated = evt => {
    const { toolGroupId, toolName } = evt.detail || {};
    if (toolGroupId !== TOOL_GROUP_ID) {
      return;
    }

    if (toolName === TOOL_NAME) {
      isMaskContourActive = true;
      renderMaskContourHints();
      return;
    }

    if (isMaskContourActive) {
      isMaskContourActive = false;
      removeMaskContourHints();
    }
  };

  const handleAnnotationAdded = evt => {
    const { annotation: addedAnnotation, element } = evt.detail || {};
    if (!addedAnnotation || addedAnnotation.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    updateMaskAnnotation(addedAnnotation, element);
    removeOtherMasksInFrame(addedAnnotation, element);
  };

  const handleAnnotationModified = evt => {
    const { annotation: modifiedAnnotation, element } = evt.detail || {};
    if (!modifiedAnnotation || modifiedAnnotation.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    updateMaskAnnotation(modifiedAnnotation, element);
    removeOtherMasksInFrame(modifiedAnnotation, element);
  };

  eventTarget.addEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_ADDED, handleAnnotationAdded);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_MODIFIED, handleAnnotationModified);

  const onKeyDown = (evt: KeyboardEvent) => {
    // Only allow paste when MaskContour tool is active
    if (!isMaskContourActive && !isMaskContourToolActive(servicesManager)) {
      return;
    }

    const isPaste =
      (evt.ctrlKey || evt.metaKey) && evt.key?.toLowerCase?.() === 'v' && !evt.shiftKey;
    if (!isPaste) {
      return;
    }

    const target = evt.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }

    const { viewport, element, viewportInfo } = getActiveViewportContext(servicesManager);
    if (!viewport) {
      return;
    }

    const imageIds = viewport.getImageIds?.() || [];
    let currentIndex = viewport.getCurrentImageIdIndex?.();
    if (currentIndex === undefined) {
      const currentImageIdFallback = viewport.getCurrentImageId?.();
      if (currentImageIdFallback) {
        currentIndex = imageIds.indexOf(currentImageIdFallback);
      }
    }

    const hasImageStack =
      Array.isArray(imageIds) && imageIds.length > 0 && currentIndex !== undefined;
    const currentFrameNumber = resolveFrameNumber(viewport);
    if (!hasImageStack && (currentFrameNumber === undefined || currentFrameNumber <= 1)) {
      return;
    }

    const currentImageId = hasImageStack ? imageIds[currentIndex as number] : undefined;
    const previousImageId = hasImageStack ? imageIds[(currentIndex as number) - 1] : undefined;
    const previousFrameNumber = currentFrameNumber ? currentFrameNumber - 1 : undefined;

    const frameOfReferenceUID = viewport.getFrameOfReferenceUID?.();
    const seriesInfo = getSeriesIdentifiersFromViewport(servicesManager, viewport, viewportInfo);
    const annotations = getMaskAnnotations(frameOfReferenceUID).filter(contour => {
      if (!seriesInfo.seriesInstanceUID) {
        return true;
      }
      const contourSeries = getSeriesIdentifiersFromAnnotation(contour).seriesInstanceUID;
      if (!contourSeries) {
        return true;
      }
      return contourSeries === seriesInfo.seriesInstanceUID;
    });
    if (!annotations.length) {
      return;
    }

    const hasCurrent = annotations.some(contour => {
      const key = getContourFrameKey(contour);
      if (key.type === 'imageId') {
        return currentImageId ? key.value === currentImageId : false;
      }
      if (key.type === 'frameNumber') {
        return currentFrameNumber ? key.value === currentFrameNumber : false;
      }
      return false;
    });

    if (hasCurrent) {
      return;
    }

    let sourceAnnotation = annotations.find(contour => {
      const key = getContourFrameKey(contour);
      if (key.type === 'imageId') {
        return previousImageId ? key.value === previousImageId : false;
      }
      if (key.type === 'frameNumber') {
        return previousFrameNumber ? key.value === previousFrameNumber : false;
      }
      return false;
    });

    if (!sourceAnnotation && currentFrameNumber) {
      const priorByFrame = annotations
        .map(contour => {
          const key = getContourFrameKey(contour);
          if (key.type === 'frameNumber') {
            return { contour, frameNumber: key.value as number };
          }
          if (key.type === 'imageId' && hasImageStack) {
            const index = imageIds.indexOf(key.value as string);
            return index >= 0 ? { contour, frameNumber: index + 1 } : null;
          }
          return null;
        })
        .filter(Boolean)
        .filter(entry => entry.frameNumber < currentFrameNumber)
        .sort((a, b) => b.frameNumber - a.frameNumber);

      sourceAnnotation = priorByFrame[0]?.contour;
    }

    if (!sourceAnnotation) {
      return;
    }

    const newAnnotation = createMaskContourAnnotation({
      sourceAnnotation,
      referencedImageId: currentImageId,
      frameNumber: currentFrameNumber,
      seriesInstanceUID: seriesInfo.seriesInstanceUID,
      studyInstanceUID: seriesInfo.studyInstanceUID,
    });

    annotation.state.addAnnotation(newAnnotation);
    updateMaskAnnotation(newAnnotation, element);
    removeOtherMasksInFrame(newAnnotation, element);

    if (element) {
      const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
        element,
        TOOL_NAME
      );
      utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    }

    evt.preventDefault();
  };

  window?.addEventListener?.('keydown', onKeyDown);

  return () => {
    eventTarget.removeEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_ADDED, handleAnnotationAdded);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_MODIFIED, handleAnnotationModified);
    window?.removeEventListener?.('keydown', onKeyDown);
    removeMaskContourHints();
  };
};

export default setupMaskContourBehavior;
