import {
  eventTarget,
  getEnabledElement,
  getEnabledElementByIds,
  utilities as csUtils,
} from '@cornerstonejs/core';
import { annotation, Enums, utilities } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';
import ManualContourLabelMenu from '../components/ManualContourLabelMenu';

const TOOL_NAME = 'ManualContour';
const TOOL_GROUP_ID = 'default';
const LABELS = [
  { id: 'uterineCavity', label: 'Uterine cavity', color: '#22D3EE' },
  { id: 'endometrium', label: 'Endometrium', color: '#F472B6' },
  { id: 'myometrium', label: 'Myometrium', color: '#FBBF24' },
  { id: 'junctionalZone', label: 'Junctional zone', color: '#60A5FA' },
];

let activeLabelId = LABELS[0].id;
let isManualContourActive = false;
let activeViewportHintTargets: HTMLElement[] = [];

const getLabelConfig = labelId => LABELS.find(label => label.id === labelId) || LABELS[0];

const lightenHexColor = (hexColor: string, ratio = 0.35) => {
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) {
    return hexColor;
  }

  const num = parseInt(hex, 16);
  const r = Math.min(255, Math.round(((num >> 16) & 0xff) * (1 - ratio) + 255 * ratio));
  const g = Math.min(255, Math.round(((num >> 8) & 0xff) * (1 - ratio) + 255 * ratio));
  const b = Math.min(255, Math.round((num & 0xff) * (1 - ratio) + 255 * ratio));

  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
};

const updateToolButtonColor = (color: string) => {
  // Update the toolbar button color to match the active label
  if (typeof window === 'undefined') {
    return;
  }

  const toolButton = window.document?.querySelector(`[data-tool="${TOOL_NAME}"]`);
  if (toolButton instanceof HTMLElement) {
    // Find the button element (could be nested)
    const buttonElement = toolButton.querySelector('button') || toolButton;
    if (buttonElement instanceof HTMLElement) {
      // Apply the color as a border and subtle background when active
      buttonElement.style.setProperty('border', `2px solid ${color}`, 'important');
      if (toolButton.getAttribute('data-active') === 'true') {
        buttonElement.style.setProperty('background-color', `${color}20`, 'important');
      }
    }
  }
};

const applyToolGroupStyle = labelId => {
  const { color } = getLabelConfig(labelId);
  const highlightColor = lightenHexColor(color);
  const toolGroupStyles = annotation.config.style.getToolGroupToolStyles(TOOL_GROUP_ID) || {};
  const toolSpecificStyles = toolGroupStyles[TOOL_NAME] || {};

  annotation.config.style.setToolGroupToolStyles(TOOL_GROUP_ID, {
    ...toolGroupStyles,
    [TOOL_NAME]: {
      ...toolSpecificStyles,
      color,
      colorHighlighted: highlightColor,
      colorSelected: highlightColor,
    },
  });

  // Update the toolbar button color
  updateToolButtonColor(color);
};

const applyAnnotationStyle = (annotationUID, labelId) => {
  const { color } = getLabelConfig(labelId);
  const highlightColor = lightenHexColor(color);
  annotation.config.style.setAnnotationStyles(annotationUID, {
    color,
    colorHighlighted: highlightColor,
    colorSelected: highlightColor,
  });
};

const updateActiveLabel = labelId => {
  activeLabelId = labelId;
  applyToolGroupStyle(activeLabelId);
};

