import React, { useCallback, useEffect, useState } from 'react';
import { cache, eventTarget, Enums as csEnums, metaData } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';
import {
  getRoiAnalysisData,
  setRoiAnalysisData,
} from '../utils/roiAnalysisDataStore';
import {
  getKymographSettings,
  subscribeKymographSettings,
} from '../utils/kymographSettingsStore';

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
const SEGMENTATION_LABELS = [
  { id: 'uterineCavity', label: 'Uterine Cavity', color: '#22D3EE' },
  { id: 'endometrium', label: 'Endometrium', color: '#F472B6' },
  { id: 'myometrium', label: 'Myometrium', color: '#FBBF24' },
  { id: 'cervixCavity', label: 'Cervix Cavity', color: '#60A5FA' },
];
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
  const [segmentationSelections] = useState<Record<string, boolean>>({
    uterineCavity: false,
    endometrium: false,
    myometrium: false,
    cervix: false,
  });
  const [segmentationModel, setSegmentationModel] = useState('medsam');
  const [kymographSettings, setKymographSettings] = useState(getKymographSettings());
  const [{ activeViewportId }] = useViewportGrid();
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;

  useEffect(() => {
    const unsubscribe = subscribeKymographSettings(settings => {
      setKymographSettings(settings);
    });
    return unsubscribe;
  }, []);

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

    setRoiAnalysisData({
      annotationUID: roiAnnotation.annotationUID,
      roiRevision,
      imageIds: frameImageIds,
      width: outputWidth,
      height: outputHeight,
      step,
      frames,
      spacing,
      createdAt: Date.now(),
    });
  }, [roiAnnotation, activeViewportId, cornerstoneViewportService, roiRevision]);

  const getSelectedAnalysisRoi = () => {
    const [selectedAnnotationUID] = annotation.selection.getAnnotationsSelected() || [];
    if (selectedAnnotationUID) {
      const selectedAnnotation = annotation.state.getAnnotation(selectedAnnotationUID);
      if (selectedAnnotation?.metadata?.toolName === TOOL_NAME) {
        return selectedAnnotation;
      }
    }

    const annotationManager = annotation.state.getAnnotationManager();
    if (!annotationManager?.getFramesOfReference) {
      return null;
    }

    const framesOfReference = annotationManager.getFramesOfReference() || [];
    for (const frameOfReference of framesOfReference) {
      const annotations = annotationManager.getAnnotations(frameOfReference, TOOL_NAME) || [];
      if (annotations.length) {
        return annotations[0];
      }
    }

    return null;
  };

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

    return () => {
      eventTarget.removeEventListener(addedEvt, updateRoiState);
      eventTarget.removeEventListener(modifiedEvt, updateRoiState);
      eventTarget.removeEventListener(removedEvt, updateRoiState);
      eventTarget.removeEventListener(selectionEvt, updateRoiState);
    };
  }, []);

  const renderRoiPreview = useCallback(() => {
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

    let canvasPoints = points.map(point => viewport.worldToCanvas(point));
    if (scaleX > 1.01 || scaleY > 1.01) {
      const maxX = Math.max(...canvasPoints.map(point => point[0]));
      const maxY = Math.max(...canvasPoints.map(point => point[1]));
      const needsNormalization =
        (elementWidth > 0 && maxX > elementWidth * 1.2) ||
        (elementHeight > 0 && maxY > elementHeight * 1.2);

      if (needsNormalization) {
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

    const roiWidth = width * scale;
    const roiHeight = height * scale;
    const startX = (PREVIEW_WIDTH - roiWidth) / 2;
    const startY = (PREVIEW_HEIGHT - roiHeight) / 2;

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
  }, [roiAnnotation, activeViewportId, cornerstoneViewportService, kymographSettings]);

  useEffect(() => {
    renderRoiPreview();
  }, [renderRoiPreview, roiRevision]);

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
      renderRoiPreview();
      buildRoiAnalysisData();
    };

    element.addEventListener(csEnums.Events.IMAGE_RENDERED, handleRender);
    window.addEventListener('resize', handleRender);

    return () => {
      element.removeEventListener(csEnums.Events.IMAGE_RENDERED, handleRender);
      window.removeEventListener('resize', handleRender);
    };
  }, [activeViewportId, cornerstoneViewportService, renderRoiPreview, buildRoiAnalysisData]);

  const hasAnalysisRoi = !!roiAnnotation;
  const hasPreview = hasAnalysisRoi && !!roiPreviewUrl;
  const segmentationPending = Object.values(segmentationSelections).some(Boolean);
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
        {segmentationPending ? (
          <div className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[10px] text-gray-200">
            Segmentation pending
          </div>
        ) : null}
        {showSpacingWarning ? (
          <div className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[10px] text-gray-200">
            Pixel spacing missing, units in px
          </div>
        ) : null}
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

      {/* ROI Controls */}
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <label className="flex flex-1 items-center text-gray-400">
            <span className="mr-2">Segmentation Model</span>
            <div className="relative ml-auto">
              <select
                className="appearance-none rounded border border-gray-700 bg-gray-900 px-2 py-1 pr-6 text-[11px] text-gray-200"
                value={segmentationModel}
                onChange={evt => setSegmentationModel(evt.target.value)}
              >
                <option value="medsam">MedSAM</option>
                <option value="unet-uterine">UNet-Uterine</option>
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
          {SEGMENTATION_LABELS.map(item => (
            <label
              key={item.id}
              className="flex items-center"
              style={{ color: item.color }}
            >
              <input
                type="checkbox"
                className="mr-2 rounded border-gray-600"
                checked={segmentationSelections[item.id]}
                disabled
                readOnly
              />
              {item.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
};

export default RoiViewerPanel;
