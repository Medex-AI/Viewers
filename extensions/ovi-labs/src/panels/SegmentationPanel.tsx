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
import segmentationApi from '../services/segmentationApi';
import { getModelParams } from '../utils/segmentationParamsStore';

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
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [recomputeStatusText, setRecomputeStatusText] = useState<string | undefined>(undefined);
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
      referencedImageId,
    }: {
      labels: Uint8Array;
      width: number;
      height: number;
      labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }>;
      modelType: string;
      viewport: any;
      element: HTMLElement;
      frameOfReferenceUID: string;
      referencedImageId?: string;
    }) => {
      const annotationManager = annotation.state.getAnnotationManager();
      if (!annotationManager) return;

      const existingContours =
        annotationManager.getAnnotations(frameOfReferenceUID, MANUAL_CONTOUR_TOOL_NAME) || [];
      existingContours.forEach(existing => {
        if (
          (existing.data?.modelType || 'manual') === modelType &&
          (!referencedImageId || existing.metadata?.referencedImageId === referencedImageId)
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
              referencedImageId,
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
    []
  );

  const runOtsuSegmentation = useCallback(async () => {
    if (!activeViewportId || !servicesManager) return;

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    const uiNotificationService = servicesManager?.services?.uiNotificationService;
    if (!cornerstoneViewportService) return;

    // Get active model from segmentationStore
    const { activeModel: selectedModel } = getSegmentationState();

    // If manual, do nothing (manual annotations are drawn directly)
    if (selectedModel === 'manual') {
      return;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
    const element = viewportInfo?.element as HTMLElement | undefined;

    if (!viewport || !element) {
      uiNotificationService?.show?.({
        title: 'Segmentation',
        message: 'Unable to access viewport for segmentation.',
        type: 'error',
        duration: 3000,
      });
      return;
    }

    const getCanvasGrayscale = () => {
      const sourceCanvas = element.querySelector('canvas');
      if (!sourceCanvas) {
        return null;
      }
      const ctx = sourceCanvas.getContext('2d');
      if (!ctx) {
        return null;
      }
      const width = sourceCanvas.width;
      const height = sourceCanvas.height;
      const imageData = ctx.getImageData(0, 0, width, height);
      const pixelArray: number[][] = [];
      for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          row.push(imageData.data[i]);
        }
        pixelArray.push(row);
      }
      return { width, height, pixelArray };
    };

    const waitForViewportFrame = async (ms: number = 40) => {
      await new Promise(resolve => setTimeout(resolve, ms));
    };

    const mapBackendLabelId = (label: { id: number; name: string }) => {
      const byId: Record<number, string> = {
        1: 'uterineCavity',
        2: 'junctionalZone',
        3: 'endometrium',
        4: 'myometrium',
      };

      if (byId[label.id]) {
        return byId[label.id];
      }

      const normalized = label.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized.includes('uterinecavity')) return 'uterineCavity';
      if (normalized.includes('junctionalzone')) return 'junctionalZone';
      if (normalized.includes('endometrium')) return 'endometrium';
      if (normalized.includes('myometrium')) return 'myometrium';
      return 'uterineCavity';
    };

    const buildMaskArray = (maskAnnotation: any, width: number, height: number) => {
      if (!maskAnnotation?.data?.contour?.polyline?.length) {
        return undefined;
      }

      const viewportElementWidth = element.clientWidth || width;
      const viewportElementHeight = element.clientHeight || height;
      const scaleX = viewportElementWidth > 0 ? width / viewportElementWidth : 1;
      const scaleY = viewportElementHeight > 0 ? height / viewportElementHeight : 1;
      const needsNormalization = scaleX > 1.01 || scaleY > 1.01;

      const normalizeCanvasPoint = (worldPoint: number[]) => {
        const canvasPoint = viewport.worldToCanvas(worldPoint);
        if (!needsNormalization) {
          return canvasPoint;
        }
        return [canvasPoint[0] / scaleX, canvasPoint[1] / scaleY];
      };

      const polygon = maskAnnotation.data.contour.polyline.map((point: number[]) =>
        normalizeCanvasPoint(point)
      );

      const binaryMask: number[][] = [];
      for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
          row.push(isPointInPolygon([x + 0.5, y + 0.5], polygon) ? 1 : 0);
        }
        binaryMask.push(row);
      }
      return binaryMask;
    };

    // Extract mask contour (optional)
    const maskAnnotations = annotation.state.getAnnotations(MASK_CONTOUR_TOOL_NAME, element) || [];
    const targetMask =
      maskAnnotations.find(mask => {
        if (currentImageId && mask?.metadata?.referencedImageId) {
          return mask.metadata.referencedImageId === currentImageId;
        }
        return false;
      }) ||
      maskAnnotations[0];

    const modelParams = getModelParams(selectedModel);
    const viewportImageIds = viewport.getImageIds?.() || [];
    const currentIndex = viewport.getCurrentImageIdIndex?.() ?? 0;
    const runAcrossTime = selectedModel === 'otsu' && viewportImageIds.length > 1;
    const frameTargets = runAcrossTime
      ? viewportImageIds.map((imageId: string, index: number) => ({ imageId, index }))
      : [
          {
            imageId: currentImageId || viewportImageIds[currentIndex],
            index: currentIndex,
          },
        ].filter((item): item is { imageId: string; index: number } => Boolean(item.imageId));

    if (frameTargets.length === 0) {
      uiNotificationService?.show?.({
        title: 'Segmentation',
        message: 'No image frames are available for segmentation.',
        type: 'error',
        duration: 3000,
      });
      return;
    }

    const originalFrameIndex = viewport.getCurrentImageIdIndex?.() ?? 0;

    try {
      setIsRecomputing(true);
      setRecomputeStatusText(
        runAcrossTime
          ? `Running ${selectedModel} segmentation across ${frameTargets.length} frames...`
          : `Running ${selectedModel} segmentation...`
      );

      uiNotificationService?.show?.({
        title: 'Segmentation',
        message: runAcrossTime
          ? `Running ${selectedModel} across ${frameTargets.length} frames...`
          : `Running ${selectedModel} segmentation...`,
        type: 'info',
        duration: 2000,
      });

      for (let frameIdx = 0; frameIdx < frameTargets.length; frameIdx++) {
        const target = frameTargets[frameIdx];
        setRecomputeStatusText(
          runAcrossTime
            ? `Awaiting result for frame ${frameIdx + 1}/${frameTargets.length}...`
            : 'Awaiting segmentation result...'
        );

        if (runAcrossTime && viewport.setImageIdIndex) {
          viewport.setImageIdIndex(target.index);
          viewport.render?.();
          await waitForViewportFrame();
        }

        const frameData = getCanvasGrayscale();
        if (!frameData) {
          throw new Error('Unable to capture viewport canvas for segmentation.');
        }

        const maskArray = buildMaskArray(targetMask, frameData.width, frameData.height);
        const prompt = maskArray
          ? {
              type: 'mask' as const,
              data: { mask: maskArray },
            }
          : undefined;

        const jobResponse = await segmentationApi.submitJob({
          model_id: selectedModel,
          image: frameData.pixelArray,
          prompt,
          params: modelParams,
        });

        const result = await segmentationApi.pollJob(jobResponse.job_id, 120000);
        if (result.status === 'failed') {
          throw new Error(result.error || 'Segmentation failed');
        }
        if (!result.result) {
          throw new Error('No segmentation result returned');
        }

        const labels = new Uint8Array(frameData.width * frameData.height);
        result.result.mask.forEach((row, y) => {
          row.forEach((value, x) => {
            labels[y * frameData.width + x] = value;
          });
        });

        const labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }> = {};
        result.result.labels.forEach(label => {
          labelMap[label.id] = {
            labelId: mapBackendLabelId(label),
            labelName: label.name,
            labelColor: label.color,
          };
        });

        const frameOfReferenceUID = viewport.getFrameOfReferenceUID?.();
        if (!frameOfReferenceUID) {
          throw new Error('Missing frame of reference for segmentation output.');
        }

        createContoursFromLabelMask({
          labels,
          width: frameData.width,
          height: frameData.height,
          labelMap,
          modelType: selectedModel,
          viewport,
          element,
          frameOfReferenceUID,
          referencedImageId: target.imageId,
        });

        const instance = DicomMetadataStore.getInstanceByImageId(target.imageId);
        const seriesInstanceUID = instance?.SeriesInstanceUID;
        if (seriesInstanceUID) {
          void cacheSegmentationFrame({
            seriesInstanceUID,
            model: selectedModel,
            frameKey: target.imageId,
            width: frameData.width,
            height: frameData.height,
            maskData: labels,
            labelMap,
          });
        }
      }

      uiNotificationService?.show?.({
        title: 'Segmentation Complete',
        message: runAcrossTime
          ? `${selectedModel} segmentation completed for ${frameTargets.length} frames.`
          : `${selectedModel} segmentation completed successfully.`,
        type: 'success',
        duration: 2500,
      });
    } catch (error) {
      console.error('Segmentation error:', error);
      uiNotificationService?.show?.({
        title: 'Segmentation Failed',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        type: 'error',
        duration: 5000,
      });
    } finally {
      if (runAcrossTime && viewport.setImageIdIndex) {
        viewport.setImageIdIndex(originalFrameIndex);
        viewport.render?.();
      }
      setRecomputeStatusText(undefined);
      setIsRecomputing(false);
    }
  }, [activeViewportId, servicesManager, currentImageId, createContoursFromLabelMask]);

  useEffect(() => {
    if (activeModel !== 'otsu' || !currentImageId || !servicesManager || !activeViewportId) {
      return;
    }

    const instance = DicomMetadataStore.getInstanceByImageId(currentImageId);
    const seriesInstanceUID = instance?.SeriesInstanceUID;
    if (!seriesInstanceUID) return;

    const cached = getCachedSegmentationFrame(seriesInstanceUID, 'otsu', currentImageId);
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
    const hasOtsu = existingContours.some(existing => {
      const matchesModel = (existing.data?.modelType || 'manual') === 'otsu';
      const matchesFrame =
        !currentImageId || existing.metadata?.referencedImageId === currentImageId;
      return matchesModel && matchesFrame;
    });

    if (!hasOtsu) {
      createContoursFromLabelMask({
        labels: cached.maskData,
        width: cached.width,
        height: cached.height,
        labelMap: cached.labelMap,
        modelType: 'otsu',
        viewport,
        element,
        frameOfReferenceUID,
        referencedImageId: currentImageId,
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
            isRecomputing={isRecomputing}
            recomputeStatusText={recomputeStatusText}
          />
          {/* Model configuration is now handled via gear icon modal */}
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
