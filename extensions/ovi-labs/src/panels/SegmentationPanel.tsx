import React, { useEffect, useCallback, useState, useRef } from 'react';
import { eventTarget, utilities as csUtils } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums, utilities as toolUtils } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';
import {
  SegmentationModelSelector,
  SegmentationLabelsList,
  SegmentationExportControls,
} from '../components/segmentation';
import { DicomMetadataStore } from '@ohif/core';
import {
  SEGMENTATION_LABELS,
  syncLabelsFromAnnotations,
  getSegmentationState,
  subscribeSegmentationState,
} from '../utils/segmentationStore';
import { maskToContours } from '../utils/maskToContour';
import { runMaskedOtsu } from '../utils/otsuThresholding';
import {
  cacheSegmentationFrame,
  getCachedSegmentationFrame,
  hydrateSegmentationCache,
} from '../utils/segmentationManager';

interface SegmentationPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

const MANUAL_CONTOUR_TOOL_NAME = 'ManualContour';
const MASK_CONTOUR_TOOL_NAME = 'MaskContour';
const ROI_TOOL_NAME = 'RotatableRectangleROI';

/**
 * Segmentation Panel
 *
 * Provides controls for:
 * - Model selection (Manual, Threshold, MedSAM, UNet-Uterine)
 * - Labels list with visibility/opacity controls
 * - Export functionality (NIfTI format)
 */
