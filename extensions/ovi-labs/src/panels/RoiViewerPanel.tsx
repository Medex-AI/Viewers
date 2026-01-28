import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cache, eventTarget, Enums as csEnums, metaData } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';
import {
  getRoiAnalysisData,
  setRoiAnalysisData,
} from '../utils/roiAnalysisDataStore';
import { setFrameRateFromMetadata } from '../utils/frameRateStore';
import { extractFrameTimingFromImageIds, logFrameTiming } from '../utils/dicomMetadataExtractor';
import {
  getKymographSettings,
  subscribeKymographSettings,
} from '../utils/kymographSettingsStore';
import {
  getRoiPreviewSettings,
  subscribeRoiPreviewSettings,
} from '../utils/roiPreviewSettingsStore';
import {
  SEGMENTATION_LABELS,
  getSegmentationState,
  setActiveModel,
  setLabelVisibility,
  subscribeSegmentationState,
  ModelType,
  SegmentationLabel,
  syncLabelsFromAnnotations,
} from '../utils/segmentationStore';
import { setRoiSegmentationFrame } from '../utils/roiSegmentationStore';
import {
  buildNiftiBuffer,
  buildTiffBuffer,
  downloadBlob,
  gzipBuffer,
  requestSaveHandle,
  RoiExportFrame,
  writeBufferToHandle,
} from '../utils/roiExport';

interface RoiViewerPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

const TOOL_NAME = 'RotatableRectangleROI';
const TOOL_GROUP_ID = 'default';
const MEDEX_ORANGE = '#F47620';
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 480;
const MAX_ANALYSIS_SAMPLES = 256;
const MANUAL_CONTOUR_TOOL = 'ManualContour';
const MASK_CONTOUR_TOOL = 'MaskContour';
const MASK_CONTOUR_COLOR = '#94A3B8';

const hexToRgb = (hex: string): [number, number, number] => {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) {
    return [255, 255, 255];
  }
  const intValue = parseInt(normalized, 16);
  return [(intValue >> 16) & 255, (intValue >> 8) & 255, intValue & 255];
};

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
/**
 * ROI Viewer Panel - Placeholder
 *
 * Future features:
 * - Display oriented ROI region preview
 * - Show current frame's ROI content
 * - Optional segmentation mask overlay
 * - Orientation indicator
 */
