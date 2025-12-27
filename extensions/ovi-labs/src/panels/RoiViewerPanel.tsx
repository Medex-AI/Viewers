import React, { useCallback, useEffect, useState } from 'react';
import { eventTarget, Enums as csEnums } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';

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
  const [segmentationSelections] = useState<Record<string, boolean>>({
    uterineCavity: false,
    endometrium: false,
    myometrium: false,
    cervix: false,
  });
  const [segmentationModel, setSegmentationModel] = useState('medsam');
  const [{ activeViewportId }] = useViewportGrid();
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;

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

    const canvasPoints = points.map(point => viewport.worldToCanvas(point));
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

    const imageData = viewport.getImageData?.();
    const spacing = imageData?.getSpacing?.() || imageData?.spacing;
    const spacingX = Array.isArray(spacing) ? spacing[0] : null;
    const spacingY = Array.isArray(spacing) ? spacing[1] : null;
    const hasSpacing = !!(spacingX && spacingY);

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
    ctx.drawImage(sourceCanvas, 0, 0);
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

    if (hasSpacing) {
      const tickEveryMm = 100;
      const tickEveryPxX = (tickEveryMm / spacingX) * scale;
      const tickEveryPxY = (tickEveryMm / spacingY) * scale;
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
          const labelCm = (tickIndex * tickEveryMm) / 10;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, tickLength);
          ctx.stroke();
          if (tickIndex !== 0) {
            ctx.fillText(`${labelCm}cm`, x, tickLength + labelOffset);
          }

          tickIndex += 1;
        }
      }

      if (tickEveryPxY > 6) {
        let tickIndex = 0;
        for (let y = 0; y <= PREVIEW_HEIGHT + 0.5; y += tickEveryPxY) {
          const labelCm = (tickIndex * tickEveryMm) / 10;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(tickLength, y);
          ctx.stroke();
          if (tickIndex !== 0) {
            ctx.fillText(`${labelCm}cm`, tickLength + labelOffset, y);
          }

          tickIndex += 1;
        }
      }
      ctx.lineWidth = originalLineWidth;
    }

    setRoiPreviewUrl(previewCanvas.toDataURL('image/png'));
  }, [roiAnnotation, activeViewportId, cornerstoneViewportService]);

  useEffect(() => {
    renderRoiPreview();
  }, [renderRoiPreview, roiRevision]);

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
    };

    element.addEventListener(csEnums.Events.IMAGE_RENDERED, handleRender);
    window.addEventListener('resize', handleRender);

    return () => {
      element.removeEventListener(csEnums.Events.IMAGE_RENDERED, handleRender);
      window.removeEventListener('resize', handleRender);
    };
  }, [activeViewportId, cornerstoneViewportService, renderRoiPreview]);

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
            <select
              className="ml-auto rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-200"
              value={segmentationModel}
              onChange={evt => setSegmentationModel(evt.target.value)}
            >
              <option value="medsam">MedSAM</option>
              <option value="unet-uterine">UNet-Uterine</option>
            </select>
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