const updateAnnotationLabel = (annotationToUpdate, labelId, element) => {
  if (!annotationToUpdate?.data) {
    return;
  }

  const labelConfig = getLabelConfig(labelId);
  const modelType = annotationToUpdate?.data?.modelType || 'manual';
  annotationToUpdate.data = {
    ...annotationToUpdate.data,
    labelId,
    labelName: labelConfig.label,
    labelColor: labelConfig.color,
    modelType,
    modifiedAt: Date.now(),
  };

  applyAnnotationStyle(annotationToUpdate.annotationUID, labelId);
  annotation.state.triggerAnnotationModified(
    annotationToUpdate,
    element,
    Enums.ChangeTypes.LabelChange
  );

  const frameOfReferenceUID = annotationToUpdate.metadata?.FrameOfReferenceUID;
  const annotationManager = annotation.state.getAnnotationManager();

  if (!frameOfReferenceUID || !annotationManager) {
    return;
  }

  const existingAnnotations =
    annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];

  // Only remove annotations with same labelId AND same referencedImageId (same time frame)
  const currentImageId = annotationToUpdate.metadata?.referencedImageId;

  existingAnnotations.forEach(existingAnnotation => {
    if (
      existingAnnotation.annotationUID !== annotationToUpdate.annotationUID &&
      existingAnnotation.data?.labelId === labelId &&
      (existingAnnotation.data?.modelType || 'manual') === modelType &&
      existingAnnotation.metadata?.referencedImageId === currentImageId
    ) {
      annotation.state.removeAnnotation(existingAnnotation.annotationUID);
    }
  });
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

