import React, { useCallback, useEffect, useMemo, useState } from 'react';
import SegmentationPersistenceHud from '../../../../extensions/cornerstone/src/utils/SegmentationPersistenceHud';
import { annotation, Enums as toolEnums } from '@cornerstonejs/tools';
import { getRenderingEngines, utilities as csUtils, metaData, cache } from '@cornerstonejs/core';
import {
  DropdownMenuItem,
  SegmentCard,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useViewportGrid,
} from '@ohif/ui-next';
import { DicomMetadataStore } from '@ohif/core';
import { CVI_LABELS, getCviLabsState, setCviLabelVisibility, subscribeCviLabs } from '../stores/cviLabsSegmentationStore';
import {
  activateCviCompatibleSegmentation,
  ensureCviSegmentationForViewport,
  getCviRuntimeSegmentColorById,
  listCompatibleCviSegmentations,
} from '../utils/cviSegmentation';

interface CviSegmentationPanelProps {
  servicesManager?: any;
}

type SegmentationOption = {
  segmentationId: string;
  label: string;
};

type NavGroup = { key: string; label: string; onStep?: (delta: number) => void; prevTitle?: string; nextTitle?: string };

type DisplayCard = {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  opacity: number;
  frameInfo?: string;
  navigationGroups?: NavGroup[];
  segmentIndex?: number;
  isMask?: boolean;
};

const DEFAULT_LABEL_OPACITY = 0.2;
const MASK_CARD = {
  id: 'mask',
  name: 'Mask',
  color: '#94A3B8',
} as const;
const CVI_ACTIVE_LABEL_EVENT = 'cvi-set-active-label';