const RoiViewerPanel: React.FC<RoiViewerPanelProps> = ({
  commandsManager,
  servicesManager,
  extensionManager,
}) => {
  const [roiAnnotation, setRoiAnnotation] = useState<any>(null);
  const [roiPreviewUrl, setRoiPreviewUrl] = useState<string | null>(null);
  const [roiRevision, setRoiRevision] = useState(0);
  const [frameInfo, setFrameInfo] = useState<{ index: number | null; total: number | null }>({
    index: null,
    total: null,
  });
  const [showSpacingWarning, setShowSpacingWarning] = useState(false);
  const [segmentationModel, setSegmentationModelLocal] = useState<ModelType>(
    getSegmentationState().activeModel
  );
  const [segmentationLabels, setSegmentationLabels] = useState<SegmentationLabel[]>(
    getSegmentationState().labels
  );
  const [currentFrameLabels, setCurrentFrameLabels] = useState<Set<string>>(new Set());
  const [kymographSettings, setKymographSettings] = useState(getKymographSettings());
  const [roiPreviewSettings, setRoiPreviewSettings] = useState(getRoiPreviewSettings());
  const [exportFormat, setExportFormat] = useState<'nifti' | 'nifti_gz' | 'tiff' | 'debug'>('nifti_gz');
  const debugPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const accuratePreviewTimeoutRef = useRef<number | null>(null);
  const accuratePreviewTokenRef = useRef(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [previewMode, setPreviewMode] = useState<'fast' | 'accurate'>('fast');
  const exportInProgressRef = useRef(false);
  const seriesKeyRef = useRef<string | null>(null);
  const [{ activeViewportId }] = useViewportGrid();
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
  const displaySetService = servicesManager?.services?.displaySetService;
  const viewportGridService = servicesManager?.services?.viewportGridService;
  const uiNotificationService = servicesManager?.services?.uiNotificationService;

  const getActiveImageId = useCallback(() => {
    if (!activeViewportId || !cornerstoneViewportService) {
      return null;
    }
    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) {
      return null;
    }
    const currentImageId = viewport.getCurrentImageId?.();
    if (currentImageId) {
      return currentImageId;
    }
    const imageIds = viewport.getImageIds?.() || [];
    return imageIds[0] || null;
  }, [activeViewportId, cornerstoneViewportService]);

  const getActiveFrameOfReferenceUID = useCallback(() => {
    const imageId = getActiveImageId();
    if (!imageId) {
      return null;
    }
    const instance = metaData.get('instance', imageId) || {};
    return instance.FrameOfReferenceUID || null;
  }, [getActiveImageId]);

  const getActiveSeriesInstanceUID = useCallback(() => {
    if (activeViewportId && cornerstoneViewportService && displaySetService) {
      const viewportInfo = cornerstoneViewportService.getViewportInfo?.(activeViewportId);
      const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
      const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
      const displaySet = displaySetInstanceUID
        ? displaySetService.getDisplaySetByUID(displaySetInstanceUID)
        : null;
      if (displaySet?.SeriesInstanceUID) {
        return displaySet.SeriesInstanceUID;
      }
    }

    const imageId = getActiveImageId();
    if (!imageId) {
      return null;
    }
    const instance = metaData.get('instance', imageId) || {};
    return instance.SeriesInstanceUID || null;
  }, [activeViewportId, cornerstoneViewportService, displaySetService, getActiveImageId]);

  const getSeriesKey = useCallback((imageId?: string | null) => {
    if (!imageId) {
      return null;
    }
    const instance = metaData.get('instance', imageId) || {};
    const studyUid = instance.StudyInstanceUID || '';
    const seriesUid = instance.SeriesInstanceUID || '';
    if (!studyUid && !seriesUid) {
      return null;
    }
    return `${studyUid}::${seriesUid}`;
  }, []);

  const isRoiInActiveSeries = useCallback(
    (annotationToCheck: any) => {
      if (!annotationToCheck) {
        return false;
      }
      const frameOfReferenceUID = getActiveFrameOfReferenceUID();
      const seriesInstanceUID = getActiveSeriesInstanceUID();
      const metadata = annotationToCheck?.metadata || {};
      const data = annotationToCheck?.data || {};
      const annotationFrameUID = metadata.FrameOfReferenceUID || data.FrameOfReferenceUID;
      const annotationSeriesUID =
        metadata.SeriesInstanceUID || data.seriesInstanceUID || data.SeriesInstanceUID;

      if ((frameOfReferenceUID || seriesInstanceUID) && !annotationFrameUID && !annotationSeriesUID) {
        return false;
      }
      if (frameOfReferenceUID && annotationFrameUID && annotationFrameUID !== frameOfReferenceUID) {
        return false;
      }
      if (seriesInstanceUID && annotationSeriesUID && annotationSeriesUID !== seriesInstanceUID) {
        return false;
      }
      return true;
    },
    [getActiveFrameOfReferenceUID, getActiveSeriesInstanceUID]
  );

  useEffect(() => {
    const annotationManager = annotation.state.getAnnotationManager();
    const debounceRef = { current: null as NodeJS.Timeout | null };

    const updateLabels = () => {
      if (!annotationManager || !activeViewportId || !cornerstoneViewportService) {
        return;
      }

      const viewportInfo = cornerstoneViewportService.getViewportInfo?.(activeViewportId);
      const element = viewportInfo?.element;
      let contours: any[] = [];

      if (element) {
        contours =
          annotation.state.getAnnotations('ManualContour', element as HTMLElement) || [];
      } else {
        const frames = annotationManager.getFramesOfReference() || [];
        frames.forEach(frame => {
          const annotationsForFrame =
            annotationManager.getAnnotations(frame, 'ManualContour') || [];
          contours.push(...annotationsForFrame);
        });
      }

      if (displaySetService && viewportInfo?.getDisplaySetOptions) {
        const displaySetOptions = viewportInfo.getDisplaySetOptions?.();
        const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
        const displaySet = displaySetInstanceUID
          ? displaySetService.getDisplaySetByUID(displaySetInstanceUID)
          : undefined;
        const seriesInstanceUID = displaySet?.SeriesInstanceUID;

        if (seriesInstanceUID) {
          contours = contours.filter(contour => contour?.data?.seriesInstanceUID === seriesInstanceUID);
        }
      }

      syncLabelsFromAnnotations(contours);
    };

    const debouncedUpdate = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(updateLabels, 50);
    };

    const addedEvt = toolEnums.Events.ANNOTATION_ADDED;
    const modifiedEvt = toolEnums.Events.ANNOTATION_MODIFIED;
    const removedEvt = toolEnums.Events.ANNOTATION_REMOVED;

    eventTarget.addEventListener(addedEvt, debouncedUpdate);
    eventTarget.addEventListener(modifiedEvt, debouncedUpdate);
    eventTarget.addEventListener(removedEvt, debouncedUpdate);

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
    }

    updateLabels();

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      eventTarget.removeEventListener(addedEvt, debouncedUpdate);
      eventTarget.removeEventListener(modifiedEvt, debouncedUpdate);
      eventTarget.removeEventListener(removedEvt, debouncedUpdate);
      subscriptions.forEach(subscription => subscription.unsubscribe());
    };
  }, [activeViewportId, cornerstoneViewportService, displaySetService, viewportGridService]);

  useEffect(() => {
    const unsubscribe = subscribeKymographSettings(settings => {
      setKymographSettings(settings);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeRoiPreviewSettings(settings => {
      setRoiPreviewSettings(settings);
    });
    return unsubscribe;
  }, []);

  // Subscribe to segmentation store for model/visibility sync
  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setSegmentationModelLocal(state.activeModel);
      setSegmentationLabels(state.labels);
      // Trigger preview re-render by incrementing revision
      // This will cause renderRoiPreview to run, which calls scheduleAccuratePreview
      if (roiAnnotation) {
        setRoiRevision(prev => prev + 1);
      }
    });
    return unsubscribe;
  }, [roiAnnotation]);

  const handleSegmentationModelChange = (model: string) => {
    setActiveModel(model as ModelType);
  };

  const buildRoiAnalysisData = useCallback(() => {
    if (!roiAnnotation || !activeViewportId || !cornerstoneViewportService) {
      setRoiAnalysisData(null);
      return;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) {
      setRoiAnalysisData(null);
      return;
    }

    const points = roiAnnotation?.data?.handles?.points?.slice(0, 4) || [];
    if (points.length < 4) {
      setRoiAnalysisData(null);
      return;
    }

    const imageIds = viewport.getImageIds?.() || [];
    const currentImageId = viewport.getCurrentImageId?.();
    const resolvedImageIds = [
      ...(currentImageId ? [currentImageId] : []),
      ...imageIds.filter(id => id !== currentImageId),
    ];

    if (!resolvedImageIds.length) {
      setRoiAnalysisData(null);
      return;
    }

    const existing = getRoiAnalysisData();
    if (
      existing &&
      existing.annotationUID === roiAnnotation.annotationUID &&
      existing.roiRevision === roiRevision &&
      existing.imageIds.length === resolvedImageIds.length &&
      existing.imageIds.every((id, index) => id === resolvedImageIds[index])
    ) {
      return;
    }

    const getWorldToIndex = () => {
      if (viewport.worldToIndex) {
        return (point: number[]) => viewport.worldToIndex(point);
      }

      const imageId = currentImageId || resolvedImageIds[0];
      if (!imageId) {
        return null;
      }

      const imagePlane = metaData.get('imagePlaneModule', imageId);
      const orientation = imagePlane?.imageOrientationPatient;
      const position = imagePlane?.imagePositionPatient;
      const rowSpacing = imagePlane?.rowPixelSpacing ?? 1;
      const colSpacing = imagePlane?.columnPixelSpacing ?? 1;

      if (!orientation || !position) {
        return null;
      }

      const rowCosines = [orientation[0], orientation[1], orientation[2]];
      const colCosines = [orientation[3], orientation[4], orientation[5]];

      return (point: number[]) => {
        const dx = point[0] - position[0];
        const dy = point[1] - position[1];
        const dz = point[2] - position[2];
        const row = (dx * rowCosines[0] + dy * rowCosines[1] + dz * rowCosines[2]) / rowSpacing;
        const col = (dx * colCosines[0] + dy * colCosines[1] + dz * colCosines[2]) / colSpacing;
        return [col, row, 0];
      };
    };

    const worldToIndex = getWorldToIndex();
    if (!worldToIndex) {
      setRoiAnalysisData(null);
      return;
    }

    const indexPoints = points.map(point => worldToIndex(point));
    if (indexPoints.some(point => !point || point.length < 2)) {
      setRoiAnalysisData(null);
      return;
    }

    const bottomLeft = indexPoints[0];
    const bottomRight = indexPoints[1];
    const topLeft = indexPoints[2];

    const widthVec = [
      bottomRight[0] - bottomLeft[0],
      bottomRight[1] - bottomLeft[1],
      (bottomRight[2] || 0) - (bottomLeft[2] || 0),
    ];
    const heightVec = [
      topLeft[0] - bottomLeft[0],
      topLeft[1] - bottomLeft[1],
      (topLeft[2] || 0) - (bottomLeft[2] || 0),
    ];

    const widthLength = Math.hypot(widthVec[0], widthVec[1]);
    const heightLength = Math.hypot(heightVec[0], heightVec[1]);

    if (!widthLength || !heightLength) {
      setRoiAnalysisData(null);
      return;
    }

    const widthSamples = Math.max(1, Math.round(widthLength));
    const heightSamples = Math.max(1, Math.round(heightLength));
    const step = Math.max(
      1,
      Math.ceil(Math.max(widthSamples, heightSamples) / MAX_ANALYSIS_SAMPLES)
    );
    const outputWidth = Math.max(1, Math.floor(widthSamples / step));
    const outputHeight = Math.max(1, Math.floor(heightSamples / step));

    const unitWidth = [widthVec[0] / widthSamples, widthVec[1] / widthSamples];
    const unitHeight = [heightVec[0] / heightSamples, heightVec[1] / heightSamples];

    const frames: Float32Array[] = [];
    const frameImageIds: string[] = [];
    let spacing: { row: number | null; column: number | null } = { row: null, column: null };

    resolvedImageIds.forEach(imageId => {
      const image = cache.getImage(imageId);
      const pixelData = image?.getPixelData?.() ?? image?.pixelData;
      const columns = image?.columns ?? image?.width ?? 0;
      const rows = image?.rows ?? image?.height ?? 0;

      if (!pixelData || !columns || !rows) {
        return;
      }

      if (!spacing.row || !spacing.column) {
        const calibratedSpacing = metaData.get('calibratedPixelSpacing', imageId);
        const imagePlane = metaData.get('imagePlaneModule', imageId);
        spacing = {
          column:
            calibratedSpacing?.columnPixelSpacing ??
            imagePlane?.columnPixelSpacing ??
            null,
          row:
            calibratedSpacing?.rowPixelSpacing ?? imagePlane?.rowPixelSpacing ?? null,
        };
      }

      const frameData = new Float32Array(outputWidth * outputHeight);
      let outputIndex = 0;

      for (let rowIndex = 0; rowIndex < outputHeight; rowIndex += 1) {
        const rowOffset = rowIndex * step + 0.5;
        const baseX = bottomLeft[0] + unitHeight[0] * rowOffset + unitWidth[0] * 0.5;
        const baseY = bottomLeft[1] + unitHeight[1] * rowOffset + unitWidth[1] * 0.5;

        for (let colIndex = 0; colIndex < outputWidth; colIndex += 1) {
          const colOffset = colIndex * step;
          const sampleX = baseX + unitWidth[0] * colOffset;
          const sampleY = baseY + unitWidth[1] * colOffset;

          const col = Math.min(columns - 1, Math.max(0, Math.round(sampleX)));
          const row = Math.min(rows - 1, Math.max(0, Math.round(sampleY)));
          const value = pixelData[row * columns + col];
          frameData[outputIndex] = Number.isFinite(value) ? value : 0;
          outputIndex += 1;
        }
      }

      frames.push(frameData);
      frameImageIds.push(imageId);
    });

    if (!frames.length) {
      setRoiAnalysisData(null);
      return;
    }

    const frameTiming = extractFrameTimingFromImageIds(frameImageIds);
    logFrameTiming(frameTiming);
    const seriesKey = getSeriesKey(frameImageIds[0]);
    const isSeriesChanged = seriesKey && seriesKeyRef.current !== seriesKey;
    if (seriesKey) {
      seriesKeyRef.current = seriesKey;
    }
    setFrameRateFromMetadata(
      frameTiming.frameRate,
      frameTiming.source === 'Default' ? 'default' : 'metadata',
      { force: isSeriesChanged }
    );

    setRoiAnalysisData({
      annotationUID: roiAnnotation.annotationUID,
      roiRevision,
      imageIds: frameImageIds,
      width: outputWidth,
      height: outputHeight,
      step,
      frames,
      spacing,
      frameTimeMs: frameTiming.frameTimeMs,
      frameRate: frameTiming.frameRate,
      frameTimingSource: frameTiming.source,
      createdAt: Date.now(),
    });
  }, [roiAnnotation, activeViewportId, cornerstoneViewportService, roiRevision, getSeriesKey]);

  const buildTemporalRoiStack = useCallback((options: { imageIds?: string[]; maxFrames?: number } = {}) => {
    if (!roiAnnotation || !activeViewportId || !cornerstoneViewportService) {
      return null;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) {
      return null;
    }

    const points = roiAnnotation?.data?.handles?.points?.slice(0, 4) || [];
    if (points.length < 4) {
      return null;
    }

    const imageIds = options.imageIds || viewport.getImageIds?.() || [];
    if (!imageIds.length) {
      return null;
    }
    const limitedImageIds = Number.isFinite(options.maxFrames)
      ? imageIds.slice(0, Math.max(1, options.maxFrames as number))
      : imageIds;

    const shouldLog = (window as any)?.__MEDEX_DEBUG_ROI_EXPORT === true;

    const getWorldToIndex = () => {
      if (viewport.worldToIndex) {
        return (point: number[]) => viewport.worldToIndex(point);
      }

      const imagePlane = metaData.get('imagePlaneModule', imageIds[0]);
      const orientation = imagePlane?.imageOrientationPatient;
      const position = imagePlane?.imagePositionPatient;
      const rowSpacing = imagePlane?.rowPixelSpacing ?? 1;
      const colSpacing = imagePlane?.columnPixelSpacing ?? 1;

      if (shouldLog) {
        // eslint-disable-next-line no-console
        console.info('[ROI Export] imagePlaneModule', {
          imageId: imageIds[0],
          orientation,
          position,
          rowSpacing,
          colSpacing,
        });
      }

      if (!orientation || !position) {
        return null;
      }

      const rowCosines = [orientation[0], orientation[1], orientation[2]];
      const colCosines = [orientation[3], orientation[4], orientation[5]];

      return (point: number[]) => {
        const dx = point[0] - position[0];
        const dy = point[1] - position[1];
        const dz = point[2] - position[2];
        const row = (dx * rowCosines[0] + dy * rowCosines[1] + dz * rowCosines[2]) / rowSpacing;
        const col = (dx * colCosines[0] + dy * colCosines[1] + dz * colCosines[2]) / colSpacing;
        return [col, row, 0];
      };
    };

    const worldToIndex = getWorldToIndex();
    if (!worldToIndex) {
      return null;
    }

    const indexedPoints = points.map(point => ({
      world: point,
      index: worldToIndex(point),
      canvas: viewport.worldToCanvas ? viewport.worldToCanvas(point) : null,
    }));
    if (shouldLog) {
      // eslint-disable-next-line no-console
      console.info('[ROI Export] ROI points', {
        world: indexedPoints.map(item => item.world),
        index: indexedPoints.map(item => item.index),
        canvas: indexedPoints.map(item => item.canvas),
      });
    }
    if (indexedPoints.some(point => !point.index || point.index.length < 2)) {
      return null;
    }

    if (indexedPoints.some(point => !point.canvas || point.canvas.length < 2)) {
      return null;
    }

    const canvasCenter = indexedPoints.reduce(
      (acc, point) => {
        acc[0] += point.canvas![0];
        acc[1] += point.canvas![1];
        return acc;
      },
      [0, 0]
    );
    canvasCenter[0] /= indexedPoints.length;
    canvasCenter[1] /= indexedPoints.length;

    const ordered = {
      topLeft: null as typeof indexedPoints[number] | null,
      topRight: null as typeof indexedPoints[number] | null,
      bottomLeft: null as typeof indexedPoints[number] | null,
      bottomRight: null as typeof indexedPoints[number] | null,
    };

    indexedPoints.forEach(point => {
      const dx = point.canvas![0] - canvasCenter[0];
      const dy = point.canvas![1] - canvasCenter[1];
      if (dx <= 0 && dy <= 0) {
        ordered.topLeft = point;
      } else if (dx > 0 && dy <= 0) {
        ordered.topRight = point;
      } else if (dx <= 0 && dy > 0) {
        ordered.bottomLeft = point;
      } else {
        ordered.bottomRight = point;
      }
    });

    if (!ordered.topLeft || !ordered.topRight || !ordered.bottomLeft || !ordered.bottomRight) {
      return null;
    }

    let bottomLeft = ordered.bottomLeft.index!;
    let bottomRight = ordered.bottomRight.index!;
    let topLeft = ordered.topLeft.index!;

    const canvasTopLeft = ordered.topLeft.canvas!;
    const canvasTopRight = ordered.topRight.canvas!;
    const canvasBottomLeft = ordered.bottomLeft.canvas!;
    const indexTopLeft = ordered.topLeft.index!;
    const indexTopRight = ordered.topRight.index!;
    const indexBottomLeft = ordered.bottomLeft.index!;
    const indexDeltaX = [
      indexTopRight[0] - indexTopLeft[0],
      indexTopRight[1] - indexTopLeft[1],
    ];
    const indexDeltaY = [
      indexBottomLeft[0] - indexTopLeft[0],
      indexBottomLeft[1] - indexTopLeft[1],
    ];
    const xAxisIsCol = Math.abs(indexDeltaX[0]) >= Math.abs(indexDeltaX[1]);
    const yAxisIsRow = Math.abs(indexDeltaY[1]) >= Math.abs(indexDeltaY[0]);
    const shouldSwapIndexAxes = !xAxisIsCol && !yAxisIsRow;
    if (shouldSwapIndexAxes) {
      if (shouldLog) {
        // eslint-disable-next-line no-console
        console.info('[ROI Export] Swapping index axes based on canvas alignment', {
          canvasTopLeft,
          canvasTopRight,
          canvasBottomLeft,
          indexDeltaX,
          indexDeltaY,
        });
      }
      const swapAxis = (point: number[]) => [point[1], point[0], point[2]];
      bottomLeft = swapAxis(bottomLeft);
      bottomRight = swapAxis(bottomRight);
      topLeft = swapAxis(topLeft);
    }

    const widthVec = [
      bottomRight[0] - bottomLeft[0],
      bottomRight[1] - bottomLeft[1],
    ];
    const heightVec = [
      topLeft[0] - bottomLeft[0],
      topLeft[1] - bottomLeft[1],
    ];

    const widthLength = Math.hypot(widthVec[0], widthVec[1]);
    const heightLength = Math.hypot(heightVec[0], heightVec[1]);

    if (!widthLength || !heightLength) {
      return null;
    }

    const widthSamples = Math.max(1, Math.round(widthLength));
    const heightSamples = Math.max(1, Math.round(heightLength));
    const unitWidth = [widthVec[0] / widthSamples, widthVec[1] / widthSamples];
    const unitHeight = [heightVec[0] / heightSamples, heightVec[1] / heightSamples];
    let outputWidth = widthSamples;
    let outputHeight = heightSamples;
    if (shouldLog) {
      // eslint-disable-next-line no-console
      console.info('[ROI Export] ROI vectors', {
        bottomLeft,
        bottomRight,
        topLeft,
        widthVec,
        heightVec,
        widthLength,
        heightLength,
        widthSamples,
        heightSamples,
      });
    }

    const frames: RoiExportFrame[] = [];
    const frameImageIds: string[] = [];
    let spacing: { row: number | null; column: number | null } = { row: null, column: null };
    let sampleType: 'int16' | 'uint16' | 'uint8' | 'float32' | null = null;

    let outputDimensionsLocked = false;

    limitedImageIds.forEach(imageId => {
      const image = cache.getImage(imageId);
      const pixelData = image?.getPixelData?.() ?? image?.pixelData;
      const columns = image?.columns ?? image?.width ?? 0;
      const rows = image?.rows ?? image?.height ?? 0;

      if (!pixelData || !columns || !rows) {
        return;
      }

      if (!spacing.row || !spacing.column) {
        const calibratedSpacing = metaData.get('calibratedPixelSpacing', imageId);
        const imagePlane = metaData.get('imagePlaneModule', imageId);
        spacing = {
          column:
            calibratedSpacing?.columnPixelSpacing ??
            imagePlane?.columnPixelSpacing ??
            null,
          row:
            calibratedSpacing?.rowPixelSpacing ?? imagePlane?.rowPixelSpacing ?? null,
        };
        if (shouldLog) {
          // eslint-disable-next-line no-console
          console.info('[ROI Export] spacing', {
            imageId,
            calibratedSpacing,
            imagePlane,
            spacing,
          });
        }
      }

      if (!sampleType) {
        if (pixelData instanceof Int16Array) {
          sampleType = 'int16';
        } else if (pixelData instanceof Uint16Array) {
          sampleType = 'uint16';
        } else if (pixelData instanceof Uint8Array) {
          sampleType = 'uint8';
        } else {
          sampleType = 'float32';
        }
      }

      // Helper function for bilinear interpolation
      const bilinearSample = (x: number, y: number): number => {
        // Return 0 (black) for out-of-bounds coordinates
        if (x < 0 || x >= columns || y < 0 || y >= rows) {
          return 0;
        }

        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = x0 + 1;
        const y1 = y0 + 1;

        // Get the four neighboring pixels
        const fx = x - x0;
        const fy = y - y0;

        // Return 0 for any neighbor that falls outside bounds
        const v00 = (x0 >= 0 && x0 < columns && y0 >= 0 && y0 < rows)
          ? (pixelData[y0 * columns + x0] || 0) : 0;
        const v10 = (x1 >= 0 && x1 < columns && y0 >= 0 && y0 < rows)
          ? (pixelData[y0 * columns + x1] || 0) : 0;
        const v01 = (x0 >= 0 && x0 < columns && y1 >= 0 && y1 < rows)
          ? (pixelData[y1 * columns + x0] || 0) : 0;
        const v11 = (x1 >= 0 && x1 < columns && y1 >= 0 && y1 < rows)
          ? (pixelData[y1 * columns + x1] || 0) : 0;

        // Bilinear interpolation
        const v0 = v00 * (1 - fx) + v10 * fx;
        const v1 = v01 * (1 - fx) + v11 * fx;
        const value = v0 * (1 - fy) + v1 * fy;

        return Number.isFinite(value) ? value : 0;
      };
      const nearestSample = (x: number, y: number): number => {
        const col = Math.floor(x);
        const row = Math.floor(y);
        if (col < 0 || col >= columns || row < 0 || row >= rows) {
          return 0;
        }
        const value = pixelData[row * columns + col];
        return Number.isFinite(value) ? value : 0;
      };
      const sample =
        roiPreviewSettings.accurateInterpolation === 'nearest'
          ? nearestSample
          : bilinearSample;

      // Sample the data in the natural ROI orientation (top to bottom, left to right)
      let tempData: number[] = [];
      for (let rowIndex = 0; rowIndex < heightSamples; rowIndex += 1) {
        const rowOffset = rowIndex + 0.5;
        const baseX = topLeft[0] - unitHeight[0] * rowOffset;
        const baseY = topLeft[1] - unitHeight[1] * rowOffset;

        for (let colIndex = 0; colIndex < widthSamples; colIndex += 1) {
          const colOffset = colIndex + 0.5;
          const sampleX = baseX + unitWidth[0] * colOffset;
          const sampleY = baseY + unitWidth[1] * colOffset;

          const value = sample(sampleX, sampleY);
          tempData.push(value);
        }
      }

      const transformedData = tempData;
      const transformedWidth = widthSamples;
      const transformedHeight = heightSamples;

      if (!outputDimensionsLocked) {
        outputWidth = transformedWidth;
        outputHeight = transformedHeight;
        outputDimensionsLocked = true;
      }

      let frameData: RoiExportFrame;
      switch (sampleType) {
        case 'int16':
          frameData = new Int16Array(outputWidth * outputHeight);
          break;
        case 'uint16':
          frameData = new Uint16Array(outputWidth * outputHeight);
          break;
        case 'uint8':
          frameData = new Uint8Array(outputWidth * outputHeight);
          break;
        default:
          frameData = new Float32Array(outputWidth * outputHeight);
          break;
      }
      const copyLength = Math.min(frameData.length, transformedData.length);
      for (let i = 0; i < copyLength; i++) {
        const value = transformedData[i];
        frameData[i] = Number.isFinite(value) ? value : 0;
      }

      frames.push(frameData);
      frameImageIds.push(imageId);
    });

    if (!frames.length) {
      return null;
    }

    const frameTiming = extractFrameTimingFromImageIds(frameImageIds);

    return {
      frames,
      imageIds: frameImageIds,
      width: outputWidth,
      height: outputHeight,
      spacing,
      frameTimeMs: frameTiming.frameTimeMs,
    };
  }, [
    roiAnnotation,
    activeViewportId,
    cornerstoneViewportService,
    roiPreviewSettings,
  ]);

  const renderAccurateRoiPreview = useCallback(() => {
    if (!roiAnnotation || !activeViewportId || !cornerstoneViewportService) {
      return;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) {
      return;
    }

    const imageId =
      viewport.getCurrentImageId?.() || roiAnnotation?.metadata?.referencedImageId;
    if (!imageId) {
      return;
    }

    const stack = buildTemporalRoiStack({ imageIds: [imageId], maxFrames: 1 });
    if (!stack || !stack.frames?.length) {
      return;
    }

    const image = cache.getImage(imageId);
    const windowCenterRaw = image?.windowCenter;
    const windowWidthRaw = image?.windowWidth;
    const windowCenter = Array.isArray(windowCenterRaw) ? windowCenterRaw[0] : windowCenterRaw;
    const windowWidth = Array.isArray(windowWidthRaw) ? windowWidthRaw[0] : windowWidthRaw;
    const slope = Number.isFinite(image?.slope) ? image?.slope : 1;
    const intercept = Number.isFinite(image?.intercept) ? image?.intercept : 0;
    const invert = image?.invert === true;

    const frame = stack.frames[0];
    const roiWidth = stack.width;
    const roiHeight = stack.height;

    const useWindow = Number.isFinite(windowCenter) && Number.isFinite(windowWidth);
    let min = Infinity;
    let max = -Infinity;
    if (!useWindow) {
      for (let i = 0; i < frame.length; i++) {
        const value = frame[i];
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    const range = max - min || 1;
    const lower = useWindow ? windowCenter - 0.5 - (windowWidth - 1) / 2 : null;
    const upper = useWindow ? windowCenter - 0.5 + (windowWidth - 1) / 2 : null;

    // Create temporary ROI-sized canvas for pixel data
    const roiCanvas = document.createElement('canvas');
    roiCanvas.width = Math.max(1, Math.round(roiWidth));
    roiCanvas.height = Math.max(1, Math.round(roiHeight));
    console.log('[Overlay Debug] roiCanvas dimensions:', roiCanvas.width, 'x', roiCanvas.height);
    const roiCtx = roiCanvas.getContext('2d');
    if (!roiCtx) {
      return;
    }

    const roiImageData = roiCtx.createImageData(roiCanvas.width, roiCanvas.height);
    for (let i = 0; i < frame.length; i++) {
      let value;
      if (useWindow && lower != null && upper != null) {
        const scaled = frame[i] * slope + intercept;
        if (scaled <= lower) {
          value = 0;
        } else if (scaled > upper) {
          value = 255;
        } else {
          value = Math.round(((scaled - lower) / (upper - lower)) * 255);
        }
      } else {
        value = Math.round(((frame[i] - min) / range) * 255);
      }
      const clamped = Math.max(0, Math.min(255, value));
      const mapped = invert ? 255 - clamped : clamped;
      const idx = i * 4;
      roiImageData.data[idx] = mapped;
      roiImageData.data[idx + 1] = mapped;
      roiImageData.data[idx + 2] = mapped;
      roiImageData.data[idx + 3] = 255;
    }
    roiCtx.putImageData(roiImageData, 0, 0);

    // Store ROI canvas for debug export
    debugPreviewCanvasRef.current = roiCanvas;

    // Create fixed-size preview canvas with DPR scaling
    const dpr = window.devicePixelRatio || 1;
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = Math.round(PREVIEW_WIDTH * dpr);
    previewCanvas.height = Math.round(PREVIEW_HEIGHT * dpr);
    const ctx = previewCanvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    ctx.imageSmoothingEnabled = false;

    // Scale ROI to fit within fixed canvas (like fast preview)
    const scale = Math.min(PREVIEW_WIDTH / roiWidth, PREVIEW_HEIGHT / roiHeight);
    const scaledWidth = roiWidth * scale;
    const scaledHeight = roiHeight * scale;
    const startX = (PREVIEW_WIDTH - scaledWidth) / 2;
    const startY = (PREVIEW_HEIGHT - scaledHeight) / 2;

    // Draw scaled ROI onto preview canvas
    console.log('[Overlay Debug] Drawing ROI image at', startX, startY, 'with display size:', scaledWidth, 'x', scaledHeight);
    ctx.drawImage(roiCanvas, startX, startY, scaledWidth, scaledHeight);

    // === Overlay Rendering: Manual Contour Segmentation Masks ===
    // Get viewport information needed for coordinate transformation
    const viewportInfo = cornerstoneViewportService.getViewportInfo?.(activeViewportId);
    const element = viewportInfo?.element;
    const sourceCanvas = element?.querySelector('canvas');

    console.log('[Overlay Debug] element:', element, 'sourceCanvas:', sourceCanvas);

    if (element && sourceCanvas) {
      // Get ROI annotation points and calculate geometry using worldToIndex (same as buildTemporalRoiStack)
      const points = roiAnnotation?.data?.handles?.points?.slice(0, 4) || [];

      if (points.length === 4) {
        // Use the same worldToIndex transformation as buildTemporalRoiStack
        const getWorldToIndex = () => {
          if (viewport.worldToIndex) {
            return (point: number[]) => viewport.worldToIndex(point);
          }

          // Fallback: calculate worldToIndex from DICOM metadata (same as buildTemporalRoiStack)
          const imagePlane = metaData.get('imagePlaneModule', imageId);
          const orientation = imagePlane?.imageOrientationPatient;
          const position = imagePlane?.imagePositionPatient;
          const rowSpacing = imagePlane?.rowPixelSpacing ?? 1;
          const colSpacing = imagePlane?.columnPixelSpacing ?? 1;

          if (!orientation || !position) {
            return null;
          }

          const rowCosines = [orientation[0], orientation[1], orientation[2]];
          const colCosines = [orientation[3], orientation[4], orientation[5]];

          return (point: number[]) => {
            const dx = point[0] - position[0];
            const dy = point[1] - position[1];
            const dz = point[2] - position[2];
            const row = (dx * rowCosines[0] + dy * rowCosines[1] + dz * rowCosines[2]) / rowSpacing;
            const col = (dx * colCosines[0] + dy * colCosines[1] + dz * colCosines[2]) / colSpacing;
            return [col, row, 0];
          };
        };

        const worldToIndex = getWorldToIndex();
        if (!worldToIndex) {
          console.warn('[Overlay Debug] worldToIndex not available, skipping overlay');
          return;
        }
        console.log('[Overlay Debug] worldToIndex successfully created');

        // Transform ROI corner points to index space and stabilize ordering (same as buildTemporalRoiStack)
        const indexedPoints = points.map(point => ({
          world: point,
          index: worldToIndex(point),
          canvas: viewport.worldToCanvas ? viewport.worldToCanvas(point) : null,
        }));
        if (indexedPoints.some(point => !point.index || point.index.length < 2)) {
          console.warn('[Overlay Debug] index points missing, skipping overlay');
          return;
        }
        if (indexedPoints.some(point => !point.canvas || point.canvas.length < 2)) {
          console.warn('[Overlay Debug] canvas points missing, skipping overlay');
          return;
        }

        const canvasCenter = indexedPoints.reduce(
          (acc, point) => {
            acc[0] += point.canvas![0];
            acc[1] += point.canvas![1];
            return acc;
          },
          [0, 0]
        );
        canvasCenter[0] /= indexedPoints.length;
        canvasCenter[1] /= indexedPoints.length;

        const ordered = {
          topLeft: null as typeof indexedPoints[number] | null,
          topRight: null as typeof indexedPoints[number] | null,
          bottomLeft: null as typeof indexedPoints[number] | null,
          bottomRight: null as typeof indexedPoints[number] | null,
        };

        indexedPoints.forEach(point => {
          const dx = point.canvas![0] - canvasCenter[0];
          const dy = point.canvas![1] - canvasCenter[1];
          if (dx <= 0 && dy <= 0) {
            ordered.topLeft = point;
          } else if (dx > 0 && dy <= 0) {
            ordered.topRight = point;
          } else if (dx <= 0 && dy > 0) {
            ordered.bottomLeft = point;
          } else {
            ordered.bottomRight = point;
          }
        });

        if (!ordered.topLeft || !ordered.topRight || !ordered.bottomLeft || !ordered.bottomRight) {
          console.warn('[Overlay Debug] could not order ROI points, skipping overlay');
          return;
        }

        let bottomLeft = ordered.bottomLeft.index!;
        let bottomRight = ordered.bottomRight.index!;
        let topLeft = ordered.topLeft.index!;

        const indexTopLeft = ordered.topLeft.index!;
        const indexTopRight = ordered.topRight.index!;
        const indexBottomLeft = ordered.bottomLeft.index!;
        const indexDeltaX = [
          indexTopRight[0] - indexTopLeft[0],
          indexTopRight[1] - indexTopLeft[1],
        ];
        const indexDeltaY = [
          indexBottomLeft[0] - indexTopLeft[0],
          indexBottomLeft[1] - indexTopLeft[1],
        ];
        const xAxisIsCol = Math.abs(indexDeltaX[0]) >= Math.abs(indexDeltaX[1]);
        const yAxisIsRow = Math.abs(indexDeltaY[1]) >= Math.abs(indexDeltaY[0]);
        const shouldSwapIndexAxes = !xAxisIsCol && !yAxisIsRow;
        if (shouldSwapIndexAxes) {
          const swapAxis = (point: number[]) => [point[1], point[0], point[2]];
          bottomLeft = swapAxis(bottomLeft);
          bottomRight = swapAxis(bottomRight);
          topLeft = swapAxis(topLeft);
        }

        // Calculate ROI geometry in index space
        const widthVec = [
          bottomRight[0] - bottomLeft[0],
          bottomRight[1] - bottomLeft[1],
        ];
        const heightVec = [
          topLeft[0] - bottomLeft[0],
          topLeft[1] - bottomLeft[1],
        ];

        const widthLength = Math.hypot(widthVec[0], widthVec[1]);
        const heightLength = Math.hypot(heightVec[0], heightVec[1]);

        // Coordinate transformation function: world → index → ROI local coords
        const worldToRoiLocal = (worldPoint: number[]) => {
          const indexPoint = worldToIndex(worldPoint);
          // Express point relative to bottomLeft corner, in terms of width/height vectors
          const dx = indexPoint[0] - bottomLeft[0];
          const dy = indexPoint[1] - bottomLeft[1];

          // Project onto width and height vectors
          const u = (dx * widthVec[0] + dy * widthVec[1]) / (widthLength * widthLength);
          const v = (dx * heightVec[0] + dy * heightVec[1]) / (heightLength * heightLength);

          return [u * widthLength, v * heightLength];
        };

        // Create overlay data structures - must match ROI canvas dimensions
        const roiMaskWidth = Math.max(1, Math.round(roiWidth));
        const roiMaskHeight = Math.max(1, Math.round(roiHeight));
        console.log('[Overlay Debug] roiWidth:', roiWidth, 'roiHeight:', roiHeight);
        console.log('[Overlay Debug] Creating overlay of size:', roiMaskWidth, 'x', roiMaskHeight);
        const maskData = new Uint8Array(roiMaskWidth * roiMaskHeight);
        const overlayImageData = ctx.createImageData(roiMaskWidth, roiMaskHeight);

        // Build label maps
        const labelIdToIndex = new Map<string, number>();
        const labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }> = {};
        SEGMENTATION_LABELS.forEach((label, index) => {
          const labelIndex = index + 1;
          labelIdToIndex.set(label.id, labelIndex);
          labelMap[labelIndex] = {
            labelId: label.id,
            labelName: label.name,
            labelColor: label.color,
          };
        });

        // Get label state from segmentation store
        const labelStateMap = new Map();
        console.log('[Overlay Debug] segmentationLabels:', segmentationLabels);
        segmentationLabels.forEach(label => {
          labelStateMap.set(label.id, {
            visible: label.visible,
            opacity: label.opacity,
            color: label.color,
          });
        });
        console.log('[Overlay Debug] labelStateMap after population:', Array.from(labelStateMap.entries()));

        // Get manual contour annotations for current frame
        const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
        const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
        const displaySet = displaySetInstanceUID
          ? displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID)
          : undefined;
        const seriesInstanceUID = displaySet?.SeriesInstanceUID;
        const currentIndex = viewport.getCurrentImageIdIndex?.();
        const currentFrameNumber = typeof currentIndex === 'number' ? currentIndex + 1 : undefined;

        const contourAnnotations = annotation.state.getAnnotations(MANUAL_CONTOUR_TOOL, element as HTMLElement) || [];

        console.log('[Overlay Debug] contourAnnotations:', contourAnnotations.length);

        const filteredContours = contourAnnotations.filter(contour => {
          const contourModelType = contour?.data?.modelType || 'manual';
          if (contourModelType !== segmentationModel) {
            return false;
          }

          if (seriesInstanceUID && contour?.data?.seriesInstanceUID) {
            if (contour.data.seriesInstanceUID !== seriesInstanceUID) {
              return false;
            }
          }

          if (imageId && contour?.metadata?.referencedImageId) {
            return contour.metadata.referencedImageId === imageId;
          }

          const frameNumber = contour?.data?.frameNumber || contour?.metadata?.frameNumber;
          if (currentFrameNumber && frameNumber) {
            return frameNumber === currentFrameNumber;
          }

          return false;
        });

        // Sort contours by edit time (last-edited-wins for overlaps)
        const contoursByEdit = [...filteredContours].sort((a, b) => {
          const timeA = a?.data?.modifiedAt || 0;
          const timeB = b?.data?.modifiedAt || 0;
          return timeA - timeB;
        });

        console.log('[Overlay Debug] filteredContours:', filteredContours.length, 'contoursByEdit:', contoursByEdit.length);
        console.log('[Overlay Debug] roiMaskWidth:', roiMaskWidth, 'roiMaskHeight:', roiMaskHeight);
        console.log('[Overlay Debug] scale:', scale, 'scaledWidth:', scaledWidth, 'scaledHeight:', scaledHeight);
        console.log('[Overlay Debug] startX:', startX, 'startY:', startY);

        // Rasterize contours into mask data
        let totalPixelsRasterized = 0;
        contoursByEdit.forEach(contour => {
          const polyline = contour?.data?.contour?.polyline || contour?.data?.handles?.points;
          if (!polyline || polyline.length < 3) {
            console.log('[Overlay Debug] Skipping contour - invalid polyline');
            return;
          }

          const labelId = contour?.data?.labelId;
          const labelIndex = labelId ? labelIdToIndex.get(labelId) : undefined;
          if (!labelIndex) {
            console.log('[Overlay Debug] Skipping contour - no labelIndex for labelId:', labelId);
            return;
          }
          console.log('[Overlay Debug] Processing contour - labelId:', labelId, 'labelIndex:', labelIndex, 'points:', polyline.length);

          // Transform polygon to ROI mask space using worldToRoiLocal
          const polygon = polyline.map(point => {
            const [localX, localY] = worldToRoiLocal(point);
            // localX is in [0, widthLength], localY is in [0, heightLength]
            // Scale to mask resolution
            return [
              (localX / widthLength) * roiMaskWidth,
              (localY / heightLength) * roiMaskHeight,
            ];
          });

          console.log('[Overlay Debug] First 3 polygon points:', polygon.slice(0, 3));
          console.log('[Overlay Debug] widthLength:', widthLength, 'heightLength:', heightLength);
          console.log('[Overlay Debug] Bounding box will be checked against roiMask bounds [0-' + roiMaskWidth + ', 0-' + roiMaskHeight + ']');

          // Get bounding box for optimization
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const [x, y] of polygon) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }

          const startXPixel = Math.max(0, Math.floor(minX));
          const endXPixel = Math.min(roiMaskWidth - 1, Math.ceil(maxX));
          const startYPixel = Math.max(0, Math.floor(minY));
          const endYPixel = Math.min(roiMaskHeight - 1, Math.ceil(maxY));

          console.log('[Overlay Debug] Polygon bbox: [' + minX + '-' + maxX + ', ' + minY + '-' + maxY + ']');
          console.log('[Overlay Debug] Clamped pixel range: [' + startXPixel + '-' + endXPixel + ', ' + startYPixel + '-' + endYPixel + ']');

          // Rasterize polygon using point-in-polygon test
          let pixelsInThisContour = 0;
          for (let y = startYPixel; y <= endYPixel; y += 1) {
            for (let x = startXPixel; x <= endXPixel; x += 1) {
              if (isPointInPolygon([x + 0.5, y + 0.5], polygon)) {
                maskData[y * roiMaskWidth + x] = labelIndex;
                pixelsInThisContour++;
                totalPixelsRasterized++;
              }
            }
          }
          console.log('[Overlay Debug] Rasterized', pixelsInThisContour, 'pixels for this contour');
        });

        console.log('[Overlay Debug] Total pixels rasterized:', totalPixelsRasterized);

        // Apply colors to overlay based on label visibility and opacity
        const overlayData = overlayImageData.data;
        let coloredPixels = 0;
        let skippedInvisible = 0;
        for (let i = 0; i < maskData.length; i += 1) {
          const labelIndex = maskData[i];
          if (!labelIndex) {
            continue;
          }

          const labelInfo = labelMap[labelIndex];
          if (!labelInfo) {
            continue;
          }

          const labelState = labelStateMap.get(labelInfo.labelId);
          if (labelState && !labelState.visible) {
            skippedInvisible++;
            continue;
          }

          const color = labelState?.color || labelInfo.labelColor;
          const opacity = labelState?.opacity ?? 0.3;
          const [r, g, b] = hexToRgb(color);
          const alpha = Math.round(opacity * 255);
          const dataIndex = i * 4;
          overlayData[dataIndex] = r;
          overlayData[dataIndex + 1] = g;
          overlayData[dataIndex + 2] = b;
          overlayData[dataIndex + 3] = alpha;
          coloredPixels++;
        }

        console.log('[Overlay Debug] Colored pixels:', coloredPixels, 'Skipped invisible:', skippedInvisible);
        console.log('[Overlay Debug] Label state map:', Array.from(labelStateMap.entries()));

        // Composite overlay onto preview canvas
        const overlayCanvas = document.createElement('canvas');
        overlayCanvas.width = roiMaskWidth;
        overlayCanvas.height = roiMaskHeight;
        const overlayCtx = overlayCanvas.getContext('2d');
        if (overlayCtx) {
          overlayCtx.putImageData(overlayImageData, 0, 0);
          console.log('[Overlay Debug] overlayCanvas dimensions:', overlayCanvas.width, 'x', overlayCanvas.height);
          console.log('[Overlay Debug] Drawing overlay at', startX, startY, 'with display size:', scaledWidth, 'x', scaledHeight);
          console.log('[Overlay Debug] This should match ROI image which is drawn at same position/size');
          ctx.drawImage(overlayCanvas, startX, startY, scaledWidth, scaledHeight);
          console.log('[Overlay Debug] Overlay drawn successfully');
        }
      }
    }
    // === End Overlay Rendering ===

    // Apply dark mask outside ROI region
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.rect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    ctx.rect(startX, startY, scaledWidth, scaledHeight);
    ctx.fill('evenodd');

    // === Mask Contour Rendering with Soft Dimming ===
    if (element && sourceCanvas) {
      const points = roiAnnotation?.data?.handles?.points?.slice(0, 4) || [];

      if (points.length === 4) {
        // Reuse geometry calculations from overlay rendering
        const elementWidth = element.clientWidth || 0;
        const elementHeight = element.clientHeight || 0;
        const sourceWidth = sourceCanvas.width;
        const sourceHeight = sourceCanvas.height;
        const scaleX = elementWidth > 0 && sourceWidth > 0 ? sourceWidth / elementWidth : 1;
        const scaleY = elementHeight > 0 && sourceHeight > 0 ? sourceHeight / elementHeight : 1;
        const needsNormalization = (scaleX > 1.01 || scaleY > 1.01) && (elementWidth > 0 && elementHeight > 0);

        const canvasPoints = points.map(point => viewport.worldToCanvas(point));
        const bottomLeft = canvasPoints[0];
        const bottomRight = canvasPoints[1];
        const topRight = canvasPoints[2];

        const angle = Math.atan2(bottomRight[1] - bottomLeft[1], bottomRight[0] - bottomLeft[0]);
        const center = [(bottomLeft[0] + topRight[0]) / 2, (bottomLeft[1] + topRight[1]) / 2];

        const normalizeCanvasPoint = (worldPoint: number[]) => {
          const canvasPoint = viewport.worldToCanvas(worldPoint);
          if (!needsNormalization) {
            return canvasPoint;
          }
          return [canvasPoint[0] / scaleX, canvasPoint[1] / scaleY];
        };

        const cosAngle = Math.cos(-angle);
        const sinAngle = Math.sin(-angle);

        const toPreviewPoint = (canvasPoint: number[]) => {
          const dx = canvasPoint[0] - center[0];
          const dy = canvasPoint[1] - center[1];
          const rotatedX = dx * cosAngle - dy * sinAngle;
          const rotatedY = dx * sinAngle + dy * cosAngle;
          return [
            rotatedX * scale + PREVIEW_WIDTH / 2,
            rotatedY * scale + PREVIEW_HEIGHT / 2,
          ];
        };

        // Get mask contour annotations
        const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
        const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
        const displaySet = displaySetInstanceUID
          ? displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID)
          : undefined;
        const seriesInstanceUID = displaySet?.SeriesInstanceUID;
        const currentIndex = viewport.getCurrentImageIdIndex?.();
        const currentFrameNumber = typeof currentIndex === 'number' ? currentIndex + 1 : undefined;

        const maskAnnotations = annotation.state.getAnnotations(MASK_CONTOUR_TOOL, element as HTMLElement) || [];
        const filteredMasks = maskAnnotations.filter(mask => {
          if (seriesInstanceUID && mask?.data?.seriesInstanceUID) {
            if (mask.data.seriesInstanceUID !== seriesInstanceUID) {
              return false;
            }
          }

          if (imageId && mask?.metadata?.referencedImageId) {
            return mask.metadata.referencedImageId === imageId;
          }

          const frameNumber = mask?.data?.frameNumber || mask?.metadata?.frameNumber;
          if (currentFrameNumber && frameNumber) {
            return frameNumber === currentFrameNumber;
          }

          return false;
        });

        if (filteredMasks.length > 0) {
          // Create binary mask for distance field calculation
          const previewWidth = Math.round(PREVIEW_WIDTH);
          const previewHeight = Math.round(PREVIEW_HEIGHT);
          const maskBitmap = new Uint8Array(previewWidth * previewHeight);

          // Rasterize all mask contours into binary mask
          filteredMasks.forEach(mask => {
            const polyline = mask?.data?.contour?.polyline || mask?.data?.handles?.points;
            if (!polyline || polyline.length < 3) {
              return;
            }

            // Transform contour points to preview canvas space
            const previewPoints = polyline.map(point => {
              const canvasPoint = normalizeCanvasPoint(point);
              return toPreviewPoint(canvasPoint);
            });

            // Draw mask contour as dashed outline first
            ctx.save();
            ctx.strokeStyle = MASK_CONTOUR_COLOR;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            previewPoints.forEach((point, index) => {
              if (index === 0) {
                ctx.moveTo(point[0], point[1]);
              } else {
                ctx.lineTo(point[0], point[1]);
              }
            });
            ctx.closePath();
            ctx.stroke();
            ctx.restore();

            // Rasterize polygon into binary mask
            // Get bounding box
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [x, y] of previewPoints) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }

            const startXPixel = Math.max(0, Math.floor(minX));
            const endXPixel = Math.min(previewWidth - 1, Math.ceil(maxX));
            const startYPixel = Math.max(0, Math.floor(minY));
            const endYPixel = Math.min(previewHeight - 1, Math.ceil(maxY));

            // Rasterize using point-in-polygon
            for (let y = startYPixel; y <= endYPixel; y += 1) {
              for (let x = startXPixel; x <= endXPixel; x += 1) {
                if (isPointInPolygon([x + 0.5, y + 0.5], previewPoints)) {
                  maskBitmap[y * previewWidth + x] = 1;
                }
              }
            }
          });

          // Dimming disabled to avoid expensive distance-field computation.
        }
      }
    }
    // === End Mask Contour Rendering ===

    // Draw orange border
    ctx.strokeStyle = MEDEX_ORANGE;
    ctx.lineWidth = 4;
    ctx.strokeRect(0.75, 0.75, PREVIEW_WIDTH - 1.5, PREVIEW_HEIGHT - 1.5);

    // Get spacing info for axis labels
    const calibratedSpacing = metaData.get('calibratedPixelSpacing', imageId);
    const imagePlaneModule = metaData.get('imagePlaneModule', imageId);
    const spacingX =
      calibratedSpacing?.columnPixelSpacing ?? imagePlaneModule?.columnPixelSpacing ?? null;
    const spacingY =
      calibratedSpacing?.rowPixelSpacing ?? imagePlaneModule?.rowPixelSpacing ?? null;
    const hasSpacing =
      typeof spacingX === 'number' &&
      typeof spacingY === 'number' &&
      Number.isFinite(spacingX) &&
      Number.isFinite(spacingY) &&
      spacingX > 0 &&
      spacingY > 0 &&
      !imagePlaneModule?.usingDefaultValues;

    // Calculate world dimensions for tick marks
    const roiWidthUnits = hasSpacing ? roiWidth * spacingX : roiWidth;
    const roiHeightUnits = hasSpacing ? roiHeight * spacingY : roiHeight;
    const maxUnits = Math.max(roiWidthUnits, roiHeightUnits);

    const targetTicks = 5;
    const rawStep = maxUnits > 0 ? maxUnits / targetTicks : 10;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const baseSteps = [1, 2, 5, 10];
    let tickEveryUnit = baseSteps[baseSteps.length - 1] * magnitude;
    for (const base of baseSteps) {
      const candidate = base * magnitude;
      if (candidate >= rawStep) {
        tickEveryUnit = candidate;
        break;
      }
    }

    // Convert tick spacing from world units to canvas pixels
    const tickEveryPxX = roiWidthUnits > 0 ? (tickEveryUnit / roiWidthUnits) * scaledWidth : 0;
    const tickEveryPxY = roiHeightUnits > 0 ? (tickEveryUnit / roiHeightUnits) * scaledHeight : 0;
    const unitLabel = hasSpacing ? 'mm' : 'px';

    // Draw axis ticks and labels
    if (tickEveryPxX > 6 || tickEveryPxY > 6) {
      const tickLength = 16;
      const labelOffset = 6;
      const fontSize = 40;
      const originalLineWidth = ctx.lineWidth;
      ctx.lineWidth = 4;

      ctx.fillStyle = MEDEX_ORANGE;
      ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`;

      if (tickEveryPxX > 6) {
        let tickIndex = 0;
        for (let x = 0; x <= PREVIEW_WIDTH + 0.5; x += tickEveryPxX) {
          const labelValue = tickIndex * tickEveryUnit;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, tickLength);
          ctx.stroke();
          if (tickIndex !== 0) {
            ctx.fillText(`${labelValue}${unitLabel}`, x, tickLength + labelOffset);
          }
          tickIndex += 1;
        }
      }

      if (tickEveryPxY > 6) {
        let tickIndex = 0;
        for (let y = 0; y <= PREVIEW_HEIGHT + 0.5; y += tickEveryPxY) {
          const labelValue = tickIndex * tickEveryUnit;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(tickLength, y);
          ctx.stroke();
          if (tickIndex !== 0) {
            ctx.fillText(`${labelValue}${unitLabel}`, tickLength + labelOffset, y);
          }
          tickIndex += 1;
        }
      }
      ctx.lineWidth = originalLineWidth;
    }

    if (kymographSettings.showProfileLine) {
      const isHorizontalProfile =
        kymographSettings.spatialAxis === 'major'
          ? roiWidthUnits >= roiHeightUnits
          : roiWidthUnits < roiHeightUnits;

      ctx.strokeStyle = '#22C55E';
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 4]);

      if (isHorizontalProfile) {
        const midY = PREVIEW_HEIGHT / 2;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(PREVIEW_WIDTH, midY);
        ctx.stroke();
      } else {
        const midX = PREVIEW_WIDTH / 2;
        ctx.beginPath();
        ctx.moveTo(midX, 0);
        ctx.lineTo(midX, PREVIEW_HEIGHT);
        ctx.stroke();
      }

      ctx.setLineDash([]);
    }

    setRoiPreviewUrl(previewCanvas.toDataURL('image/png'));
    setPreviewMode('accurate');
  }, [
    activeViewportId,
    buildTemporalRoiStack,
    cornerstoneViewportService,
    kymographSettings,
    roiAnnotation,
  ]);

  const scheduleAccuratePreview = useCallback(() => {
    if (accuratePreviewTimeoutRef.current) {
      window.clearTimeout(accuratePreviewTimeoutRef.current);
    }
    const token = ++accuratePreviewTokenRef.current;
    accuratePreviewTimeoutRef.current = window.setTimeout(() => {
      if (token !== accuratePreviewTokenRef.current) {
        return;
      }
      renderAccurateRoiPreview();
    }, roiPreviewSettings.accuratePreviewDelayMs);
  }, [renderAccurateRoiPreview, roiPreviewSettings]);

  const handleDebugExport = useCallback(async () => {
    renderAccurateRoiPreview();
    const debugData = (window as any).__MEDEX_ROI_DEBUG_DATA;
    const previewCanvas = debugPreviewCanvasRef.current;

    if (!debugData || !previewCanvas) {
      uiNotificationService?.show?.({
        title: 'Debug Export',
        message: 'No ROI data available. Please select an ROI first.',
        type: 'warning',
      });
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `roi-debug-${timestamp}`;

    // Export JSON
    const jsonBlob = new Blob(
      [JSON.stringify(debugData, null, 2)],
      { type: 'application/json' }
    );
    downloadBlob(jsonBlob, `${baseName}.json`);

    // Export preview PNG
    const pngDataUrl = previewCanvas.toDataURL('image/png');
    const pngBlob = await fetch(pngDataUrl).then(r => r.blob());
    downloadBlob(pngBlob, `${baseName}.png`);

    uiNotificationService?.show?.({
      title: 'Debug Export',
      message: 'Exported JSON and PNG files.',
      type: 'success',
    });
  }, [renderAccurateRoiPreview, uiNotificationService]);

  const handleTemporalExport = useCallback(async () => {
    if (isExporting) {
      return;
    }

    // Handle debug export separately
    if (exportFormat === 'debug') {
      await handleDebugExport();
      return;
    }

    setIsExporting(true);
    setExportProgress(10);
    exportInProgressRef.current = true;
      let warningTimeout: number | null = null;

    try {
      const stack = buildTemporalRoiStack();
      if (!stack) {
        uiNotificationService?.show?.({
          title: 'Temporal ROI Export',
          message: 'Temporal ROI data is not available for export.',
          type: 'warning',
        });
        return;
      }

      const { frames, width, height, spacing, frameTimeMs, imageIds } = stack;
      const instance = imageIds[0] ? metaData.get('instance', imageIds[0]) : null;
      const seriesUid = instance?.SeriesInstanceUID || 'series';
      const baseName = `temporal-roi-${seriesUid}`;
      setExportProgress(40);

      let saveHandle: FileSystemFileHandle | null = null;
      const tentativeExtension =
        exportFormat === 'nifti_gz' ? 'nii.gz' : exportFormat === 'nifti' ? 'nii' : 'tiff';
      const suggestedName = `${baseName}.${tentativeExtension}`;
      try {
        saveHandle = await requestSaveHandle(
          suggestedName,
          exportFormat === 'tiff' ? 'image/tiff' : 'application/octet-stream'
        );
      } catch (error) {
        if ((error as DOMException)?.name !== 'AbortError') {
          throw error;
        }
        return;
      }

      warningTimeout = window.setTimeout(() => {
        if (!exportInProgressRef.current) {
          return;
        }
        uiNotificationService?.show?.({
          title: 'Temporal ROI Export',
          message: 'Export is taking longer than expected. Please wait.',
          type: 'warning',
        });
      }, 3000);

      if (exportFormat === 'nifti' || exportFormat === 'nifti_gz') {
        const niftiBuffer = buildNiftiBuffer({
          frames,
          width,
          height,
          spacing,
          frameTimeMs,
        });
        setExportProgress(70);
        let outputBuffer = niftiBuffer;
        let extension = 'nii';
        if (exportFormat === 'nifti_gz' && typeof CompressionStream !== 'undefined') {
          outputBuffer = await gzipBuffer(niftiBuffer, (progress) => {
            setExportProgress(progress);
          });
          extension = 'nii.gz';
        }
        setExportProgress(85);
        const fileName = `${baseName}.${extension}`;
        if (saveHandle) {
          await writeBufferToHandle(saveHandle, outputBuffer, 'application/octet-stream');
        } else {
          downloadBlob(new Blob([outputBuffer], { type: 'application/octet-stream' }), fileName);
        }
      } else {
        const tiffBuffer = buildTiffBuffer({ frames, width, height });
        setExportProgress(85);
        const fileName = `${baseName}.tiff`;
        if (saveHandle) {
          await writeBufferToHandle(saveHandle, tiffBuffer, 'image/tiff');
        } else {
          downloadBlob(new Blob([tiffBuffer], { type: 'image/tiff' }), fileName);
        }
      }

      setExportProgress(100);
      uiNotificationService?.show?.({
        title: 'Temporal ROI Export',
        message: 'Export completed.',
        type: 'success',
      });
    } catch (error) {
      uiNotificationService?.show?.({
        title: 'Temporal ROI Export',
        message: 'Export failed. See console for details.',
        type: 'error',
      });
      // eslint-disable-next-line no-console
      console.error('Temporal ROI export failed', error);
    } finally {
      if (warningTimeout) {
        window.clearTimeout(warningTimeout);
      }
      setIsExporting(false);
      exportInProgressRef.current = false;
      setTimeout(() => setExportProgress(0), 400);
    }
  }, [buildTemporalRoiStack, exportFormat, handleDebugExport, isExporting, uiNotificationService]);

  const getSelectedAnalysisRoi = useCallback(() => {
    const frameOfReferenceUID = getActiveFrameOfReferenceUID();
    const seriesInstanceUID = getActiveSeriesInstanceUID();

    const matchesActiveSeries = (annotationToCheck: any) => {
      const metadata = annotationToCheck?.metadata || {};
      const data = annotationToCheck?.data || {};
      const annotationFrameUID = metadata.FrameOfReferenceUID || data.FrameOfReferenceUID;
      const annotationSeriesUID =
        metadata.SeriesInstanceUID || data.seriesInstanceUID || data.SeriesInstanceUID;

      if ((frameOfReferenceUID || seriesInstanceUID) && !annotationFrameUID && !annotationSeriesUID) {
        return false;
      }

      if (frameOfReferenceUID && annotationFrameUID && annotationFrameUID !== frameOfReferenceUID) {
        return false;
      }
      if (seriesInstanceUID && annotationSeriesUID && annotationSeriesUID !== seriesInstanceUID) {
        return false;
      }
      return true;
    };

    const [selectedAnnotationUID] = annotation.selection.getAnnotationsSelected() || [];
    if (selectedAnnotationUID) {
      const selectedAnnotation = annotation.state.getAnnotation(selectedAnnotationUID);
      if (
        selectedAnnotation?.metadata?.toolName === TOOL_NAME &&
        matchesActiveSeries(selectedAnnotation)
      ) {
        return selectedAnnotation;
      }
    }

    const annotationManager = annotation.state.getAnnotationManager();
    if (!annotationManager?.getFramesOfReference) {
      return null;
    }

    if (frameOfReferenceUID) {
      const annotations = annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];
      const matched = annotations.find(item => matchesActiveSeries(item));
      if (matched) {
        return matched;
      }
    } else {
      const framesOfReference = annotationManager.getFramesOfReference() || [];
      for (const frameOfReference of framesOfReference) {
        const annotations = annotationManager.getAnnotations(frameOfReference, TOOL_NAME) || [];
        const matched = annotations.find(item => matchesActiveSeries(item));
        if (matched) {
          return matched;
        }
      }
    }

    return null;
  }, [getActiveFrameOfReferenceUID, getActiveSeriesInstanceUID]);

  const updateFrameRateForViewport = useCallback(() => {
    if (!activeViewportId || !cornerstoneViewportService) {
      return;
    }
    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport?.getImageIds) {
      return;
    }
    const imageIds = viewport.getImageIds() || [];
    if (!imageIds.length) {
      return;
    }
    const currentImageId = viewport.getCurrentImageId?.() || imageIds[0];
    const seriesKey = getSeriesKey(currentImageId);
    if (!seriesKey || seriesKeyRef.current === seriesKey) {
      return;
    }
    seriesKeyRef.current = seriesKey;
    const nextRoi = getSelectedAnalysisRoi();
    setRoiAnnotation(nextRoi);
    setRoiRevision(revision => revision + 1);
    const frameTiming = extractFrameTimingFromImageIds(imageIds);
    logFrameTiming(frameTiming);
    setFrameRateFromMetadata(
      frameTiming.frameRate,
      frameTiming.source === 'Default' ? 'default' : 'metadata',
      { force: true }
    );
  }, [activeViewportId, cornerstoneViewportService, getSeriesKey, getSelectedAnalysisRoi]);

  useEffect(() => {
    updateFrameRateForViewport();
  }, [updateFrameRateForViewport]);

  useEffect(() => {
    const updateRoiState = () => {
      setRoiAnnotation(getSelectedAnalysisRoi());
      setRoiRevision(revision => revision + 1);
    };

    updateRoiState();

    const addedEvt = toolEnums.Events.ANNOTATION_ADDED;
    const modifiedEvt = toolEnums.Events.ANNOTATION_MODIFIED;
    const removedEvt = toolEnums.Events.ANNOTATION_REMOVED;
    const selectionEvt = toolEnums.Events.ANNOTATION_SELECTION_CHANGE;

    eventTarget.addEventListener(addedEvt, updateRoiState);
    eventTarget.addEventListener(modifiedEvt, updateRoiState);
    eventTarget.addEventListener(removedEvt, updateRoiState);
    eventTarget.addEventListener(selectionEvt, updateRoiState);

    const subscriptions = [];
    if (viewportGridService?.subscribe) {
      subscriptions.push(
        viewportGridService.subscribe(
          viewportGridService.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED,
          updateRoiState
        )
      );
      subscriptions.push(
        viewportGridService.subscribe(viewportGridService.EVENTS.GRID_STATE_CHANGED, updateRoiState)
      );
    }

    return () => {
      eventTarget.removeEventListener(addedEvt, updateRoiState);
      eventTarget.removeEventListener(modifiedEvt, updateRoiState);
      eventTarget.removeEventListener(removedEvt, updateRoiState);
      eventTarget.removeEventListener(selectionEvt, updateRoiState);
      subscriptions.forEach(subscription => subscription.unsubscribe());
    };
  }, [getSelectedAnalysisRoi, viewportGridService]);

  const renderRoiPreview = useCallback(() => {
    if (roiAnnotation && !isRoiInActiveSeries(roiAnnotation)) {
      setRoiAnnotation(null);
      setRoiPreviewUrl(null);
      setRoiAnalysisData(null);
      return;
    }
    if (!roiAnnotation || !activeViewportId || !cornerstoneViewportService) {
      setRoiPreviewUrl(null);
      return;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) {
      setRoiPreviewUrl(null);
      return;
    }

    const frameOfReferenceUID = roiAnnotation?.metadata?.FrameOfReferenceUID;
    if (frameOfReferenceUID && viewport.getFrameOfReferenceUID) {
      const viewportForUID = viewport.getFrameOfReferenceUID();
      if (viewportForUID && viewportForUID !== frameOfReferenceUID) {
        setRoiPreviewUrl(null);
        return;
      }
    }

    const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
    const element = viewportInfo?.element;
    const sourceCanvas = element?.querySelector('canvas');

    if (!sourceCanvas || !roiAnnotation?.data?.handles?.points?.length) {
      setRoiPreviewUrl(null);
      return;
    }

    const points = roiAnnotation.data.handles.points.slice(0, 4);
    if (points.length < 4) {
      setRoiPreviewUrl(null);
      return;
    }

    // Calculate width and height in world coordinates (physical units)
    const widthWorld = Math.hypot(
      points[1][0] - points[0][0],
      points[1][1] - points[0][1],
      points[1][2] - points[0][2]
    );
    const heightWorld = Math.hypot(
      points[2][0] - points[0][0],
      points[2][1] - points[0][1],
      points[2][2] - points[0][2]
    );

    const elementWidth = element?.clientWidth || 0;
    const elementHeight = element?.clientHeight || 0;
    const sourceWidth = sourceCanvas.width;
    const sourceHeight = sourceCanvas.height;
    const scaleX =
      elementWidth > 0 && sourceWidth > 0 ? sourceWidth / elementWidth : 1;
    const scaleY =
      elementHeight > 0 && sourceHeight > 0 ? sourceHeight / elementHeight : 1;

    let shouldNormalizeCanvasPoints = false;
    let canvasPoints = points.map(point => viewport.worldToCanvas(point));
    if (scaleX > 1.01 || scaleY > 1.01) {
      const maxX = Math.max(...canvasPoints.map(point => point[0]));
      const maxY = Math.max(...canvasPoints.map(point => point[1]));
      const needsNormalization =
        (elementWidth > 0 && maxX > elementWidth * 1.2) ||
        (elementHeight > 0 && maxY > elementHeight * 1.2);

      if (needsNormalization) {
        shouldNormalizeCanvasPoints = true;
        canvasPoints = canvasPoints.map(point => [point[0] / scaleX, point[1] / scaleY]);
      }
    }
    const bottomLeft = canvasPoints[0];
    const bottomRight = canvasPoints[1];
    const topLeft = canvasPoints[2];
    const topRight = canvasPoints[3];

    const width = Math.hypot(bottomRight[0] - bottomLeft[0], bottomRight[1] - bottomLeft[1]);
    const height = Math.hypot(topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1]);

    if (!width || !height) {
      setRoiPreviewUrl(null);
      return;
    }

    const angle = Math.atan2(
      bottomRight[1] - bottomLeft[1],
      bottomRight[0] - bottomLeft[0]
    );
    const center = [(bottomLeft[0] + topRight[0]) / 2, (bottomLeft[1] + topRight[1]) / 2];

    const previewCanvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    previewCanvas.width = Math.round(PREVIEW_WIDTH * dpr);
    previewCanvas.height = Math.round(PREVIEW_HEIGHT * dpr);

    const ctx = previewCanvas.getContext('2d');
    if (!ctx) {
      setRoiPreviewUrl(null);
      return;
    }

    const imageId =
      roiAnnotation?.metadata?.referencedImageId || viewport.getCurrentImageId?.();
    const calibratedSpacing = imageId
      ? metaData.get('calibratedPixelSpacing', imageId)
      : null;
    const imagePlaneModule = imageId ? metaData.get('imagePlaneModule', imageId) : null;

    const spacingX =
      calibratedSpacing?.columnPixelSpacing ?? imagePlaneModule?.columnPixelSpacing ?? null;
    const spacingY =
      calibratedSpacing?.rowPixelSpacing ?? imagePlaneModule?.rowPixelSpacing ?? null;
    const hasSpacing =
      typeof spacingX === 'number' &&
      typeof spacingY === 'number' &&
      Number.isFinite(spacingX) &&
      Number.isFinite(spacingY) &&
      spacingX > 0 &&
      spacingY > 0 &&
      !imagePlaneModule?.usingDefaultValues;
    setShowSpacingWarning(prev => (prev === !hasSpacing ? prev : !hasSpacing));

    const currentIndex = viewport.getCurrentImageIdIndex?.();
    const totalSlices = viewport.getNumberOfSlices?.();
    if (typeof currentIndex === 'number') {
      setFrameInfo({
        index: currentIndex + 1,
        total: typeof totalSlices === 'number' ? totalSlices : null,
      });
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    ctx.imageSmoothingEnabled = true;

    const scale = Math.min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height);

    ctx.save();
    ctx.translate(PREVIEW_WIDTH / 2, PREVIEW_HEIGHT / 2);
    ctx.scale(scale, scale);
    ctx.rotate(-angle);
    ctx.translate(-center[0], -center[1]);
    const drawWidth = elementWidth || sourceWidth;
    const drawHeight = elementHeight || sourceHeight;
    ctx.drawImage(sourceCanvas, 0, 0, drawWidth, drawHeight);
    ctx.restore();

    // Store a ROI-sized canvas for debug export (before overlays are drawn).
    {
      const roiCanvas = document.createElement('canvas');
      const roiWidth = Math.max(1, Math.round(width));
      const roiHeight = Math.max(1, Math.round(height));
      roiCanvas.width = Math.round(roiWidth * dpr);
      roiCanvas.height = Math.round(roiHeight * dpr);
      const roiCtx = roiCanvas.getContext('2d');
      if (roiCtx) {
        roiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        roiCtx.fillStyle = '#111827';
        roiCtx.fillRect(0, 0, roiWidth, roiHeight);
        roiCtx.imageSmoothingEnabled = true;
        roiCtx.save();
        roiCtx.translate(roiWidth / 2, roiHeight / 2);
        roiCtx.rotate(-angle);
        roiCtx.translate(-center[0], -center[1]);
        roiCtx.drawImage(sourceCanvas, 0, 0, drawWidth, drawHeight);
        roiCtx.restore();
      }
      debugPreviewCanvasRef.current = roiCanvas;
    }

    // Debug data exposure for TDD testing and debug export
    {
      const imagePlane = imagePlaneModule;
      const orientation = imagePlane?.imageOrientationPatient;
      const position = imagePlane?.imagePositionPatient;
      const rowSpacing = imagePlane?.rowPixelSpacing ?? 1;
      const colSpacing = imagePlane?.columnPixelSpacing ?? 1;

      let indexPoints: number[][] | null = null;
      if (orientation && position) {
        const rowCosines = [orientation[0], orientation[1], orientation[2]];
        const colCosines = [orientation[3], orientation[4], orientation[5]];
        indexPoints = points.map((pt: number[]) => {
          const dx = pt[0] - position[0];
          const dy = pt[1] - position[1];
          const dz = pt[2] - position[2];
          const col = (dx * colCosines[0] + dy * colCosines[1] + dz * colCosines[2]) / colSpacing;
          const row = (dx * rowCosines[0] + dy * rowCosines[1] + dz * rowCosines[2]) / rowSpacing;
          return [col, row];
        });
      }

      // Try to get image dimensions
      const cachedImage = imageId ? cache.getImage(imageId) : null;

      const roiPreviewWidth = Math.max(1, Math.round(width));
      const roiPreviewHeight = Math.max(1, Math.round(height));

      (window as any).__MEDEX_ROI_DEBUG_DATA = {
        worldPoints: points,
        canvasPoints,
        indexPoints,
        widthCanvas: width,
        heightCanvas: height,
        widthWorld: widthWorld,
        heightWorld: heightWorld,
        angleRad: angle,
        centerCanvas: center,
        previewScale: scale,
        previewDimensions: { width: roiPreviewWidth, height: roiPreviewHeight },
        previewCanvasMode: 'roi',
        dicomMetadata: {
          imagePositionPatient: position || null,
          imageOrientationPatient: orientation || null,
          rowPixelSpacing: rowSpacing,
          columnPixelSpacing: colSpacing,
          rows: cachedImage?.rows || cachedImage?.height || null,
          columns: cachedImage?.columns || cachedImage?.width || null,
        },
        sourceCanvas: {
          width: sourceWidth,
          height: sourceHeight,
          elementWidth,
          elementHeight,
        },
        timestamp: Date.now(),
      };

      if ((window as any).__MEDEX_DEBUG_ROI_EXPORT) {
        // eslint-disable-next-line no-console
        console.info('[ROI Debug] Data captured. Access via window.__MEDEX_ROI_DEBUG_DATA');
      }
    }

    const roiWidth = width * scale;
    const roiHeight = height * scale;
    const startX = (PREVIEW_WIDTH - roiWidth) / 2;
    const startY = (PREVIEW_HEIGHT - roiHeight) / 2;

    const labelStateMap = new Map(
      segmentationLabels.map(label => [label.id, label])
    );
    const labelIdToIndex = new Map<string, number>();
    const labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }> = {};
    SEGMENTATION_LABELS.forEach((label, index) => {
      const labelIndex = index + 1;
      labelIdToIndex.set(label.id, labelIndex);
      labelMap[labelIndex] = {
        labelId: label.id,
        labelName: label.name,
        labelColor: label.color,
      };
    });

    const currentFrameNumber =
      typeof currentIndex === 'number' ? currentIndex + 1 : undefined;
    const contourAnnotations =
      annotation.state.getAnnotations(MANUAL_CONTOUR_TOOL, element as HTMLElement) || [];
    const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
    const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
    const displaySet = displaySetInstanceUID
      ? displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID)
      : undefined;
    const seriesInstanceUID = displaySet?.SeriesInstanceUID;

    const filteredContours = contourAnnotations.filter(contour => {
      const contourModelType = contour?.data?.modelType || 'manual';
      if (contourModelType !== segmentationModel) {
        return false;
      }

      if (seriesInstanceUID && contour?.data?.seriesInstanceUID) {
        if (contour.data.seriesInstanceUID !== seriesInstanceUID) {
          return false;
        }
      }

      if (imageId && contour?.metadata?.referencedImageId) {
        return contour.metadata.referencedImageId === imageId;
      }

      const frameNumber = contour?.data?.frameNumber || contour?.metadata?.frameNumber;
      if (currentFrameNumber && frameNumber) {
        return frameNumber === currentFrameNumber;
      }

      return false;
    });

    // Update currentFrameLabels with which labels have contours on current frame
    const labelsOnCurrentFrame = new Set<string>();
    filteredContours.forEach(contour => {
      const labelId = contour?.data?.labelId;
      if (labelId) {
        labelsOnCurrentFrame.add(labelId);
      }
    });
    setCurrentFrameLabels(labelsOnCurrentFrame);

    const roiMaskWidth = Math.max(1, Math.round(roiWidth));
    const roiMaskHeight = Math.max(1, Math.round(roiHeight));
    const roiScaleX = roiMaskWidth / roiWidth;
    const roiScaleY = roiMaskHeight / roiHeight;
    const maskData = new Uint8Array(roiMaskWidth * roiMaskHeight);
    const overlayImageData = ctx.createImageData(roiMaskWidth, roiMaskHeight);

    const cosAngle = Math.cos(-angle);
    const sinAngle = Math.sin(-angle);
    const normalizeCanvasPoint = (worldPoint: number[]) => {
      const canvasPoint = viewport.worldToCanvas(worldPoint);
      if (!shouldNormalizeCanvasPoints) {
        return canvasPoint;
      }
      return [canvasPoint[0] / scaleX, canvasPoint[1] / scaleY];
    };

    const toPreviewPoint = (canvasPoint: number[]) => {
      const dx = canvasPoint[0] - center[0];
      const dy = canvasPoint[1] - center[1];
      const rotatedX = dx * cosAngle - dy * sinAngle;
      const rotatedY = dx * sinAngle + dy * cosAngle;
      return [
        rotatedX * scale + PREVIEW_WIDTH / 2,
        rotatedY * scale + PREVIEW_HEIGHT / 2,
      ];
    };


    const contoursByEdit = [...filteredContours].sort((a, b) => {
      const timeA = a?.data?.modifiedAt || 0;
      const timeB = b?.data?.modifiedAt || 0;
      return timeA - timeB;
    });

    contoursByEdit.forEach(contour => {
      const polyline = contour?.data?.contour?.polyline || contour?.data?.handles?.points;
      if (!polyline || polyline.length < 3) {
        return;
      }

      const labelId = contour?.data?.labelId;
      const labelIndex = labelId ? labelIdToIndex.get(labelId) : undefined;
      if (!labelIndex) {
        return;
      }

      const polygon = polyline.map(point => {
        const canvasPoint = normalizeCanvasPoint(point);
        const previewPoint = toPreviewPoint(canvasPoint);
        // Convert from preview coords to ROI mask coords
        return [
          ((previewPoint[0] - startX) / roiWidth) * roiMaskWidth,
          ((previewPoint[1] - startY) / roiHeight) * roiMaskHeight,
        ];
      });

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

      const startXPixel = Math.max(0, Math.floor(minX));
      const startYPixel = Math.max(0, Math.floor(minY));
      const endXPixel = Math.min(roiMaskWidth - 1, Math.ceil(maxX));
      const endYPixel = Math.min(roiMaskHeight - 1, Math.ceil(maxY));

      for (let y = startYPixel; y <= endYPixel; y += 1) {
        for (let x = startXPixel; x <= endXPixel; x += 1) {
          if (isPointInPolygon([x + 0.5, y + 0.5], polygon)) {
            maskData[y * roiMaskWidth + x] = labelIndex;
          }
        }
      }
    });

    const overlayData = overlayImageData.data;
    for (let i = 0; i < maskData.length; i += 1) {
      const labelIndex = maskData[i];
      if (!labelIndex) {
        continue;
      }

      const labelInfo = labelMap[labelIndex];
      if (!labelInfo) {
        continue;
      }

      const labelState = labelStateMap.get(labelInfo.labelId);
      if (labelState && !labelState.visible) {
        continue;
      }

      const color = labelState?.color || labelInfo.labelColor;
      const opacity = labelState?.opacity ?? 0.3;
      const [r, g, b] = hexToRgb(color);
      const alpha = Math.round(opacity * 255);
      const dataIndex = i * 4;
      overlayData[dataIndex] = r;
      overlayData[dataIndex + 1] = g;
      overlayData[dataIndex + 2] = b;
      overlayData[dataIndex + 3] = alpha;
    }

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = roiMaskWidth;
    overlayCanvas.height = roiMaskHeight;
    const overlayCtx = overlayCanvas.getContext('2d');
    if (overlayCtx) {
      overlayCtx.putImageData(overlayImageData, 0, 0);
      // Draw overlay at the same position and size as the ROI image
      ctx.drawImage(overlayCanvas, startX, startY, roiWidth, roiHeight);
    }


    // Render MaskContour annotations as dashed outline
    const maskAnnotations =
      annotation.state.getAnnotations(MASK_CONTOUR_TOOL, element as HTMLElement) || [];
    const filteredMasks = maskAnnotations.filter(mask => {
      if (seriesInstanceUID && mask?.data?.seriesInstanceUID) {
        if (mask.data.seriesInstanceUID !== seriesInstanceUID) {
          return false;
        }
      }

      if (imageId && mask?.metadata?.referencedImageId) {
        return mask.metadata.referencedImageId === imageId;
      }

      const frameNumber = mask?.data?.frameNumber || mask?.metadata?.frameNumber;
      if (currentFrameNumber && frameNumber) {
        return frameNumber === currentFrameNumber;
      }

      return false;
    });

    // Draw mask contours as dashed outlines
    filteredMasks.forEach(mask => {
      const polyline = mask?.data?.contour?.polyline || mask?.data?.handles?.points;
      if (!polyline || polyline.length < 3) {
        return;
      }

      // Transform contour points to preview canvas space
      const previewPoints = polyline.map(point => {
        const canvasPoint = normalizeCanvasPoint(point);
        return toPreviewPoint(canvasPoint);
      });

      // Draw dashed outline
      ctx.save();
      ctx.strokeStyle = MASK_CONTOUR_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      previewPoints.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point[0], point[1]);
        } else {
          ctx.lineTo(point[0], point[1]);
        }
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    });

    // Draw manual contour outlines on top of filled overlay
    contoursByEdit.forEach(contour => {
      const polyline = contour?.data?.contour?.polyline || contour?.data?.handles?.points;
      if (!polyline || polyline.length < 3) {
        return;
      }

      const labelId = contour?.data?.labelId;
      const labelIndex = labelId ? labelIdToIndex.get(labelId) : undefined;
      if (!labelIndex) {
        return;
      }

      const labelState = labelStateMap.get(labelId);
      if (labelState && !labelState.visible) {
        return;
      }

      const color = labelState?.color || labelMap[labelIndex]?.labelColor || '#FFFFFF';

      // Transform contour points to preview canvas space
      const previewPoints = polyline.map(point => {
        const canvasPoint = normalizeCanvasPoint(point);
        return toPreviewPoint(canvasPoint);
      });

      // Draw solid outline
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      previewPoints.forEach((point, index) => {
        if (index === 0) {
          ctx.moveTo(point[0], point[1]);
        } else {
          ctx.lineTo(point[0], point[1]);
        }
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    });

    if (seriesInstanceUID) {
      const frameKey = imageId
        ? imageId
        : typeof currentFrameNumber === 'number'
          ? `frame:${currentFrameNumber}`
          : 'frame:unknown';
      setRoiSegmentationFrame(seriesInstanceUID, frameKey, {
        frameKey,
        imageId: imageId || undefined,
        frameNumber: currentFrameNumber || undefined,
        roiAnnotationUID: roiAnnotation?.annotationUID,
        roiWidthWorld: widthWorld,
        roiHeightWorld: heightWorld,
        width: roiMaskWidth,
        height: roiMaskHeight,
        maskData,
        labelMap,
        generatedAt: Date.now(),
      });
    }

    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.rect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    ctx.rect(startX, startY, roiWidth, roiHeight);
    ctx.fill('evenodd');

    ctx.strokeStyle = MEDEX_ORANGE;
    ctx.lineWidth = 4;
    ctx.strokeRect(0.75, 0.75, PREVIEW_WIDTH - 1.5, PREVIEW_HEIGHT - 1.5);

    // Use world coordinates (already in mm) for grid calculations
    const roiWidthUnits = widthWorld;
    const roiHeightUnits = heightWorld;
    const maxUnits = Math.max(roiWidthUnits, roiHeightUnits);

    const targetTicks = 5;
    const rawStep = maxUnits > 0 ? maxUnits / targetTicks : 10;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const baseSteps = [1, 2, 5, 10];
    let tickEveryUnit = baseSteps[baseSteps.length - 1] * magnitude;
    for (const base of baseSteps) {
      const candidate = base * magnitude;
      if (candidate >= rawStep) {
        tickEveryUnit = candidate;
        break;
      }
    }

    // Convert tick spacing from world units (mm) to canvas pixels
    const roiWidthPx = width * scale;
    const roiHeightPx = height * scale;
    const tickEveryPxX = roiWidthUnits > 0 ? (tickEveryUnit / roiWidthUnits) * roiWidthPx : 0;
    const tickEveryPxY = roiHeightUnits > 0 ? (tickEveryUnit / roiHeightUnits) * roiHeightPx : 0;
    const unitLabel = hasSpacing ? 'mm' : 'px';

    if (tickEveryPxX > 6 || tickEveryPxY > 6) {
      const tickLength = 16;
      const labelOffset = 6;
      const fontSize = 40;
      const originalLineWidth = ctx.lineWidth;
      ctx.lineWidth = 4;

      ctx.fillStyle = MEDEX_ORANGE;
      ctx.font = `${fontSize}px Arial, Helvetica, sans-serif`;

      if (tickEveryPxX > 6) {
        let tickIndex = 0;
        for (let x = 0; x <= PREVIEW_WIDTH + 0.5; x += tickEveryPxX) {
          const labelValue = tickIndex * tickEveryUnit;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, tickLength);
          ctx.stroke();
          if (tickIndex !== 0) {
            ctx.fillText(`${labelValue}${unitLabel}`, x, tickLength + labelOffset);
          }

          tickIndex += 1;
        }
      }

      if (tickEveryPxY > 6) {
        let tickIndex = 0;
        for (let y = 0; y <= PREVIEW_HEIGHT + 0.5; y += tickEveryPxY) {
          const labelValue = tickIndex * tickEveryUnit;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(tickLength, y);
          ctx.stroke();
          if (tickIndex !== 0) {
            ctx.fillText(`${labelValue}${unitLabel}`, tickLength + labelOffset, y);
          }

          tickIndex += 1;
        }
      }
      ctx.lineWidth = originalLineWidth;
    }

    if (kymographSettings.showProfileLine) {
      const isHorizontalProfile =
        kymographSettings.spatialAxis === 'major'
          ? widthWorld >= heightWorld
          : widthWorld < heightWorld;

      ctx.strokeStyle = '#22C55E';
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 4]);

      if (isHorizontalProfile) {
        const midY = PREVIEW_HEIGHT / 2;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(PREVIEW_WIDTH, midY);
        ctx.stroke();
      } else {
        const midX = PREVIEW_WIDTH / 2;
        ctx.beginPath();
        ctx.moveTo(midX, 0);
        ctx.lineTo(midX, PREVIEW_HEIGHT);
        ctx.stroke();
      }

      ctx.setLineDash([]);
    }

    setRoiPreviewUrl(previewCanvas.toDataURL('image/png'));
    setPreviewMode('fast');
    scheduleAccuratePreview();
  }, [
    roiAnnotation,
    activeViewportId,
    cornerstoneViewportService,
    kymographSettings,
    segmentationLabels,
    displaySetService,
    isRoiInActiveSeries,
    scheduleAccuratePreview,
  ]);

  useEffect(() => {
    renderRoiPreview();
  }, [renderRoiPreview, roiRevision]);

  useEffect(() => {
    return () => {
      if (accuratePreviewTimeoutRef.current) {
        window.clearTimeout(accuratePreviewTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    buildRoiAnalysisData();
  }, [buildRoiAnalysisData]);

  useEffect(() => {
    if (!activeViewportId || !cornerstoneViewportService) {
      return;
    }

    const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
    const element = viewportInfo?.element;
    if (!element) {
      return;
    }

    const handleRender = () => {
      updateFrameRateForViewport();
      renderRoiPreview();
      buildRoiAnalysisData();
    };

    element.addEventListener(csEnums.Events.IMAGE_RENDERED, handleRender);
    window.addEventListener('resize', handleRender);

    return () => {
      element.removeEventListener(csEnums.Events.IMAGE_RENDERED, handleRender);
      window.removeEventListener('resize', handleRender);
    };
  }, [
    activeViewportId,
    cornerstoneViewportService,
    renderRoiPreview,
    buildRoiAnalysisData,
    updateFrameRateForViewport,
  ]);

  const hasAnalysisRoi = !!roiAnnotation;
  const hasPreview = hasAnalysisRoi && !!roiPreviewUrl;
  // Only show pending for non-manual models when backend computation is in progress
  // For manual model, contours are user-drawn so never "pending"
  const segmentationPending = false; // TODO: Connect to actual backend computation state
  const frameLabel =
    frameInfo.index && frameInfo.total
      ? `Frame ${frameInfo.index}/${frameInfo.total}`
      : frameInfo.index
        ? `Frame ${frameInfo.index}`
        : null;

  const handleActivateTool = () => {
    commandsManager?.run?.('setToolActive', {
      toolName: TOOL_NAME,
      toolGroupId: TOOL_GROUP_ID,
    });
  };

  const exportDisabledReason = !hasAnalysisRoi
    ? 'Define an ROI to export'
    : 'Temporal ROI export is unavailable';
  const hasTemporalFrames =
    !!activeViewportId &&
    !!cornerstoneViewportService &&
    (cornerstoneViewportService.getCornerstoneViewport(activeViewportId)?.getImageIds?.()
      ?.length ?? 0) > 0;
  const canExportTemporalRoi = hasAnalysisRoi && hasTemporalFrames;

  return (
    <div className="flex w-full flex-col bg-black p-3 text-white">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: MEDEX_ORANGE }}>
          ROI Preview
        </h3>
        {frameLabel ? <span className="text-[11px] text-gray-400">{frameLabel}</span> : null}
      </div>

      {/* ROI Preview Area - 4:3 aspect ratio */}
      <div
        className={`relative mb-3 flex items-center justify-center rounded border border-gray-700 bg-gray-900 ${
          !hasAnalysisRoi ? 'cursor-pointer hover:border-gray-500' : ''
        }`}
        style={{ aspectRatio: '4/3' }}
        onClick={!hasAnalysisRoi ? handleActivateTool : undefined}
        role={!hasAnalysisRoi ? 'button' : undefined}
        tabIndex={!hasAnalysisRoi ? 0 : undefined}
        onKeyDown={
          !hasAnalysisRoi
            ? evt => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  handleActivateTool();
                }
              }
            : undefined
        }
      >
        {!hasAnalysisRoi ? (
          <div className="text-center text-gray-500">
            <svg
              className="mx-auto mb-2 h-12 w-12"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <rect
                x="4"
                y="4"
                width="16"
                height="16"
                rx="2"
                strokeWidth="2"
                className="text-gray-600"
              />
              <path
                d="M12 8v8m-4-4h8"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <p className="text-xs">No ROI Selected</p>
            <p className="mt-1 text-[10px]" style={{ color: MEDEX_ORANGE }}>
              Click to draw Analysis ROI
            </p>
          </div>
        ) : hasPreview ? (
          <img
            src={roiPreviewUrl}
            alt="Selected ROI preview"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="text-center text-gray-500">
            <p className="text-xs text-gray-200">Analysis ROI Selected</p>
            <p className="mt-1 text-[10px] text-gray-400">
              Preview unavailable for this view
            </p>
          </div>
        )}
        <div className="absolute bottom-2 right-2 flex flex-col items-end gap-1">
          {hasPreview ? (
            <div className="rounded bg-black/70 px-2 py-1 text-[9px] uppercase tracking-wide text-gray-300">
              {previewMode === 'accurate' ? 'Accurate Preview' : 'Fast Preview'}
            </div>
          ) : null}
          {segmentationPending ? (
            <div className="rounded bg-black/70 px-2 py-1 text-[10px] text-gray-200">
              Segmentation pending
            </div>
          ) : null}
          {showSpacingWarning ? (
            <div className="rounded bg-black/70 px-2 py-1 text-[10px] text-gray-200">
              Pixel spacing missing, units in px
            </div>
          ) : null}
        </div>
        <div
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] uppercase tracking-wide text-gray-300"
          style={{ writingMode: 'vertical-rl', transform: 'translateY(-50%) rotate(180deg)' }}
        >
          Fundus End
        </div>
        <div
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] uppercase tracking-wide text-gray-300"
          style={{ writingMode: 'vertical-rl' }}
        >
          Cervix End
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <span>Temporal ROI Export</span>
          <select
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-200"
            value={exportFormat}
            onChange={evt => setExportFormat(evt.target.value as 'nifti' | 'nifti_gz' | 'tiff' | 'debug')}
            disabled={!canExportTemporalRoi || isExporting}
          >
            <option value="nifti_gz">NIfTI (.nii.gz)</option>
            <option value="nifti">NIfTI (.nii)</option>
            <option value="tiff">TIFF (.tiff)</option>
          </select>
        </div>
        <button
          type="button"
          className={`relative flex items-center justify-center overflow-hidden rounded border px-3 py-1 text-[11px] font-semibold ${
            canExportTemporalRoi && !isExporting
              ? 'border-orange-500 text-orange-400 hover:bg-orange-500/10'
              : 'cursor-not-allowed border-gray-700 text-gray-500'
          }`}
          onClick={handleTemporalExport}
          disabled={!canExportTemporalRoi || isExporting}
          title={canExportTemporalRoi ? 'Export temporal ROI stack' : exportDisabledReason}
        >
          {isExporting ? (
            <span
              className="absolute inset-0 bg-orange-500/30"
              style={{ width: `${exportProgress}%` }}
            />
          ) : null}
          <span className="relative text-center">
            {isExporting ? `Exporting ${exportProgress}%` : 'Export'}
          </span>
        </button>
      </div>

      {/* ROI Controls */}
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <label className="flex flex-1 items-center text-gray-400">
            <span className="mr-2">Segmentation Model</span>
            <div className="relative ml-auto">
              <select
                className="appearance-none rounded border border-gray-700 bg-gray-900 px-2 py-1 pr-6 text-[11px] text-gray-200"
                value={segmentationModel}
                onChange={evt => handleSegmentationModelChange(evt.target.value)}
              >
                <option value="manual">Manual</option>
                <option value="threshold">Threshold</option>
                <option value="medsam">MedSAM</option>
                <option value="unet_uterine">UNet-Uterine</option>
              </select>
              <svg
                className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-200"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {SEGMENTATION_LABELS.map(item => {
            const labelState = segmentationLabels.find(label => label.id === item.id);
            const isVisible = labelState?.visible ?? false;
            const hasLabelOnCurrentFrame = currentFrameLabels.has(item.id);
            const hasLabelAnywhere = Boolean(labelState);

            return (
              <div key={item.id} className="flex items-center gap-2">
                <button
                  type="button"
                  className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
                    hasLabelOnCurrentFrame && isVisible ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-500'
                  } ${hasLabelAnywhere ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                  title={
                    hasLabelOnCurrentFrame
                      ? isVisible
                        ? 'Hide contour'
                        : 'Show contour'
                      : hasLabelAnywhere
                        ? 'No contour on this frame'
                        : 'No contour for this label'
                  }
                  onClick={() => {
                    if (!hasLabelAnywhere) {
                      return;
                    }
                    setLabelVisibility(item.id, !isVisible);
                  }}
                  disabled={!hasLabelAnywhere}
                >
                  {isVisible ? (
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                      />
                    </svg>
                  ) : (
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                      />
                    </svg>
                  )}
                </button>
                <span style={{ color: item.color }}>{item.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default RoiViewerPanel;
