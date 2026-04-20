import React, { useEffect, useCallback, useState, useRef } from 'react';
import { eventTarget, cache, imageLoader, metaData } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';
import {
  SegmentationModelSelector,
  SegmentationLabelsList,
} from '../components/segmentation';
import {
  buildNiftiBuffer,
  buildZipBuffer,
  gzipBuffer,
  downloadBlob,
} from '../utils/roiExport';
import { readActiveSegmentationFrames } from '../utils/oviSegmentation';
import { extractFrameTimingFromImageIds } from '../utils/dicomMetadataExtractor';
import { DicomMetadataStore } from '@ohif/core';
import {
  syncLabelsFromAnnotations,
  getSegmentationState,
  subscribeSegmentationState,
} from '../utils/segmentationStore';
import {
  cacheSegmentationFrame,
  getCachedSegmentationFrame,
  hydrateSegmentationCache,
} from '../utils/segmentationManager';
import segmentationApi from '../services/segmentationApi';
import { getModelParams } from '../utils/segmentationParamsStore';
import { isPointInPolygon } from '../utils/rasterizeContour';
import {
  ensureOviSegmentationForViewport,
  OVI_SEGMENTATION_LABELS,
  syncDerivedContoursFromSegmentation,
  writeMaskToActiveSegmentation,
} from '../utils/oviSegmentation';

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
}) => {
  const [roiAnnotation, setRoiAnnotation] = useState<any>(null);
  const [revision, setRevision] = useState(0);
  const [currentImageId, setCurrentImageId] = useState<string | undefined>(undefined);
  const [activeModel, setActiveModelState] = useState(getSegmentationState().activeModel);
  const [isRecomputing, setIsRecomputing] = useState(false);
  const [recomputeStatusText, setRecomputeStatusText] = useState<string | undefined>(undefined);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
    const studyInstanceUID = instance?.StudyInstanceUID;
    if (!seriesInstanceUID || !studyInstanceUID || hydratedSeriesRef.current.has(seriesInstanceUID)) {
      return;
    }

    void hydrateSegmentationCache(seriesInstanceUID, studyInstanceUID).then(() => {
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
  const handleExportNifti = useCallback(async (mode: 'label' | 'both') => {
    if (!activeViewportId || !servicesManager) return;

    const uiNotificationService = servicesManager?.services?.uiNotificationService;
    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;

    try {
      const viewport = cornerstoneViewportService?.getCornerstoneViewport(activeViewportId);
      const imageIds: string[] = viewport?.getImageIds?.() ?? [];

      if (!imageIds.length) {
        uiNotificationService?.show?.({ title: 'Export', message: 'No images found in viewport.', type: 'error', duration: 3000 });
        return;
      }

      const imagePlane = metaData.get('imagePlaneModule', imageIds[0]) ?? {};
      const spacing = {
        row: (imagePlane.rowPixelSpacing ?? imagePlane.columnPixelSpacing ?? 1) as number,
        column: (imagePlane.columnPixelSpacing ?? imagePlane.rowPixelSpacing ?? 1) as number,
      };
      const { frameTimeMs } = extractFrameTimingFromImageIds(imageIds);
      const files: { name: string; data: ArrayBuffer }[] = [];

      if (mode === 'both') {
        const imageFrames: Array<Int16Array | Uint16Array | Uint8Array | Float32Array> = [];
        let imgWidth = 0;
        let imgHeight = 0;
        for (const imageId of imageIds) {
          const image = cache.getImage(imageId) ?? (await imageLoader.loadAndCacheImage(imageId));
          const rawData = image?.voxelManager?.getScalarData?.() ?? image?.getPixelData?.();
          if (!rawData) continue;
          imgWidth = image.columns ?? image.width ?? imgWidth;
          imgHeight = image.rows ?? image.height ?? imgHeight;
          imageFrames.push(rawData.slice() as Int16Array);
        }
        if (imageFrames.length && imgWidth && imgHeight) {
          const nifti = buildNiftiBuffer({ frames: imageFrames, width: imgWidth, height: imgHeight, spacing, frameTimeMs });
          files.push({ name: 'image.nii.gz', data: await gzipBuffer(nifti) });
        }
      }

      const labelFrames = await readActiveSegmentationFrames({ servicesManager, viewportId: activeViewportId });
      if (labelFrames.length) {
        const nifti = buildNiftiBuffer({
          frames: labelFrames.map(f => new Uint8Array(f.scalarData)),
          width: labelFrames[0].width,
          height: labelFrames[0].height,
          spacing,
          frameTimeMs,
        });
        files.push({ name: 'label.nii.gz', data: await gzipBuffer(nifti) });
      }

      if (!files.length) {
        uiNotificationService?.show?.({ title: 'Export', message: 'Nothing to export — check that a segmentation exists.', type: 'warning', duration: 3000 });
        return;
      }

      downloadBlob(new Blob([buildZipBuffer(files)], { type: 'application/zip' }), 'segmentation_export.zip');
      uiNotificationService?.show?.({ title: 'Export Complete', message: `Downloaded: ${files.map(f => f.name).join(', ')}`, type: 'success', duration: 3000 });
    } catch (err) {
      console.error('[SegmentationExport] Export failed:', err);
      uiNotificationService?.show?.({ title: 'Export Failed', message: err instanceof Error ? err.message : 'Unknown error', type: 'error', duration: 5000 });
    }
  }, [activeViewportId, servicesManager]);

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

        const labelMap: Record<number, { labelId: string; labelName: string; labelColor: string }> =
          {};
        result.result.labels.forEach(label => {
          labelMap[label.id] = {
            labelId: mapBackendLabelId(label),
            labelName: label.name,
            labelColor: label.color,
          };
        });

        if (selectedModel === 'manual') {
          throw new Error('Manual model cannot be recomputed.');
        }

        await ensureOviSegmentationForViewport(servicesManager, activeViewportId);

        const canonicalMask = new Uint8Array(labels.length);
        result.result.labels.forEach(label => {
          const mappedLabelId = mapBackendLabelId(label);
          const segmentIndex =
            OVI_SEGMENTATION_LABELS.find(item => item.id === mappedLabelId)?.segmentIndex ??
            label.id;

          for (let i = 0; i < labels.length; i += 1) {
            if (labels[i] === label.id) {
              canonicalMask[i] = segmentIndex;
            }
          }

          labelMap[segmentIndex] = {
            labelId: mappedLabelId,
            labelName: label.name,
            labelColor: label.color,
          };
        });

        const frameSegmentation = await writeMaskToActiveSegmentation({
          servicesManager,
          viewportId: activeViewportId,
          referencedImageId: target.imageId,
          maskData: canonicalMask,
        });

        if (!frameSegmentation) {
          throw new Error('Unable to write segmentation result into the OVI Labs labelmap.');
        }

        await syncDerivedContoursFromSegmentation({
          servicesManager,
          viewportId: activeViewportId,
          referencedImageId: target.imageId,
          modelType: selectedModel,
        });

        const instance = DicomMetadataStore.getInstanceByImageId(target.imageId);
        const seriesInstanceUID = instance?.SeriesInstanceUID;
        const studyInstanceUID = instance?.StudyInstanceUID;
        if (seriesInstanceUID && studyInstanceUID) {
          void cacheSegmentationFrame({
            seriesInstanceUID,
            studyInstanceUID,
            model: selectedModel,
            frameKey: target.imageId,
            frameNumber: target.frameIndex + 1,
            width: frameData.width,
            height: frameData.height,
            maskData: canonicalMask,
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
  }, [activeViewportId, servicesManager, currentImageId]);

  useEffect(() => {
    if (activeModel !== 'otsu' || !currentImageId || !servicesManager || !activeViewportId) {
      return;
    }

    const instance = DicomMetadataStore.getInstanceByImageId(currentImageId);
    const seriesInstanceUID = instance?.SeriesInstanceUID;
    if (!seriesInstanceUID) return;

    const cached = getCachedSegmentationFrame(seriesInstanceUID, 'otsu', currentImageId);
    if (!cached) return;

    void writeMaskToActiveSegmentation({
      servicesManager,
      viewportId: activeViewportId,
      referencedImageId: currentImageId,
      maskData: cached.maskData,
    }).then(async frame => {
      if (!frame) {
        return;
      }

      await syncDerivedContoursFromSegmentation({
        servicesManager,
        viewportId: activeViewportId,
        referencedImageId: currentImageId,
        modelType: 'otsu',
      });
    });
  }, [activeModel, currentImageId, servicesManager, activeViewportId]);

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

        {/* Advanced Section */}
        <div className="flex flex-col">
          <button
            type="button"
            className="flex w-full items-center justify-between py-1 text-[10px] font-medium uppercase tracking-wide text-gray-500 hover:text-gray-300"
            onClick={() => setAdvancedOpen(o => !o)}
          >
            <span>Advanced</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-3 w-3 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
            >
              <path
                fillRule="evenodd"
                d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-4 pt-2">
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
                  onExportNifti={handleExportNifti}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SegmentationPanel;