const readTriggerTimeMs = (imageId?: string) => {
  if (!imageId) {
    return null;
  }

  // Use Cornerstone's own metadata provider first (works for both stack and volume viewports),
  // then fall back to OHIF's DicomMetadataStore for data loaded via OHIF's metadata service.
  const instance = metaData.get('instance', imageId) || DicomMetadataStore.getInstanceByImageId(imageId) || {};
  const value = instance.x00181060 ?? instance.TriggerTime ?? instance.triggerTime;
  const normalized = Array.isArray(value) ? value[0] : value;
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const CviSegmentationPanel: React.FC<CviSegmentationPanelProps> = ({ servicesManager }) => {
  const [{ activeViewportId }] = useViewportGrid();
  const { displaySetService, viewportGridService } = servicesManager?.services || {};
  const [activeSegmentationId, setActiveSegmentationId] = useState('');
  const [segmentationOptions, setSegmentationOptions] = useState<SegmentationOption[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [labelVisibility, setLabelVisibility] = useState(getCviLabsState().labelVisibility);
  const [frameData, setFrameData] = useState(getCviLabsState().frameData);
  const [opacityOverrides, setOpacityOverrides] = useState<Record<string, number>>({});
  const [maskRevision, setMaskRevision] = useState(0);
  const [activeLabelId, setActiveLabelId] = useState<string>('');

  const syncOptionsFromState = useCallback(() => {
    if (!servicesManager || !activeViewportId) {
      return;
    }

    const options = listCompatibleCviSegmentations(servicesManager, activeViewportId).map(option => ({
      segmentationId: option.segmentationId,
      label: option.label || 'Cvi Lab',
    }));
    const activeSegmentation = servicesManager.services?.segmentationService?.getActiveSegmentation?.(
      activeViewportId
    );

    setSegmentationOptions(options);
    setActiveSegmentationId(activeSegmentation?.segmentationId || activeSegmentation?.id || '');
  }, [activeViewportId, servicesManager]);

  const ensureAndSyncOptions = useCallback(async () => {
    if (!servicesManager || !activeViewportId) {
      return;
    }

    await ensureCviSegmentationForViewport(servicesManager, activeViewportId);
    syncOptionsFromState();
  }, [activeViewportId, servicesManager, syncOptionsFromState]);

  useEffect(() => {
    void ensureAndSyncOptions();
  }, [ensureAndSyncOptions]);

  useEffect(() => {
    return subscribeCviLabs(state => {
      setLabelVisibility(state.labelVisibility);
      setFrameData(state.frameData);
    });
  }, []);

  useEffect(() => {
    const handler = (evt: Event) => {
      const labelId = (evt as CustomEvent)?.detail?.labelId;
      if (labelId) {
        setActiveLabelId(labelId);
      }
    };
    window.addEventListener(CVI_ACTIVE_LABEL_EVENT, handler);
    return () => window.removeEventListener(CVI_ACTIVE_LABEL_EVENT, handler);
  }, []);

  useEffect(() => {
    const segmentationService = servicesManager?.services?.segmentationService;
    if (!segmentationService?.subscribe) {
      return;
    }

    const events = [
      segmentationService.EVENTS?.SEGMENTATION_ADDED,
      segmentationService.EVENTS?.SEGMENTATION_MODIFIED,
      segmentationService.EVENTS?.SEGMENTATION_REMOVED,
      segmentationService.EVENTS?.ACTIVE_SEGMENTATION_CHANGED,
    ].filter(Boolean);
    const subscriptions = events.map(event =>
      segmentationService.subscribe(event, syncOptionsFromState)
    );

    return () => subscriptions.forEach(subscription => subscription.unsubscribe());
  }, [servicesManager, syncOptionsFromState]);

  const getCurrentImageId = useCallback(() => {
    if (!servicesManager || !activeViewportId) {
      return undefined;
    }

    const cornerstoneViewportService = servicesManager.services?.cornerstoneViewportService;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    if (!viewport) {
      return undefined;
    }

    try {
      const currentImageIdIndex = viewport.getCurrentImageIdIndex?.();
      const imageIds = viewport.getImageIds?.();
      if (imageIds && currentImageIdIndex !== undefined) {
        return imageIds[currentImageIdIndex];
      }
    } catch {
      return viewport.getCurrentImageId?.();
    }

    return viewport.getCurrentImageId?.();
  }, [activeViewportId, servicesManager]);

  const currentImageId = getCurrentImageId();

  // Canonical readViewportNavigation — identical pattern to SegmentCardsList.tsx:123–176.
  // Returns slice/time navigation state from the active viewport's dynamic volume info (if present).
  const readViewportNavigation = useCallback(() => {
    const { cornerstoneViewportService } = servicesManager?.services || {};
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    const imageIds = viewport?.getImageIds?.();
    const currentIndex = viewport?.getCurrentImageIdIndex?.();
    const numberOfSlices = viewport?.getNumberOfSlices?.();
    const safeCurrentIndex = typeof currentIndex === 'number' ? currentIndex : 0;
    const currentViewportImageId = imageIds?.[safeCurrentIndex];
    const baseState = {
      currentSlice: safeCurrentIndex + 1,
      totalSlices:
        typeof numberOfSlices === 'number' && numberOfSlices > 0 ? numberOfSlices : imageIds?.length || 1,
    };

    const { viewports } = viewportGridService?.getState?.() || { viewports: new Map() };
    const displaySetInstanceUIDs = viewports.get(activeViewportId)?.displaySetInstanceUIDs || [];

    for (const displaySetInstanceUID of displaySetInstanceUIDs) {
      const displaySet = displaySetService?.getDisplaySetByUID?.(displaySetInstanceUID);
      if (!displaySet?.isDynamicVolume) {
        continue;
      }

      const { dynamicVolumeInfo } = displaySet;
      const timePoints = dynamicVolumeInfo?.timePoints || [];
      const volume = cache.getVolume(displaySet.displaySetInstanceUID, true) as
        | { dimensionGroupNumber?: number }
        | undefined;
      const currentTime =
        volume?.dimensionGroupNumber || dynamicVolumeInfo?.dimensionGroupNumber || 1;
      const totalTimes = timePoints.length || 1;
      const currentTimePointImageIds = timePoints[currentTime - 1] || [];
      const totalSlices =
        (typeof numberOfSlices === 'number' && numberOfSlices > 0
          ? numberOfSlices
          : currentTimePointImageIds.length) || baseState.totalSlices;
      const currentSliceIndex = currentViewportImageId
        ? currentTimePointImageIds.indexOf(currentViewportImageId)
        : -1;

      return {
        currentSlice:
          currentSliceIndex >= 0
            ? currentSliceIndex + 1
            : Math.min(((safeCurrentIndex % totalSlices) || 0) + 1, totalSlices),
        totalSlices,
        currentTime,
        totalTimes,
        volumeId: displaySet.displaySetInstanceUID,
      };
    }

    return baseState as { currentSlice: number; totalSlices: number; currentTime?: number; totalTimes?: number; volumeId?: string };
  }, [activeViewportId, displaySetService, servicesManager, viewportGridService]);

  const totalFrameCount = useMemo(() => {
    if (!servicesManager || !activeViewportId) {
      return 0;
    }

    const viewport = servicesManager.services?.cornerstoneViewportService?.getCornerstoneViewport?.(
      activeViewportId
    );
    return viewport?.getImageIds?.()?.length || 0;
  }, [activeViewportId, servicesManager, currentImageId]);

  const totalTimePoints = useMemo(() => {
    // Prefer dynamic volume time points from the viewport; fall back to flat frame count for ACDC studies.
    const navigation = readViewportNavigation();
    if (navigation.totalTimes !== undefined && navigation.totalTimes > 1) {
      return navigation.totalTimes;
    }
    return totalFrameCount;
  }, [readViewportNavigation, totalFrameCount]);

  const framesPerTimePoint = useMemo(() => {
    if (totalTimePoints > 1 && totalFrameCount > totalTimePoints) {
      const ratio = totalFrameCount / totalTimePoints;
      if (Number.isInteger(ratio)) return ratio;
    }
    return 1;
  }, [totalFrameCount, totalTimePoints]);

  const currentFrameIndex = useMemo(() => {
    const viewport = servicesManager?.services?.cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);

    try {
      const currentImageIdIndex = viewport?.getCurrentImageIdIndex?.();
      return typeof currentImageIdIndex === 'number' ? currentImageIdIndex : 0;
    } catch {
      return 0;
    }
  }, [activeViewportId, servicesManager, currentImageId]);

  const currentTimeIndex = useMemo(
    () => (framesPerTimePoint > 1 ? Math.floor(currentFrameIndex / framesPerTimePoint) : 0),
    [currentFrameIndex, framesPerTimePoint]
  );

  const annotatedSlicesAtCurrentTime = useMemo(() => {
    const lv = new Set<number>(), myo = new Set<number>(), rv = new Set<number>();
    for (const [frameIndex, fd] of frameData.entries()) {
      if (framesPerTimePoint > 1 && Math.floor(frameIndex / framesPerTimePoint) !== currentTimeIndex) continue;
      const s = frameIndex % framesPerTimePoint;
      if (fd.lvAreaMm2 > 0) lv.add(s);
      if (fd.myoMask !== null) myo.add(s);
      if (fd.rvAreaMm2 > 0) rv.add(s);
    }
    return { lv_cavity: lv.size, myocardium: myo.size, rv_cavity: rv.size } as Record<string, number>;
  }, [frameData, framesPerTimePoint, currentTimeIndex]);

  const stepViewportFrame = useCallback(
    (delta: number) => {
      if (!servicesManager || !activeViewportId || !delta) {
        return;
      }

      const viewport = servicesManager.services?.cornerstoneViewportService?.getCornerstoneViewport?.(
        activeViewportId
      );
      const imageIds = viewport?.getImageIds?.();
      let currentIndex: number | undefined;

      try {
        currentIndex = viewport?.getCurrentImageIdIndex?.();
      } catch {
        currentIndex = undefined;
      }

      if (!viewport?.element || !Array.isArray(imageIds) || !imageIds.length) {
        return;
      }

      const safeCurrentIndex = typeof currentIndex === 'number' ? currentIndex : 0;
      const nextIndex = Math.max(0, Math.min(imageIds.length - 1, safeCurrentIndex + delta));

      if (nextIndex === safeCurrentIndex) {
        return;
      }

      csUtils.jumpToSlice(viewport.element, {
        imageIndex: nextIndex,
        debounceLoading: true,
      });
      viewport.render?.();
    },
    [activeViewportId, servicesManager]
  );

  const stepViewportTime = useCallback(
    (delta: number) => {
      if (!servicesManager || !activeViewportId || !delta) {
        return;
      }

      const navigation = readViewportNavigation();

      // Primary path: Cornerstone dynamic volume with dimensionGroupNumber (volume viewport).
      if (navigation.volumeId && navigation.totalTimes) {
        const nextTime = Math.max(
          1,
          Math.min(navigation.totalTimes, (navigation.currentTime || 1) + delta)
        );

        if (nextTime === navigation.currentTime) {
          return;
        }

        const volume = cache.getVolume(navigation.volumeId, true) as
          | { dimensionGroupNumber?: number }
          | undefined;

        if (!volume) {
          return;
        }

        volume.dimensionGroupNumber = nextTime;
        const ds = displaySetService?.getDisplaySetByUID?.(navigation.volumeId);
        if (ds?.dynamicVolumeInfo) {
          ds.dynamicVolumeInfo.dimensionGroupNumber = nextTime;
        }
        servicesManager.services.cornerstoneViewportService
          ?.getCornerstoneViewport?.(activeViewportId)
          ?.render?.();
        return;
      }

      // Fallback path (ACDC stack viewport): use TriggerTime tag grouping.
      const viewport = servicesManager.services?.cornerstoneViewportService?.getCornerstoneViewport?.(
        activeViewportId
      );
      const imageIds = viewport?.getImageIds?.() ?? [];

      if (!viewport?.element || imageIds.length <= 1) {
        return;
      }

      let currentIndex: number | undefined;
      try {
        currentIndex = viewport?.getCurrentImageIdIndex?.();
      } catch {
        currentIndex = undefined;
      }

      const safeCurrentIndex = typeof currentIndex === 'number' ? currentIndex : 0;
      const triggerTimes = imageIds.map(readTriggerTimeMs);
      const currentTriggerTime = triggerTimes[safeCurrentIndex];

      if (currentTriggerTime === null) {
        stepViewportFrame(delta * framesPerTimePoint);
        return;
      }

      const phaseStarts = (triggerTimes as Array<number | null>).reduce((acc: Array<{ triggerTime: number; startIndex: number }>, triggerTime, index) => {
        if (triggerTime === null) {
          return acc;
        }
        if (!acc.some(item => item.triggerTime === triggerTime)) {
          acc.push({ triggerTime, startIndex: index });
        }
        return acc;
      }, []);

      if (phaseStarts.length <= 1) {
        stepViewportFrame(delta * framesPerTimePoint);
        return;
      }

      const currentPhaseIndex = phaseStarts.findIndex(item => item.triggerTime === currentTriggerTime);
      if (currentPhaseIndex < 0) {
        return;
      }

      const nextPhaseIndex = Math.max(0, Math.min(phaseStarts.length - 1, currentPhaseIndex + delta));
      if (nextPhaseIndex === currentPhaseIndex) {
        return;
      }

      const sliceOffset = safeCurrentIndex - phaseStarts[currentPhaseIndex].startIndex;
      const nextStartIndex = phaseStarts[nextPhaseIndex].startIndex;
      const nextPhaseEndIndex =
        nextPhaseIndex + 1 < phaseStarts.length ? phaseStarts[nextPhaseIndex + 1].startIndex : imageIds.length;
      const nextIndex = Math.min(nextPhaseEndIndex - 1, nextStartIndex + Math.max(0, sliceOffset));

      csUtils.jumpToSlice(viewport.element, {
        imageIndex: nextIndex,
        debounceLoading: true,
      });
      viewport.render?.();
    },
    [activeViewportId, displaySetService, framesPerTimePoint, readViewportNavigation, servicesManager, stepViewportFrame]
  );

  const activeSeriesInstanceUID = useMemo(() => {
    if (!currentImageId) {
      return undefined;
    }

    return DicomMetadataStore.getInstanceByImageId(currentImageId)?.SeriesInstanceUID;
  }, [currentImageId]);

  const maskCard = useMemo<DisplayCard>(() => {
    const annotationManager = annotation.state.getAnnotationManager();
    if (!annotationManager) {
      return {
        ...MASK_CARD,
        visible: false,
        opacity: DEFAULT_LABEL_OPACITY,
        frameInfo: `Masked Frame 0/${totalFrameCount || 0}`,
        isMask: true,
      };
    }

    const frames = annotationManager.getFramesOfReference() || [];
    const maskAnnotations = frames.flatMap(frame =>
      (annotationManager.getAnnotations(frame, 'MaskContour') || []).filter(contour => {
        if (!activeSeriesInstanceUID) {
          return true;
        }

        const contourSeriesUID =
          contour?.data?.seriesInstanceUID ||
          DicomMetadataStore.getInstanceByImageId(contour?.metadata?.referencedImageId || '')
            ?.SeriesInstanceUID;

        return contourSeriesUID === activeSeriesInstanceUID;
      })
    );

    const firstAnnotation = maskAnnotations[0];
    const isVisible =
      maskAnnotations.length > 0
        ? maskAnnotations.some(contour => contour?.isVisible !== false)
        : false;
    const opacity = firstAnnotation?.data?.fillOpacity ?? DEFAULT_LABEL_OPACITY;

    return {
      ...MASK_CARD,
      visible: isVisible,
      opacity: opacityOverrides[MASK_CARD.id] ?? opacity,
      frameInfo: `Masked Frame ${maskAnnotations.length}/${totalFrameCount || 0}`,
      isMask: true,
    };
  }, [activeSeriesInstanceUID, opacityOverrides, totalFrameCount, maskRevision]);

  const annotatedTimeCounts = useMemo(() => {
    const lvTimes = new Set<number>();
    const myoTimes = new Set<number>();
    const rvTimes = new Set<number>();
    for (const [frameIndex, fd] of frameData.entries()) {
      const t = framesPerTimePoint > 1 ? Math.floor(frameIndex / framesPerTimePoint) : frameIndex;
      if (fd.lvAreaMm2 > 0) lvTimes.add(t);
      if (fd.myoMask !== null) myoTimes.add(t);
      if (fd.rvAreaMm2 > 0) rvTimes.add(t);
    }
    return { lv_cavity: lvTimes.size, myocardium: myoTimes.size, rv_cavity: rvTimes.size } as Record<string, number>;
  }, [frameData, framesPerTimePoint]);

  const labelCards = useMemo<DisplayCard[]>(() => {
    return CVI_LABELS.map(label => ({
      id: label.id,
      name: label.name,
      color:
        (activeViewportId
          ? getCviRuntimeSegmentColorById(servicesManager, activeViewportId, label.id)
          : undefined) || label.color,
      visible: labelVisibility[label.id] ?? true,
      opacity: opacityOverrides[label.id] ?? DEFAULT_LABEL_OPACITY,
      navigationGroups: [
        {
          key: 'slices',
          label: `Annotated Slice ${annotatedSlicesAtCurrentTime[label.id] ?? 0}/${framesPerTimePoint}`,
          onStep: stepViewportFrame,
          prevTitle: 'Previous slice',
          nextTitle: 'Next slice',
        },
        ...(totalTimePoints > 1 ? [{
          key: 'time',
          label: `Annotated Frame ${annotatedTimeCounts[label.id] ?? 0}/${totalTimePoints}`,
          onStep: stepViewportTime,
          prevTitle: 'Previous frame',
          nextTitle: 'Next frame',
        }] : []),
      ] as NavGroup[],
      segmentIndex: label.segmentIndex,
    }));
  }, [activeViewportId, annotatedSlicesAtCurrentTime, annotatedTimeCounts, framesPerTimePoint, labelVisibility, opacityOverrides, servicesManager, stepViewportFrame, stepViewportTime, totalTimePoints]);

  const toggleSegmentVisibility = useCallback(
    (labelId: (typeof CVI_LABELS)[number]['id']) => {
      const nextVisible = !(labelVisibility[labelId] ?? true);
      setCviLabelVisibility(labelId, nextVisible);

      const label = CVI_LABELS.find(item => item.id === labelId);
      const segmentationService = servicesManager?.services?.segmentationService;
      const activeSegmentation = segmentationService?.getActiveSegmentation?.(activeViewportId);
      const segmentationId = activeSegmentation?.segmentationId || activeSegmentation?.id;

      if (label && segmentationService && segmentationId && activeViewportId) {
        segmentationService.setSegmentVisibility?.(
          activeViewportId,
          segmentationId,
          label.segmentIndex,
          nextVisible
        );
      }
    },
    [activeViewportId, labelVisibility, servicesManager]
  );

  const handleLabelSelect = useCallback(
    async (labelId: string) => {
      if (!labelId || !servicesManager || !activeViewportId) {
        return;
      }

      const label = CVI_LABELS.find(item => item.id === labelId);
      const segmentationService = servicesManager.services?.segmentationService;
      const activeSegmentation = segmentationService?.getActiveSegmentation?.(activeViewportId);
      const segmentationId = activeSegmentation?.segmentationId || activeSegmentation?.id;

      setActiveLabelId(labelId);
      window?.dispatchEvent?.(
        new CustomEvent(CVI_ACTIVE_LABEL_EVENT, {
          detail: {
            labelId,
            sourceToolName: 'ManualContour',
          },
        })
      );

      if (label && segmentationService && segmentationId) {
        segmentationService.setActiveSegmentation(activeViewportId, segmentationId);
        segmentationService.setActiveSegment(segmentationId, label.segmentIndex);
      }
    },
    [activeViewportId, servicesManager]
  );

  const setSegmentOpacity = useCallback(
    (labelId: string, opacity: number) => {
      const nextOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : DEFAULT_LABEL_OPACITY));
      setOpacityOverrides(prev => ({
        ...prev,
        [labelId]: nextOpacity,
      }));

      const label = CVI_LABELS.find(item => item.id === labelId);
      const segmentationService = servicesManager?.services?.segmentationService;
      const activeSegmentation = segmentationService?.getActiveSegmentation?.(activeViewportId);
      const segmentationId = activeSegmentation?.segmentationId || activeSegmentation?.id;

      if (label && segmentationService && segmentationId && activeViewportId) {
        const rgbaColor = segmentationService.getSegmentColor(
          activeViewportId,
          segmentationId,
          label.segmentIndex
        );

        segmentationService.setSegmentColor(
          activeViewportId,
          segmentationId,
          label.segmentIndex,
          rgbaColor
        );

        segmentationService.setStyle(
          {
            viewportId: activeViewportId,
            segmentationId,
            type: toolEnums.SegmentationRepresentations.Labelmap,
            segmentIndex: label.segmentIndex,
          },
          {
            fillAlpha: nextOpacity,
            fillAlphaInactive: nextOpacity,
            renderFill: nextOpacity > 0,
          }
        );
      }
    },
    [activeViewportId, servicesManager]
  );

  const handleMaskVisibilityChange = useCallback(
    (visible: boolean) => {
      const annotationManager = annotation.state.getAnnotationManager();
      const frames = annotationManager?.getFramesOfReference?.() || [];
      const maskAnnotations = frames.flatMap(frame => annotationManager.getAnnotations(frame, 'MaskContour') || []);

      maskAnnotations.forEach(annotationObj => {
        annotationObj.isVisible = visible;
        if (annotationObj.data) {
          annotationObj.data.fillOpacity = visible ? maskCard.opacity : 0;
          annotationObj.data.renderFill = visible && maskCard.opacity > 0;
        }

        annotation.config.style.setAnnotationStyles(annotationObj.annotationUID, {
          color: visible ? MASK_CARD.color : 'transparent',
          colorHighlighted: visible ? MASK_CARD.color : 'transparent',
          colorSelected: visible ? MASK_CARD.color : 'transparent',
          fillColor: MASK_CARD.color,
          fillOpacity: visible ? maskCard.opacity : 0,
          renderFill: visible && maskCard.opacity > 0,
          lineDash: [6, 4],
          lineDashSelected: [6, 4],
        });
      });

      getRenderingEngines().forEach(engine => {
        engine.renderViewports(engine.getViewports().map(vp => vp.id));
      });
      setMaskRevision(value => value + 1);
    },
    [maskCard.opacity]
  );

  const handleMaskOpacityChange = useCallback(
    (opacity: number) => {
      const nextOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : DEFAULT_LABEL_OPACITY));
      setOpacityOverrides(prev => ({
        ...prev,
        [MASK_CARD.id]: nextOpacity,
      }));

      const annotationManager = annotation.state.getAnnotationManager();
      const frames = annotationManager?.getFramesOfReference?.() || [];
      const maskAnnotations = frames.flatMap(frame => annotationManager.getAnnotations(frame, 'MaskContour') || []);

      maskAnnotations.forEach(annotationObj => {
        if (annotationObj.data) {
          annotationObj.data.fillOpacity = nextOpacity;
          annotationObj.data.renderFill = maskCard.visible && nextOpacity > 0;
        }

        annotation.config.style.setAnnotationStyles(annotationObj.annotationUID, {
          color: maskCard.visible ? MASK_CARD.color : 'transparent',
          colorHighlighted: maskCard.visible ? MASK_CARD.color : 'transparent',
          colorSelected: maskCard.visible ? MASK_CARD.color : 'transparent',
          fillColor: MASK_CARD.color,
          fillOpacity: maskCard.visible ? nextOpacity : 0,
          renderFill: maskCard.visible && nextOpacity > 0,
          lineDash: [6, 4],
          lineDashSelected: [6, 4],
        });
      });

      getRenderingEngines().forEach(engine => {
        engine.renderViewports(engine.getViewports().map(vp => vp.id));
      });
      setMaskRevision(value => value + 1);
    },
    [maskCard.visible]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-black text-white">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <h3 className="text-sm font-medium">Segmentation</h3>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        {segmentationOptions.length ? (
          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Active Segmentation
            </label>
            <Select
              value={activeSegmentationId}
              onValueChange={segmentationId => {
                setActiveSegmentationId(segmentationId);
                void activateCviCompatibleSegmentation({
                  servicesManager,
                  viewportId: activeViewportId,
                  segmentationId,
                });
              }}
            >
              <SelectTrigger
                aria-label="Cvi active segmentation"
                className="h-8 w-full border-gray-700 bg-gray-900 text-xs text-white"
              >
                <SelectValue placeholder="Select segmentation" />
              </SelectTrigger>
              <SelectContent>
                {segmentationOptions.map(option => (
                  <SelectItem key={option.segmentationId} value={option.segmentationId}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="flex flex-1 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Labels
            </label>
            {labelCards.map(card => (
              <div key={card.id} data-testid={`cvi-segmentation-row-${card.id}`} data-cy={`cvi-segmentation-row-${card.id}`}>
                <SegmentCard
                  label={card.name}
                  colorHex={card.color}
                  visible={card.visible}
                  active={card.id === activeLabelId}
                  opacity={card.opacity}
                  navigationGroups={card.navigationGroups}
                  onSelect={() => void handleLabelSelect(card.id)}
                  onToggleVisibility={() => toggleSegmentVisibility(card.id as (typeof CVI_LABELS)[number]['id'])}
                  onOpacityChange={value => setSegmentOpacity(card.id, value)}
                  moreMenuContent={
                    <DropdownMenuItem disabled>
                      <span>Cardiac region</span>
                    </DropdownMenuItem>
                  }
                />
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Masks</div>
            <SegmentCard
              label={maskCard.name}
              colorHex={maskCard.color}
              visible={maskCard.visible}
              active={activeLabelId === MASK_CARD.id}
              opacity={maskCard.opacity}
              frameInfo={maskCard.frameInfo}
              onStepFrame={stepViewportFrame}
              onSelect={() => {
                setActiveLabelId(MASK_CARD.id);
                window?.dispatchEvent?.(
                  new CustomEvent(CVI_ACTIVE_LABEL_EVENT, {
                    detail: { labelId: MASK_CARD.id, sourceToolName: 'MaskContour' },
                  })
                );
              }}
              onToggleVisibility={() => handleMaskVisibilityChange(!maskCard.visible)}
              visibilityDisabled={!maskCard.frameInfo.startsWith('Masked Frames 0/') ? false : true}
              onOpacityChange={value => handleMaskOpacityChange(value)}
            />
          </div>
        </div>

        <div className="flex flex-col">
          <button
            type="button"
            className="flex w-full items-center justify-between py-1 text-[10px] font-medium uppercase tracking-wide text-gray-500 hover:text-gray-300"
            onClick={() => setAdvancedOpen(open => !open)}
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
          {advancedOpen ? (
            <div className="flex flex-col gap-3 pt-2">
              <div className="text-xs">
                <label className="mb-1 block text-gray-400">Segmentation Model</label>
                <div className="flex items-center gap-2">
                  <select
                    className="flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-[11px] text-gray-200"
                    value="manual"
                    disabled
                  >
                    <option value="manual">Manual</option>
                  </select>
                </div>
                <p className="mt-1 text-[10px] text-yellow-500">
                  Cardiac masks and contours stay editable here; backend inference wiring comes next.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="border-t border-white/10 px-2 py-2">
        <SegmentationPersistenceHud viewportId={activeViewportId} />
      </div>
    </div>
  );
};

export default CviSegmentationPanel;