const SegmentationPanel: React.FC<SegmentationPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  const [roiAnnotation, setRoiAnnotation] = useState<any>(null);
  const [revision, setRevision] = useState(0);
  const [currentImageId, setCurrentImageId] = useState<string | undefined>(undefined);
  const [activeModel, setActiveModelState] = useState(getSegmentationState().activeModel);
  const [otsuClasses, setOtsuClasses] = useState(4);
  const [{ activeViewportId }] = useViewportGrid();
  const hydratedSeriesRef = useRef<Set<string>>(new Set());

  const getActiveFrameOfReferenceUID = useCallback(() => {
    if (!activeViewportId || !servicesManager) return undefined;

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    if (!cornerstoneViewportService) return undefined;

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    return viewport?.getFrameOfReferenceUID?.();
  }, [activeViewportId, servicesManager]);

  const getActiveSeriesInstanceUID = useCallback(() => {
    if (!activeViewportId || !servicesManager) return undefined;

    const { cornerstoneViewportService, displaySetService } = servicesManager?.services || {};
    if (!cornerstoneViewportService || !displaySetService) return undefined;

    const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
    const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
    const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
    if (displaySetInstanceUID) {
      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
      return displaySet?.SeriesInstanceUID;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    const imageId = viewport?.getCurrentImageId?.();
    if (imageId) {
      const instance = DicomMetadataStore.getInstanceByImageId(imageId);
      return instance?.SeriesInstanceUID;
    }

    return undefined;
  }, [activeViewportId, servicesManager]);

  // Get current image ID from viewport
  const getCurrentImageId = useCallback(() => {
    if (!activeViewportId || !servicesManager) return undefined;

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    if (!cornerstoneViewportService) return undefined;

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) return undefined;

    try {
      const currentImageIdIndex = viewport.getCurrentImageIdIndex?.();
      const imageIds = viewport.getImageIds?.();
      if (imageIds && currentImageIdIndex !== undefined) {
        return imageIds[currentImageIdIndex];
      }
    } catch (e) {
      console.warn('Failed to get current image ID:', e);
    }

    return undefined;
  }, [activeViewportId, servicesManager]);

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setActiveModelState(state.activeModel);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!currentImageId) return;
    const instance = DicomMetadataStore.getInstanceByImageId(currentImageId);
    const seriesInstanceUID = instance?.SeriesInstanceUID;
    if (!seriesInstanceUID || hydratedSeriesRef.current.has(seriesInstanceUID)) {
      return;
    }

    void hydrateSegmentationCache(seriesInstanceUID).then(() => {
      hydratedSeriesRef.current.add(seriesInstanceUID);
    });
  }, [currentImageId]);

  // Get the ROI annotation
  const getSelectedAnalysisRoi = useCallback(() => {
    const annotationManager = annotation.state.getAnnotationManager();
    const framesOfReference = annotationManager.getFramesOfReference() || [];

    for (const frameOfReferenceUID of framesOfReference) {
      const annotations = annotationManager.getAnnotations(frameOfReferenceUID, ROI_TOOL_NAME) || [];
      if (annotations.length) {
        return annotations[0];
      }
    }

    return null;
  }, []);

  const isPointInPolygon = (point: [number, number], polygon: number[][]): boolean => {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];

      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

      if (intersect) {
        inside = !inside;
      }
    }

    return inside;
  };

  const createContoursFromLabelMask = useCallback(
    ({
      labels,
      width,
      height,
      labelMap,
      modelType,
      viewport,
      element,
      frameOfReferenceUID,
    }: {
      labels: Uint8Array;
      width: number;
      height: number;
      labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }>;
      modelType: string;
      viewport: any;
      element: HTMLElement;
      frameOfReferenceUID: string;
    }) => {
      const annotationManager = annotation.state.getAnnotationManager();
      if (!annotationManager) return;

      const existingContours =
        annotationManager.getAnnotations(frameOfReferenceUID, MANUAL_CONTOUR_TOOL_NAME) || [];
      existingContours.forEach(existing => {
        if (
          (existing.data?.modelType || 'manual') === modelType &&
          (!currentImageId || existing.metadata?.referencedImageId === currentImageId)
        ) {
          annotation.state.removeAnnotation(existing.annotationUID);
        }
      });

      const now = Date.now();
      Object.entries(labelMap).forEach(([indexString, labelInfo]) => {
        const labelValue = Number(indexString);
        const contours = maskToContours(labels, width, height, labelValue);
        contours.forEach(contour => {
          if (contour.length < 3) return;
          const worldPoints = contour.map(point => viewport.canvasToWorld(point));

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
              referencedImageId: currentImageId,
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
              modelType,
              createdAt: now,
              modifiedAt: now,
            },
          });

          annotation.config.style.setAnnotationStyles(annotationUID, {
            color: labelInfo.labelColor,
            colorHighlighted: labelInfo.labelColor,
            colorSelected: labelInfo.labelColor,
          });
        });
      });

      const viewportIdsToRender = toolUtils.viewportFilters.getViewportIdsWithToolToRender(
        element,
        MANUAL_CONTOUR_TOOL_NAME
      );
      toolUtils.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    },
    [currentImageId]
  );

  const runOtsuSegmentation = useCallback(() => {
    if (!activeViewportId || !servicesManager) return;

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    const uiNotificationService = servicesManager?.services?.uiNotificationService;
    if (!cornerstoneViewportService) return;

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
    const element = viewportInfo?.element as HTMLElement | undefined;
    const sourceCanvas = element?.querySelector('canvas');

    if (!viewport || !element || !sourceCanvas) {
      uiNotificationService?.show?.({
        title: 'Threshold-Otsu',
        message: 'Unable to access viewport canvas for segmentation.',
        type: 'error',
        duration: 3000,
      });
      return;
    }

    const maskAnnotations = annotation.state.getAnnotations(MASK_CONTOUR_TOOL_NAME, element) || [];
    const targetMask = maskAnnotations.find(mask => {
      if (currentImageId && mask?.metadata?.referencedImageId) {
        return mask.metadata.referencedImageId === currentImageId;
      }
      return true;
    });

    if (!targetMask?.data?.contour?.polyline?.length) {
      uiNotificationService?.show?.({
        title: 'Threshold-Otsu',
        message: 'Draw a mask contour first.',
        type: 'warning',
        duration: 3000,
      });
      return;
    }

    const ctx = sourceCanvas.getContext('2d');
    if (!ctx) return;

    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixelData = new Uint8Array(width * height);

    for (let i = 0; i < width * height; i += 1) {
      pixelData[i] = imageData.data[i * 4];
    }

    const elementWidth = element.clientWidth || width;
    const elementHeight = element.clientHeight || height;
    const scaleX = elementWidth > 0 ? width / elementWidth : 1;
    const scaleY = elementHeight > 0 ? height / elementHeight : 1;
    const needsNormalization = scaleX > 1.01 || scaleY > 1.01;

    const normalizeCanvasPoint = (worldPoint: number[]) => {
      const canvasPoint = viewport.worldToCanvas(worldPoint);
      if (!needsNormalization) {
        return canvasPoint;
      }
      return [canvasPoint[0] / scaleX, canvasPoint[1] / scaleY];
    };

    const polygon = targetMask.data.contour.polyline.map(point => normalizeCanvasPoint(point));
    const maskData = new Uint8Array(width * height);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    polygon.forEach(([x, y]) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });

    const startX = Math.max(0, Math.floor(minX));
    const startY = Math.max(0, Math.floor(minY));
    const endX = Math.min(width - 1, Math.ceil(maxX));
    const endY = Math.min(height - 1, Math.ceil(maxY));

    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        if (isPointInPolygon([x + 0.5, y + 0.5], polygon)) {
          maskData[y * width + x] = 1;
        }
      }
    }

    const { labels } = runMaskedOtsu(pixelData, maskData, otsuClasses);
    const frameOfReferenceUID = viewport.getFrameOfReferenceUID?.();
    const now = Date.now();
    const instance = currentImageId ? DicomMetadataStore.getInstanceByImageId(currentImageId) : null;
    const seriesInstanceUID = instance?.SeriesInstanceUID;

    if (!frameOfReferenceUID) return;

    const labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }> = {};
    SEGMENTATION_LABELS.slice(0, otsuClasses).forEach((labelDef, index) => {
      labelMap[index + 1] = {
        labelId: labelDef.id,
        labelName: labelDef.name,
        labelColor: labelDef.color,
      };
    });

    createContoursFromLabelMask({
      labels,
      width,
      height,
      labelMap,
      modelType: 'threshold',
      viewport,
      element,
      frameOfReferenceUID,
    });

    if (seriesInstanceUID) {
      void cacheSegmentationFrame({
        seriesInstanceUID,
        model: 'threshold',
        frameKey: currentImageId || `frame:${now}`,
        width,
        height,
        maskData: labels,
        labelMap,
      });
    }

    uiNotificationService?.show?.({
      title: 'Threshold-Otsu',
      message: 'Otsu segmentation computed for current frame.',
      type: 'success',
      duration: 2500,
    });
  }, [activeViewportId, servicesManager, currentImageId, otsuClasses, createContoursFromLabelMask]);

  useEffect(() => {
    if (activeModel !== 'threshold' || !currentImageId || !servicesManager || !activeViewportId) {
      return;
    }

    const instance = DicomMetadataStore.getInstanceByImageId(currentImageId);
    const seriesInstanceUID = instance?.SeriesInstanceUID;
    if (!seriesInstanceUID) return;

    const cached = getCachedSegmentationFrame(seriesInstanceUID, 'threshold', currentImageId);
    if (!cached) return;

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport(activeViewportId);
    const viewportInfo = cornerstoneViewportService?.getViewportInfo(activeViewportId);
    const element = viewportInfo?.element as HTMLElement | undefined;
    const frameOfReferenceUID = viewport?.getFrameOfReferenceUID?.();
    const annotationManager = annotation.state.getAnnotationManager();

    if (!viewport || !element || !frameOfReferenceUID || !annotationManager) return;

    const existingContours =
      annotationManager.getAnnotations(frameOfReferenceUID, MANUAL_CONTOUR_TOOL_NAME) || [];
    const hasThreshold = existingContours.some(existing => {
      const matchesModel = (existing.data?.modelType || 'manual') === 'threshold';
      const matchesFrame =
        !currentImageId || existing.metadata?.referencedImageId === currentImageId;
      return matchesModel && matchesFrame;
    });

    if (!hasThreshold) {
      createContoursFromLabelMask({
        labels: cached.maskData,
        width: cached.width,
        height: cached.height,
        labelMap: cached.labelMap,
        modelType: 'threshold',
        viewport,
        element,
        frameOfReferenceUID,
      });
    }
  }, [activeModel, currentImageId, servicesManager, activeViewportId, createContoursFromLabelMask]);

  // Sync labels from ManualContour annotations
  const updateLabelsFromAnnotations = useCallback(() => {
    try {
      const activeFrameOfReferenceUID = getActiveFrameOfReferenceUID();
      const activeSeriesInstanceUID = getActiveSeriesInstanceUID();
      const annotationManager = annotation.state.getAnnotationManager();
      const contours: any[] = [];

      const viewportInfo =
        servicesManager?.services?.cornerstoneViewportService?.getViewportInfo?.(activeViewportId);
      const element = viewportInfo?.element;

      const applySeriesFilter = (annotations: any[]) => {
        if (!activeSeriesInstanceUID) {
          return annotations;
        }

        return annotations.filter(contour => {
          const contourSeries = contour?.data?.seriesInstanceUID;
          if (contourSeries) {
            return contourSeries === activeSeriesInstanceUID;
          }

          const imageId = contour?.metadata?.referencedImageId;
          if (!imageId) {
            return false;
          }

          const instance = DicomMetadataStore.getInstanceByImageId(imageId);
          return instance?.SeriesInstanceUID === activeSeriesInstanceUID;
        });
      };

      if (element) {
        const elementAnnotations = annotation.state.getAnnotations(
          MANUAL_CONTOUR_TOOL_NAME,
          element
        );
        contours.push(...applySeriesFilter(elementAnnotations || []));
      } else {
        const framesOfReference = annotationManager.getFramesOfReference() || [];
        for (const frameOfReferenceUID of framesOfReference) {
          if (activeFrameOfReferenceUID && frameOfReferenceUID !== activeFrameOfReferenceUID) {
            continue;
          }
          const annotations =
            annotationManager.getAnnotations(frameOfReferenceUID, MANUAL_CONTOUR_TOOL_NAME) || [];
          contours.push(...applySeriesFilter(annotations));
        }
      }

      syncLabelsFromAnnotations(contours);
    } catch (e) {
      console.warn('Failed to sync segmentation labels:', e);
    }
  }, [getActiveFrameOfReferenceUID, getActiveSeriesInstanceUID]);

  // Debounce timer ref
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Subscribe to annotation events with debounce to avoid race conditions
  // The debounce ensures setupManualContourBehavior's cleanup runs before we sync
  useEffect(() => {
    const viewportGridService = servicesManager?.services?.viewportGridService;
    const displaySetService = servicesManager?.services?.displaySetService;
    const updateAll = () => {
      updateLabelsFromAnnotations();
      setRoiAnnotation(getSelectedAnalysisRoi());
      setCurrentImageId(getCurrentImageId());
      setRevision(r => r + 1);
    };

    const debouncedUpdate = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // Small delay to let setupManualContourBehavior's cleanup run first
      debounceTimerRef.current = setTimeout(updateAll, 50);
    };

    // Update current image ID without full sync (for viewport scroll)
    const updateCurrentFrame = () => {
      setCurrentImageId(getCurrentImageId());
    };

    // Initial sync (no debounce needed)
    updateAll();

    const addedEvt = toolEnums.Events.ANNOTATION_ADDED;
    const modifiedEvt = toolEnums.Events.ANNOTATION_MODIFIED;
    const removedEvt = toolEnums.Events.ANNOTATION_REMOVED;

    eventTarget.addEventListener(addedEvt, debouncedUpdate);
    eventTarget.addEventListener(modifiedEvt, debouncedUpdate);
    eventTarget.addEventListener(removedEvt, debouncedUpdate);

    // Subscribe to viewport scroll/image change events
    const scrollEvt = 'CORNERSTONE_STACK_SCROLL';
    eventTarget.addEventListener(scrollEvt, updateCurrentFrame);

    const subscriptions = [];
    if (viewportGridService?.subscribe) {
      subscriptions.push(
        viewportGridService.subscribe(
          viewportGridService.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED,
          debouncedUpdate
        )
      );
      subscriptions.push(
        viewportGridService.subscribe(viewportGridService.EVENTS.GRID_STATE_CHANGED, debouncedUpdate)
      );
      subscriptions.push(
        viewportGridService.subscribe(viewportGridService.EVENTS.VIEWPORTS_READY, debouncedUpdate)
      );
    }

    if (displaySetService?.subscribe) {
      subscriptions.push(
        displaySetService.subscribe(displaySetService.EVENTS.DISPLAY_SETS_CHANGED, debouncedUpdate)
      );
      subscriptions.push(
        displaySetService.subscribe(displaySetService.EVENTS.DISPLAY_SETS_ADDED, debouncedUpdate)
      );
      subscriptions.push(
        displaySetService.subscribe(displaySetService.EVENTS.DISPLAY_SETS_REMOVED, debouncedUpdate)
      );
    }

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      eventTarget.removeEventListener(addedEvt, debouncedUpdate);
      eventTarget.removeEventListener(modifiedEvt, debouncedUpdate);
      eventTarget.removeEventListener(removedEvt, debouncedUpdate);
      eventTarget.removeEventListener(scrollEvt, updateCurrentFrame);
      subscriptions.forEach(subscription => subscription.unsubscribe());
    };
  }, [updateLabelsFromAnnotations, getSelectedAnalysisRoi, getCurrentImageId]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-black text-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <h3 className="text-sm font-medium">Segmentation</h3>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        {/* Model Selector Section */}
        <div className="flex flex-col gap-2">
          <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Model
          </label>
          <SegmentationModelSelector
            commandsManager={commandsManager}
            servicesManager={servicesManager}
            onRecompute={runOtsuSegmentation}
          />
          {activeModel === 'threshold' && (
            <div className="flex items-center justify-between gap-2 rounded border border-gray-800 bg-gray-900 px-3 py-2 text-[10px] text-gray-200">
              <span className="text-gray-400">Classes</span>
              <select
                className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-[10px]"
                value={otsuClasses}
                onChange={evt => setOtsuClasses(Number(evt.target.value))}
              >
                {[2, 3, 4, 5].map(value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Labels List Section */}
        <div className="flex flex-1 flex-col gap-2">
          <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Labels
          </label>
          <SegmentationLabelsList
            servicesManager={servicesManager}
            activeViewportId={activeViewportId}
            roiAnnotation={roiAnnotation}
            revision={revision}
            currentImageId={currentImageId}
          />
        </div>

        {/* Export Controls Section */}
        <SegmentationExportControls servicesManager={servicesManager} />
      </div>
    </div>
  );
};

export default SegmentationPanel;