const getManualContourAnnotations = (frameOfReferenceUID?: string) => {
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

const copyContourPoints = (points: number[][] = []) => points.map(point => [...point]);

const createManualContourAnnotation = ({
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

const getSeriesIdentifiersFromViewport = (servicesManager, viewport, viewportInfo) => {
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

const getSeriesIdentifiersFromAnnotation = contour => {
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

const resolveReferencedImageId = evt => {
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

const resolveFrameNumber = viewport => {
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

const getContourFrameKey = contour => {
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

const removeManualContourHints = () => {
  activeViewportHintTargets.forEach(target => {
    const hint = target.querySelector('.ovi-manual-contour-hint');
    if (hint) {
      hint.remove();
    }
  });
  activeViewportHintTargets = [];
};

const renderManualContourHints = () => {
  removeManualContourHints();
  if (typeof document === 'undefined') {
    return;
  }

  const viewports = Array.from(document.querySelectorAll('[data-viewport-uid]'));
  activeViewportHintTargets = viewports.filter(node => node instanceof HTMLElement) as HTMLElement[];

  activeViewportHintTargets.forEach(target => {
    const hint = document.createElement('div');
    hint.className = 'ovi-manual-contour-hint';
    const lineOne = document.createElement('div');
    lineOne.textContent = 'Right-click: add/remove point';
    const lineTwo = document.createElement('div');
    lineTwo.textContent = 'Cmd/Ctrl+V: paste previous contour';
    hint.append(lineOne, lineTwo);
    target.appendChild(hint);
  });
};

const isManualContourToolActive = servicesManager => {
  const toolGroupService = servicesManager?.services?.toolGroupService;
  const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);
  return activeTool === TOOL_NAME;
};

export const showManualContourLabelMenu = ({
  uiDialogService,
  annotation: targetAnnotation,
  element,
  defaultPosition: positionOverride,
}) => {
  if (!uiDialogService) {
    return;
  }

  const panelWidth = 240;
  const margin = 16;
  const defaultPosition =
    positionOverride ||
    (typeof window !== 'undefined'
      ? (() => {
          const toolButton = window.document?.querySelector(`[data-tool="${TOOL_NAME}"]`);
          if (toolButton instanceof HTMLElement) {
            const rect = toolButton.getBoundingClientRect();
            const x = Math.min(
              window.innerWidth - panelWidth - margin,
              Math.max(margin, rect.left + rect.width / 2 - panelWidth / 2)
            );
            const y = Math.min(window.innerHeight - margin, rect.bottom + 8);
            return { x, y };
          }

          return {
            x: Math.max(margin, window.innerWidth - panelWidth - margin),
            y: 96,
          };
        })()
      : undefined);

  uiDialogService.hide('manual-contour-label');
  uiDialogService.show({
    id: 'manual-contour-label',
    title: '',
    content: ManualContourLabelMenu,
    unstyled: true,
    showOverlay: false,
    shouldCloseOnOverlayClick: true,
    shouldCloseOnEsc: true,
    containerClassName: 'shadow-none',
    defaultPosition,
    contentProps: {
      labelData: LABELS.map(item => ({ label: item.label, value: item.id })),
      initialLabel: targetAnnotation?.data?.labelId || activeLabelId,
      onSelect: value => {
        if (!value) {
          return;
        }
        updateActiveLabel(value);
        if (targetAnnotation) {
          updateAnnotationLabel(targetAnnotation, value, element);
        }
      },
    },
  });
};

export default function setupManualContourBehavior(servicesManager: AppTypes.ServicesManager) {
  const { uiDialogService } = servicesManager.services;

  applyToolGroupStyle(activeLabelId);


  const onToolActivated = evt => {
    const { toolGroupId, toolName } = evt.detail || {};
    if (toolGroupId !== TOOL_GROUP_ID) {
      return;
    }

    if (toolName === TOOL_NAME) {
      isManualContourActive = true;
      showManualContourLabelMenu({ uiDialogService });
      renderManualContourHints();
      // Update button color when tool is activated
      setTimeout(() => {
        const { color } = getLabelConfig(activeLabelId);
        updateToolButtonColor(color);
      }, 100);
      return;
    }

    if (isManualContourActive) {
      isManualContourActive = false;
      removeManualContourHints();
    }
  };

  const onAnnotationAdded = evt => {
    const { annotation: newAnnotation } = evt.detail || {};

    if (newAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    const labelId = newAnnotation.data?.labelId || activeLabelId;
    const labelConfig = getLabelConfig(labelId);
    const resolvedContext = resolveReferencedImageId(evt);
    const activeContext = resolvedContext.viewport ? resolvedContext : getActiveViewportContext(servicesManager);
    const imageId = resolvedContext.imageId || activeContext?.viewport?.getCurrentImageId?.();
    const frameNumber = activeContext?.viewport ? resolveFrameNumber(activeContext.viewport) : undefined;
    const seriesInfo = getSeriesIdentifiersFromViewport(
      servicesManager,
      activeContext?.viewport,
      activeContext?.viewportInfo
    );

    // Add timestamp for overlap resolution (last-edited wins)
    const now = Date.now();
    newAnnotation.data = {
      ...newAnnotation.data,
      labelId,
      labelName: labelConfig.label,
      labelColor: labelConfig.color,
      createdAt: now,
      modifiedAt: now,
      frameNumber: newAnnotation.data?.frameNumber ?? frameNumber,
      seriesInstanceUID: newAnnotation.data?.seriesInstanceUID ?? seriesInfo.seriesInstanceUID,
      studyInstanceUID: newAnnotation.data?.studyInstanceUID ?? seriesInfo.studyInstanceUID,
    };
    if (!newAnnotation.metadata?.referencedImageId && imageId) {
      newAnnotation.metadata = {
        ...newAnnotation.metadata,
        referencedImageId: imageId,
      };
    }

    applyAnnotationStyle(newAnnotation.annotationUID, labelId);

    const frameOfReferenceUID = newAnnotation.metadata?.FrameOfReferenceUID;
    const annotationManager = annotation.state.getAnnotationManager();

    if (!frameOfReferenceUID || !annotationManager) {
      return;
    }

    const existingAnnotations =
      annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];
    const currentImageId = newAnnotation.metadata?.referencedImageId;
    const currentFrameNumber = newAnnotation.data?.frameNumber;

    existingAnnotations.forEach(existingAnnotation => {
      if (
        existingAnnotation.annotationUID !== newAnnotation.annotationUID &&
        existingAnnotation.data?.labelId === labelId
      ) {
        const existingImageId = existingAnnotation.metadata?.referencedImageId;
        const existingFrameNumber =
          existingAnnotation.data?.frameNumber || existingAnnotation.metadata?.frameNumber;
        const sameImageId = currentImageId && existingImageId && existingImageId === currentImageId;
        const sameFrame =
          !currentImageId &&
          currentFrameNumber !== undefined &&
          existingFrameNumber === currentFrameNumber;
        if (sameImageId || sameFrame) {
          annotation.state.removeAnnotation(existingAnnotation.annotationUID);
        }
      }
    });
  };

  const onAnnotationModified = evt => {
    const { annotation: modifiedAnnotation } = evt.detail || {};

    if (modifiedAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    // Update modification timestamp when annotation is edited
    if (modifiedAnnotation.data) {
      modifiedAnnotation.data.modifiedAt = Date.now();
    }

    if (
      !modifiedAnnotation.metadata?.referencedImageId ||
      !modifiedAnnotation.data?.frameNumber ||
      !modifiedAnnotation.data?.seriesInstanceUID
    ) {
      const activeContext = getActiveViewportContext(servicesManager);
      const imageId = activeContext?.viewport?.getCurrentImageId?.();
      const frameNumber = activeContext?.viewport ? resolveFrameNumber(activeContext.viewport) : undefined;
      const seriesInfo = getSeriesIdentifiersFromViewport(
        servicesManager,
        activeContext?.viewport,
        activeContext?.viewportInfo
      );
      if (!modifiedAnnotation.metadata?.referencedImageId && imageId) {
        modifiedAnnotation.metadata = {
          ...modifiedAnnotation.metadata,
          referencedImageId: imageId,
        };
      }
      if (!modifiedAnnotation.data?.frameNumber && frameNumber !== undefined) {
        modifiedAnnotation.data.frameNumber = frameNumber;
      }
      if (!modifiedAnnotation.data?.seriesInstanceUID && seriesInfo.seriesInstanceUID) {
        modifiedAnnotation.data.seriesInstanceUID = seriesInfo.seriesInstanceUID;
      }
      if (!modifiedAnnotation.data?.studyInstanceUID && seriesInfo.studyInstanceUID) {
        modifiedAnnotation.data.studyInstanceUID = seriesInfo.studyInstanceUID;
      }
    }
  };

  eventTarget.addEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_MODIFIED, onAnnotationModified);

  const onKeyDown = (evt: KeyboardEvent) => {
    if (!isManualContourActive && !isManualContourToolActive(servicesManager)) {
      return;
    }

    const isPaste =
      (evt.ctrlKey || evt.metaKey) && evt.key?.toLowerCase?.() === 'v' && !evt.shiftKey;
    if (!isPaste) {
      return;
    }

    const target = evt.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    const { viewport, element } = getActiveViewportContext(servicesManager);
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
    const seriesInfo = getSeriesIdentifiersFromViewport(
      servicesManager,
      viewport,
      getActiveViewportContext(servicesManager)?.viewportInfo
    );
    const annotations = getManualContourAnnotations(frameOfReferenceUID).filter(contour => {
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
      if (contour?.data?.labelId !== activeLabelId) {
        return false;
      }
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
      if (contour?.data?.labelId !== activeLabelId) {
        return false;
      }
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
      // Fallback: pick the closest prior frame for this label
      const priorByFrame = annotations
        .filter(contour => contour?.data?.labelId === activeLabelId)
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

    const newAnnotation = createManualContourAnnotation({
      sourceAnnotation,
      referencedImageId: currentImageId,
      frameNumber: currentFrameNumber,
      seriesInstanceUID: seriesInfo.seriesInstanceUID,
      studyInstanceUID: seriesInfo.studyInstanceUID,
    });

    annotation.state.addAnnotation(newAnnotation);
    isManualContourActive = true;

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
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_MODIFIED, onAnnotationModified);
    window?.removeEventListener?.('keydown', onKeyDown);
    removeManualContourHints();
  };
}
