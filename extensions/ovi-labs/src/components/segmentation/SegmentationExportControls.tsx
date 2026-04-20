import React, { useState, useEffect, useCallback } from 'react';
import { cache, imageLoader, metaData } from '@cornerstonejs/core';
import { useViewportGrid } from '@ohif/ui-next';
import {
  buildNiftiBuffer,
  buildZipBuffer,
  gzipBuffer,
  downloadBlob,
} from '../../utils/roiExport';
import { readActiveSegmentationFrames } from '../../utils/oviSegmentation';
import { extractFrameTimingFromImageIds } from '../../utils/dicomMetadataExtractor';

interface SegmentationExportControlsProps {
  servicesManager?: any;
}

const SegmentationExportControls: React.FC<SegmentationExportControlsProps> = ({
  servicesManager,
}) => {
  const [isExporting, setIsExporting] = useState(false);
  const [outputMode, setOutputMode] = useState<'label' | 'both'>('label');
  const [hasSegmentation, setHasSegmentation] = useState(false);
  const [{ activeViewportId }] = useViewportGrid();

  const uiNotificationService = servicesManager?.services?.uiNotificationService;
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
  const segmentationService = servicesManager?.services?.segmentationService;

  // Check whether there is an active segmentation for the viewport
  const refreshHasSegmentation = useCallback(() => {
    if (!activeViewportId || !segmentationService) {
      setHasSegmentation(false);
      return;
    }
    const active = segmentationService.getActiveSegmentation(activeViewportId);
    setHasSegmentation(Boolean(active));
  }, [activeViewportId, segmentationService]);

  useEffect(() => {
    refreshHasSegmentation();
  }, [refreshHasSegmentation]);

  // Re-check when segmentation events fire
  useEffect(() => {
    if (!segmentationService) return;
    const events = [
      segmentationService.EVENTS?.SEGMENTATION_ADDED,
      segmentationService.EVENTS?.SEGMENTATION_DATA_MODIFIED,
      segmentationService.EVENTS?.SEGMENTATION_REMOVED,
      segmentationService.EVENTS?.ACTIVE_SEGMENTATION_CHANGED,
    ].filter(Boolean);

    const subscriptions = events.map((evt: string) =>
      segmentationService.subscribe?.(evt, refreshHasSegmentation)
    );

    return () => {
      subscriptions.forEach((sub: any) => sub?.unsubscribe?.());
    };
  }, [segmentationService, refreshHasSegmentation]);

  const canExport = hasSegmentation && !isExporting;

  const handleExport = async () => {
    if (!canExport || !activeViewportId || !cornerstoneViewportService) return;

    setIsExporting(true);
    try {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
      const imageIds: string[] = viewport?.getImageIds?.() ?? [];

      if (!imageIds.length) {
        uiNotificationService?.show?.({
          title: 'Export',
          message: 'No images found in viewport.',
          type: 'error',
          duration: 3000,
        });
        return;
      }

      // Pixel spacing from DICOM metadata
      const imagePlane = metaData.get('imagePlaneModule', imageIds[0]) ?? {};
      const spacing = {
        row: (imagePlane.rowPixelSpacing ?? imagePlane.columnPixelSpacing ?? 1) as number,
        column: (imagePlane.columnPixelSpacing ?? imagePlane.rowPixelSpacing ?? 1) as number,
      };

      const { frameTimeMs } = extractFrameTimingFromImageIds(imageIds);

      const files: { name: string; data: ArrayBuffer }[] = [];

      // --- image.nii.gz ---
      if (outputMode === 'both') {
        const imageFrames: Array<Int16Array | Uint16Array | Uint8Array | Float32Array> = [];
        let imgWidth = 0;
        let imgHeight = 0;

        for (const imageId of imageIds) {
          const image =
            cache.getImage(imageId) ?? (await imageLoader.loadAndCacheImage(imageId));
          const rawData =
            image?.voxelManager?.getScalarData?.() ?? image?.getPixelData?.();
          if (!rawData) continue;
          imgWidth = image.columns ?? image.width ?? imgWidth;
          imgHeight = image.rows ?? image.height ?? imgHeight;
          // .slice() produces an independent typed-array copy of the same type
          imageFrames.push(rawData.slice() as Int16Array);
        }

        if (imageFrames.length && imgWidth && imgHeight) {
          const nifti = buildNiftiBuffer({
            frames: imageFrames,
            width: imgWidth,
            height: imgHeight,
            spacing,
            frameTimeMs,
          });
          const gz = await gzipBuffer(nifti);
          files.push({ name: 'image.nii.gz', data: gz });
        }
      }

      // --- label.nii.gz (always included) ---
      const labelFrames = await readActiveSegmentationFrames({
        servicesManager,
        viewportId: activeViewportId,
      });

      if (labelFrames.length) {
        const labelNiftiFrames = labelFrames.map(f => new Uint8Array(f.scalarData));
        const lw = labelFrames[0].width;
        const lh = labelFrames[0].height;
        const nifti = buildNiftiBuffer({
          frames: labelNiftiFrames,
          width: lw,
          height: lh,
          spacing,
          frameTimeMs,
        });
        const gz = await gzipBuffer(nifti);
        files.push({ name: 'label.nii.gz', data: gz });
      }

      if (!files.length) {
        uiNotificationService?.show?.({
          title: 'Export',
          message: 'Nothing to export — check that a segmentation exists.',
          type: 'warning',
          duration: 3000,
        });
        return;
      }

      const zip = buildZipBuffer(files);
      downloadBlob(
        new Blob([zip], { type: 'application/zip' }),
        'segmentation_export.zip'
      );

      uiNotificationService?.show?.({
        title: 'Export Complete',
        message: `Downloaded: ${files.map(f => f.name).join(', ')}`,
        type: 'success',
        duration: 3000,
      });
    } catch (err) {
      console.error('[SegmentationExport] Export failed:', err);
      uiNotificationService?.show?.({
        title: 'Export Failed',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
        type: 'error',
        duration: 5000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Output format */}
      <div className="flex flex-col gap-1.5 pl-1">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="nifti-output"
            value="label"
            checked={outputMode === 'label'}
            onChange={() => setOutputMode('label')}
            className="h-3 w-3 border-gray-600 accent-blue-500"
          />
          <span className="text-[11px] text-gray-300">label.nii.gz</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="nifti-output"
            value="both"
            checked={outputMode === 'both'}
            onChange={() => setOutputMode('both')}
            className="h-3 w-3 border-gray-600 accent-blue-500"
          />
          <span className="text-[11px] text-gray-300">image.nii.gz + label.nii.gz</span>
        </label>
      </div>

      {/* Export button */}
      <button
        type="button"
        onClick={handleExport}
        disabled={!canExport}
        className={`flex items-center justify-center gap-2 rounded px-3 py-1.5 text-xs transition-colors ${
          canExport
            ? 'bg-blue-600 text-white hover:bg-blue-700'
            : 'cursor-not-allowed bg-gray-700 text-gray-500'
        }`}
        title={!hasSegmentation ? 'No active segmentation' : 'Export as ZIP'}
      >
        {isExporting ? (
          <>
            <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span>Exporting...</span>
          </>
        ) : (
          <>
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            <span>Export</span>
          </>
        )}
      </button>
    </div>
  );
};

export default SegmentationExportControls;
