import React, { useEffect, useRef, useState } from 'react';
import { annotation } from '@cornerstonejs/tools';
import { SegmentationLabel, getFirstAnnotationUID } from '../../utils/segmentationStore';

interface SegmentationThumbnailProps {
  label: SegmentationLabel;
  servicesManager?: any;
  activeViewportId?: string;
  roiAnnotation?: any;
  size?: number;
  revision?: number; // Force re-render when annotations change
}

const BUFFER_RATIO = 0.05; // 5% edge buffer

const SegmentationThumbnail: React.FC<SegmentationThumbnailProps> = ({
  label,
  servicesManager,
  activeViewportId,
  roiAnnotation,
  size = 48,
  revision = 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    if (!canvasRef.current || !servicesManager || !activeViewportId || !roiAnnotation) {
      setHasContent(false);
      return;
    }

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    if (!cornerstoneViewportService) {
      setHasContent(false);
      return;
    }

    const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    if (!viewport) {
      setHasContent(false);
      return;
    }

    const viewportInfo = cornerstoneViewportService.getViewportInfo(activeViewportId);
    const element = viewportInfo?.element;
    const sourceCanvas = element?.querySelector('canvas');

    if (!sourceCanvas || !roiAnnotation?.data?.handles?.points?.length) {
      setHasContent(false);
      return;
    }

    // Get contour annotation
    const annotationUID = getFirstAnnotationUID(label);
    const contourAnnotation = annotationUID ? annotation.state.getAnnotation(annotationUID) : null;

    // Get contour polyline - try contour.polyline first, then handles.points as fallback
    const contourPolyline =
      contourAnnotation?.data?.contour?.polyline ||
      contourAnnotation?.data?.handles?.points;

    if (!contourPolyline || contourPolyline.length < 3) {
      setHasContent(false);
      return;
    }

    const roiPoints = roiAnnotation.data.handles.points.slice(0, 4);
    if (roiPoints.length < 4) {
      setHasContent(false);
      return;
    }

    // Convert ROI points to canvas coordinates
    const elementWidth = element?.clientWidth || 0;
    const elementHeight = element?.clientHeight || 0;
    const sourceWidth = sourceCanvas.width;
    const sourceHeight = sourceCanvas.height;
    const scaleX = elementWidth > 0 && sourceWidth > 0 ? sourceWidth / elementWidth : 1;
    const scaleY = elementHeight > 0 && sourceHeight > 0 ? sourceHeight / elementHeight : 1;

    let canvasPoints = roiPoints.map(point => viewport.worldToCanvas(point));
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
      setHasContent(false);
      return;
    }

    const angle = Math.atan2(bottomRight[1] - bottomLeft[1], bottomRight[0] - bottomLeft[0]);
    const center = [(bottomLeft[0] + topRight[0]) / 2, (bottomLeft[1] + topRight[1]) / 2];

    // Add 5% buffer
    const bufferWidth = width * (1 + 2 * BUFFER_RATIO);
    const bufferHeight = height * (1 + 2 * BUFFER_RATIO);

    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setHasContent(false);
      return;
    }

    // Calculate scale to fit with buffer
    const scale = Math.min(size / bufferWidth, size / bufferHeight);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;

    // Draw the source image cropped to ROI
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.rotate(-angle);
    ctx.translate(-center[0], -center[1]);
    const drawWidth = elementWidth || sourceWidth;
    const drawHeight = elementHeight || sourceHeight;
    ctx.drawImage(sourceCanvas, 0, 0, drawWidth, drawHeight);
    ctx.restore();

    // Draw contour overlay
    if (contourPolyline && contourPolyline.length > 2) {
      // Convert contour world points to canvas
      let contourCanvasPoints = contourPolyline.map(point => viewport.worldToCanvas(point));
      if (scaleX > 1.01 || scaleY > 1.01) {
        const maxX = Math.max(...contourCanvasPoints.map(p => p[0]));
        const maxY = Math.max(...contourCanvasPoints.map(p => p[1]));
        const needsNormalization =
          (elementWidth > 0 && maxX > elementWidth * 1.2) ||
          (elementHeight > 0 && maxY > elementHeight * 1.2);
        if (needsNormalization) {
          contourCanvasPoints = contourCanvasPoints.map(p => [p[0] / scaleX, p[1] / scaleY]);
        }
      }

      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.scale(scale, scale);
      ctx.rotate(-angle);
      ctx.translate(-center[0], -center[1]);

      // Draw filled contour with transparency
      ctx.beginPath();
      ctx.moveTo(contourCanvasPoints[0][0], contourCanvasPoints[0][1]);
      for (let i = 1; i < contourCanvasPoints.length; i++) {
        ctx.lineTo(contourCanvasPoints[i][0], contourCanvasPoints[i][1]);
      }
      ctx.closePath();

      // Parse label color and add alpha
      const fillColor = label.color + 'B3'; // ~70% opacity
      ctx.fillStyle = fillColor;
      ctx.fill();

      // Draw contour outline
      ctx.strokeStyle = label.color;
      ctx.lineWidth = 2 / scale;
      ctx.stroke();

      ctx.restore();
    }

    setHasContent(true);
  }, [label, servicesManager, activeViewportId, roiAnnotation, size, revision]);

  if (!hasContent) {
    return (
      <div
        className="flex items-center justify-center rounded bg-gray-800"
        style={{ width: size, height: size }}
      >
        <div
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: label.color }}
        />
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="rounded"
      style={{ width: size, height: size }}
    />
  );
};

export default SegmentationThumbnail;
