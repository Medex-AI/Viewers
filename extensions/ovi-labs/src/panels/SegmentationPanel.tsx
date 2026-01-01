import React, { useEffect, useCallback, useState, useRef } from 'react';
import { eventTarget } from '@cornerstonejs/core';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { useViewportGrid } from '@ohif/ui-next';
import {
  SegmentationModelSelector,
  SegmentationLabelsList,
  SegmentationExportControls,
} from '../components/segmentation';
import { DicomMetadataStore } from '@ohif/core';
import { syncLabelsFromAnnotations } from '../utils/segmentationStore';

interface SegmentationPanelProps {
  commandsManager?: any;
  servicesManager?: any;
  extensionManager?: any;
}

const MANUAL_CONTOUR_TOOL_NAME = 'ManualContour';
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
  const [{ activeViewportId }] = useViewportGrid();

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

  const handleRecompute = useCallback(() => {
    // Stub for backend integration
    console.log('Recompute segmentation requested');
  }, []);

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
            onRecompute={handleRecompute}
          />
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
