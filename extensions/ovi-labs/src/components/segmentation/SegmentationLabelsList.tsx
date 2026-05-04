import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  DropdownMenuItem,
  SegmentCard,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ohif/ui-next';
import { DicomMetadataStore } from '@ohif/core';
import { annotation } from '@cornerstonejs/tools';
import { getRenderingEngines, cache } from '@cornerstonejs/core';
import {
  SEGMENTATION_LABELS,
  SegmentationLabel,
  getSegmentationState,
  setLabelVisibility,
  setLabelOpacity,
  deleteAllTimePoints,
  deleteCurrentTimePoint,
  subscribeSegmentationState,
} from '../../utils/segmentationStore';
import {
  ensureOviSegmentationForViewport,
  getOviSegmentIndexForLabelId,
  activateOviCompatibleSegmentation,
  createOviSegmentationImportCopy,
  OVI_SEGMENTATION_LABELS,
} from '../../utils/oviSegmentation';

interface SegmentationLabelsListProps {
  servicesManager?: any;
  activeViewportId?: string;
  revision?: number;
  currentImageId?: string; // Current frame's image ID
}

type DisplayCard = {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  opacity: number;
  annotations: { annotationUID: string; referencedImageId?: string }[];
  isMask?: boolean;
};

const MASK_LABEL = { id: 'mask', name: 'Mask', color: '#94A3B8' };
const DEFAULT_LABEL_OPACITY = 0.2;
const OVI_ACTIVE_LABEL_EVENT = 'ovi-set-active-label';

type SegmentationOption = {
  segmentationId: string;
  label: string;
  segments: Record<number, any>;
};

const getInitialActiveLabelId = () => {
  return '';
};

const SegmentationLabelsList: React.FC<SegmentationLabelsListProps> = ({
  servicesManager,
  activeViewportId,
  revision = 0,
  currentImageId,
}) => {
  const [labels, setLabels] = useState<SegmentationLabel[]>(getSegmentationState().labels);
  const [maskRevision, setMaskRevision] = useState(0);
  const [opacityOverrides, setOpacityOverrides] = useState<Record<string, number>>({});
  const [activeLabelId, setActiveLabelId] = useState<string>(getInitialActiveLabelId);
  const [segmentationOptions, setSegmentationOptions] = useState<SegmentationOption[]>([]);
  const [activeSegmentationId, setActiveSegmentationId] = useState<string>('');
  const [mappingSource, setMappingSource] = useState<SegmentationOption | null>(null);
  const [labelMapping, setLabelMapping] = useState<Record<number, string>>({});

  const uiNotificationService = servicesManager?.services?.uiNotificationService;
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
  const { displaySetService, viewportGridService } = servicesManager?.services || {};

  const refreshSegmentationOptions = useCallback(() => {
    const segmentationService = servicesManager?.services?.segmentationService;
    if (!segmentationService) {
      return;
    }

    const activeSegmentation = activeViewportId
      ? segmentationService.getActiveSegmentation?.(activeViewportId)
      : null;
    const nextOptions = (segmentationService.getSegmentations?.() || []).map(segmentation => ({
      segmentationId: segmentation.segmentationId,
      label: segmentation.label || 'Segmentation',
      segments: Object.fromEntries(
        Object.entries(segmentation.segments || {}).map(([segmentIndex, segment]: [string, any]) => [
          Number(segmentIndex),
          {
            ...segment,
            segmentIndex: segment.segmentIndex ?? Number(segmentIndex),
          },
        ])
      ),
    }));

    setSegmentationOptions(nextOptions);
    setActiveSegmentationId(activeSegmentation?.segmentationId || '');
  }, [activeViewportId, servicesManager]);

  // Canonical readViewportNavigation — identical pattern to SegmentCardsList.tsx:123–176.
  // Returns slice/time navigation state from the active viewport's dynamic volume info (if present).
  const readViewportNavigation = useCallback(() => {
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
  }, [activeViewportId, cornerstoneViewportService, displaySetService, viewportGridService]);

  const totalFrameCount = useMemo(() => {
    if (!activeViewportId || !servicesManager) {
      return 0;
    }

    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    const imageIds = viewport?.getImageIds?.();

    return imageIds?.length || 0;
  }, [activeViewportId, servicesManager, revision]);

  const totalTimePoints = useMemo(() => {
    // Prefer dynamic volume time points from the viewport; fall back to flat frame count.
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

  const imageIdIndexMap = useMemo(() => {
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    const imageIds = viewport?.getImageIds?.() ?? [];
    const map = new Map<string, number>();
    imageIds.forEach((id: string, i: number) => map.set(id, i));
    return map;
  }, [activeViewportId, cornerstoneViewportService, revision]);

  const currentFrameIndex = useMemo(
    () => imageIdIndexMap.get(currentImageId ?? '') ?? 0,
    [imageIdIndexMap, currentImageId]
  );

  const currentTimeIndex = useMemo(
    () => (framesPerTimePoint > 1 ? Math.floor(currentFrameIndex / framesPerTimePoint) : 0),
    [currentFrameIndex, framesPerTimePoint]
  );

  // Check if label has annotation on current frame
  const hasAnnotationOnCurrentFrame = useCallback(
    (label: SegmentationLabel) => {
      if (!currentImageId) return false;
      return label.annotations.some(ref => ref.referencedImageId === currentImageId);
    },
    [currentImageId]
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
        ...MASK_LABEL,
        visible: false,
        opacity: DEFAULT_LABEL_OPACITY,
        annotations: [],
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

    const annotations = maskAnnotations.map(contour => ({
      annotationUID: contour.annotationUID,
      referencedImageId: contour?.metadata?.referencedImageId,
    }));

    const firstAnnotation = maskAnnotations[0];
    const isVisible =
      maskAnnotations.length > 0
        ? maskAnnotations.some(contour => contour?.isVisible !== false)
        : false;
    const opacity = firstAnnotation?.data?.fillOpacity ?? DEFAULT_LABEL_OPACITY;

    return {
      ...MASK_LABEL,
      visible: isVisible,
      opacity: opacityOverrides[MASK_LABEL.id] ?? opacity,
      annotations,
      isMask: true,
    };
  }, [activeSeriesInstanceUID, opacityOverrides, revision, maskRevision]);

  const displayCards = useMemo(() => {
    const labelMap = new Map(labels.map(label => [label.id, label]));

    const labelCards: DisplayCard[] = SEGMENTATION_LABELS.map(def => {
      const label = labelMap.get(def.id);
      return {
        id: def.id,
        name: def.name,
        color: label?.color || def.color,
        visible: label ? label.visible : false,
        opacity: opacityOverrides[def.id] ?? label?.opacity ?? DEFAULT_LABEL_OPACITY,
        annotations: label?.annotations || [],
        isMask: false,
      };
    });

    return {
      labelCards,
      maskCards: [maskCard],
    };
  }, [labels, maskCard]);

  const stepViewportFrame = useCallback(
    (delta: number) => {
      if (!activeViewportId || !cornerstoneViewportService || !delta) {
        return;
      }

      const viewport = cornerstoneViewportService.getCornerstoneViewport?.(activeViewportId);
      const imageIds = viewport?.getImageIds?.();
      const currentIndex = viewport?.getCurrentImageIdIndex?.();

      if (!viewport?.setImageIdIndex || !Array.isArray(imageIds) || !imageIds.length) {
        return;
      }

      const safeCurrentIndex = typeof currentIndex === 'number' ? currentIndex : 0;
      const nextIndex = Math.max(0, Math.min(imageIds.length - 1, safeCurrentIndex + delta));

      if (nextIndex === safeCurrentIndex) {
        return;
      }

      viewport.setImageIdIndex(nextIndex);
      viewport.render?.();
    },
    [activeViewportId, cornerstoneViewportService]
  );

  const stepViewportTime = useCallback(
    (delta: number) => {
      if (!delta) {
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
        cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId)?.render?.();
        return;
      }

      // Last-resort fallback: step by framesPerTimePoint flat frames.
      stepViewportFrame(delta * framesPerTimePoint);
    },
    [activeViewportId, cornerstoneViewportService, displaySetService, framesPerTimePoint, readViewportNavigation, stepViewportFrame]
  );

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setLabels(state.labels);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    refreshSegmentationOptions();
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
    const subscriptions = events.map(event => segmentationService.subscribe(event, refreshSegmentationOptions));

    return () => subscriptions.forEach(subscription => subscription.unsubscribe());
  }, [refreshSegmentationOptions, servicesManager]);

  useEffect(() => {
    const handler = (evt: Event) => {
      const labelId = (evt as CustomEvent)?.detail?.labelId;
      if (labelId) {
        setActiveLabelId(labelId);
      }
    };
    window.addEventListener(OVI_ACTIVE_LABEL_EVENT, handler);
    return () => window.removeEventListener(OVI_ACTIVE_LABEL_EVENT, handler);
  }, []);

  const handleDeleteCurrentFrame = (labelId: string) => {
    if (labelId && currentImageId) {
      deleteCurrentTimePoint(labelId, currentImageId, {
        servicesManager,
        viewportId: activeViewportId,
      });
      uiNotificationService?.show?.({
        title: 'Time Point Deleted',
        message: 'Contour for current time frame has been removed',
        type: 'info',
        duration: 2000,
      });
    }
  };

  const handleDeleteAllFrames = (labelId: string) => {
    if (labelId) {
      deleteAllTimePoints(labelId, {
        servicesManager,
        viewportId: activeViewportId,
      });
      uiNotificationService?.show?.({
        title: 'Label Deleted',
        message: 'All contours for this label have been removed',
        type: 'info',
        duration: 2000,
      });
    }
  };

  const handleSegmentationSelect = useCallback(
    async (segmentationId: string) => {
      const selected = segmentationOptions.find(option => option.segmentationId === segmentationId);
      if (!selected || !servicesManager) {
        return;
      }

      await activateOviCompatibleSegmentation({
        servicesManager,
        viewportId: activeViewportId,
        segmentationId,
      });
      refreshSegmentationOptions();
    },
    [activeViewportId, refreshSegmentationOptions, segmentationOptions, servicesManager]
  );

  const handleCreateImportCopy = useCallback(async () => {
    if (!mappingSource || !servicesManager) {
      return;
    }

    const mapping = Object.fromEntries(
      Object.entries(labelMapping).map(([targetSegmentIndex, sourceSegmentIndex]) => [
        Number(targetSegmentIndex),
        Number(sourceSegmentIndex),
      ])
    );

    if (OVI_SEGMENTATION_LABELS.some(label => !mapping[label.segmentIndex])) {
      uiNotificationService?.show?.({
        title: 'Import Label Mapping',
        message: 'Map all OVI labels before creating the import copy.',
        type: 'warning',
        duration: 3000,
      });
      return;
    }

    await createOviSegmentationImportCopy({
      servicesManager,
      viewportId: activeViewportId,
      sourceSegmentationId: mappingSource.segmentationId,
      mapping,
    });
    setMappingSource(null);
    refreshSegmentationOptions();
  }, [
    activeViewportId,
    labelMapping,
    mappingSource,
    refreshSegmentationOptions,
    servicesManager,
    uiNotificationService,
  ]);

  const handleVisibilityChange = (labelId: string, visible: boolean) => {
    setLabelVisibility(labelId, visible, {
      servicesManager,
      viewportId: activeViewportId,
    });
  };

  const handleLabelSelect = useCallback(
    async (labelId: string) => {
      if (!labelId || !servicesManager) {
        return;
      }

      const toolGroupService = servicesManager?.services?.toolGroupService;
      const activeTool = toolGroupService?.getToolGroup?.('default')?.getActivePrimaryMouseButtonTool?.();
      const sourceToolName =
        activeTool === 'CircularBrush' || activeTool === 'CircularEraser'
          ? 'CircularBrush'
          : 'ManualContour';

      setActiveLabelId(labelId);
      window?.dispatchEvent?.(
        new CustomEvent(OVI_ACTIVE_LABEL_EVENT, {
          detail: {
            labelId,
            sourceToolName,
          },
        })
      );

      const { segmentationService } = servicesManager.services || {};
      const context = await ensureOviSegmentationForViewport(servicesManager, activeViewportId);
      const segmentIndex = getOviSegmentIndexForLabelId(labelId);

      if (!context?.viewportId || !context?.segmentationId || !segmentationService || !segmentIndex) {
        return;
      }

      segmentationService.setActiveSegmentation(context.viewportId, context.segmentationId);
      segmentationService.setActiveSegment(context.segmentationId, segmentIndex);
    },
    [activeViewportId, servicesManager]
  );

  const clampOpacity = (value: number) =>
    Math.min(1, Math.max(0, Number.isFinite(value) ? value : DEFAULT_LABEL_OPACITY));

  const setCardOpacity = useCallback(
    (labelId: string, opacity: number) => {
      const nextOpacity = clampOpacity(opacity);
      setOpacityOverrides(prev => ({
        ...prev,
        [labelId]: nextOpacity,
      }));

      const label = labels.find(item => item.id === labelId);
      if (label?.annotations.length) {
        setLabelOpacity(labelId, nextOpacity, {
          servicesManager,
          viewportId: activeViewportId,
        });
      }
    },
    [activeViewportId, labels, servicesManager]
  );

  const handleMaskVisibilityChange = useCallback(
    (visible: boolean) => {
      maskCard.annotations.forEach(ref => {
        const annotationObj = annotation.state.getAnnotation(ref.annotationUID);
        if (!annotationObj) {
          return;
        }

        annotationObj.isVisible = visible;
        if (annotationObj.data) {
          annotationObj.data.fillOpacity = visible ? maskCard.opacity : 0;
          annotationObj.data.renderFill = visible && maskCard.opacity > 0;
        }

        annotation.config.style.setAnnotationStyles(ref.annotationUID, {
          color: visible ? MASK_LABEL.color : 'transparent',
          colorHighlighted: visible ? MASK_LABEL.color : 'transparent',
          colorSelected: visible ? MASK_LABEL.color : 'transparent',
          fillColor: MASK_LABEL.color,
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
    [maskCard.annotations, maskCard.opacity]
  );

  const handleMaskOpacityChange = useCallback(
    (opacity: number) => {
      const nextOpacity = clampOpacity(opacity);
      setOpacityOverrides(prev => ({
        ...prev,
        [MASK_LABEL.id]: nextOpacity,
      }));

      maskCard.annotations.forEach(ref => {
        const annotationObj = annotation.state.getAnnotation(ref.annotationUID);
        if (!annotationObj) {
          return;
        }

        if (annotationObj.data) {
          annotationObj.data.fillOpacity = nextOpacity;
          annotationObj.data.renderFill = maskCard.visible && nextOpacity > 0;
        }

        annotation.config.style.setAnnotationStyles(ref.annotationUID, {
          color: maskCard.visible ? MASK_LABEL.color : 'transparent',
          colorHighlighted: maskCard.visible ? MASK_LABEL.color : 'transparent',
          colorSelected: maskCard.visible ? MASK_LABEL.color : 'transparent',
          fillColor: MASK_LABEL.color,
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
    [maskCard.annotations, maskCard.visible]
  );

  const sectionConfigs = [
    { key: 'labels', title: 'Labels', cards: displayCards.labelCards },
    { key: 'masks', title: 'Masks', cards: displayCards.maskCards },
  ] as const;

  return (
    <div className="flex flex-col gap-2">
      {segmentationOptions.length ? (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Active Segmentation
          </label>
          <Select
            value={activeSegmentationId}
            onValueChange={handleSegmentationSelect}
          >
            <SelectTrigger
              aria-label="OVI active segmentation"
              className="h-8 w-full border-gray-700 bg-gray-900 text-xs text-white"
            >
              <SelectValue placeholder="Select segmentation" />
            </SelectTrigger>
            <SelectContent>
              {segmentationOptions.map(option => (
                <SelectItem
                  key={option.segmentationId}
                  value={option.segmentationId}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        Labels
      </div>

      {sectionConfigs.map(section => (
        <div
          key={section.key}
          className="flex flex-col gap-1.5"
        >
          {section.key === 'masks' ? (
            <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              {section.title}
            </div>
          ) : null}
          {section.cards.map(card => {
            const isInteractive = card.annotations.length > 0;
            const isActive = card.id === activeLabelId;
            const selectedLabel = labels.find(label => label.id === card.id);
            const canDeleteCurrentFrame =
              !!selectedLabel && !!currentImageId && hasAnnotationOnCurrentFrame(selectedLabel);

            // Compute annotated slice/frame counts from referencedImageId → frameIndex mapping.
            let navigationGroups: { key: string; label: string; onStep?: (delta: number) => void; prevTitle?: string; nextTitle?: string }[];
            if (card.isMask) {
              navigationGroups = [{
                key: 'frame',
                label: `Masked Frame ${card.annotations.length}/${totalFrameCount || 0}`,
                onStep: stepViewportFrame,
                prevTitle: 'Previous frame',
                nextTitle: 'Next frame',
              }];
            } else {
              const slicesAtCurrentTime = new Set<number>();
              const annotatedTimes = new Set<number>();
              for (const { referencedImageId } of card.annotations) {
                const fi = referencedImageId ? (imageIdIndexMap.get(referencedImageId) ?? -1) : -1;
                if (fi < 0) continue;
                const t = framesPerTimePoint > 1 ? Math.floor(fi / framesPerTimePoint) : fi;
                const s = framesPerTimePoint > 1 ? fi % framesPerTimePoint : 0;
                annotatedTimes.add(t);
                if (t === currentTimeIndex) slicesAtCurrentTime.add(s);
              }
              navigationGroups = [
                {
                  key: 'slices',
                  label: `Annotated Slice ${slicesAtCurrentTime.size}/${framesPerTimePoint}`,
                  onStep: stepViewportFrame,
                  prevTitle: 'Previous slice',
                  nextTitle: 'Next slice',
                },
                ...(totalTimePoints > 1 ? [{
                  key: 'time',
                  label: `Annotated Frame ${annotatedTimes.size}/${totalTimePoints}`,
                  onStep: stepViewportTime,
                  prevTitle: 'Previous frame',
                  nextTitle: 'Next frame',
                }] : []),
              ];
            }

            return (
              <div
                key={card.id}
                data-testid={`ovi-segmentation-row-${card.id}`}
                data-cy={`ovi-segmentation-row-${card.id}`}
              >
                <SegmentCard
                  label={card.name}
                  colorHex={card.color}
                  visible={card.visible}
                  active={isActive}
                  opacity={card.opacity}
                  navigationGroups={navigationGroups}
                  onSelect={
                    card.isMask
                      ? () => {
                          setActiveLabelId(card.id);
                          window?.dispatchEvent?.(
                            new CustomEvent(OVI_ACTIVE_LABEL_EVENT, {
                              detail: { labelId: card.id, sourceToolName: 'MaskContour' },
                            })
                          );
                        }
                      : () => void handleLabelSelect(card.id)
                  }
                  onToggleVisibility={
                    isInteractive
                      ? () => {
                          if (card.isMask) {
                            handleMaskVisibilityChange(!card.visible);
                          } else {
                            handleVisibilityChange(card.id, !card.visible);
                          }
                        }
                      : undefined
                  }
                  visibilityDisabled={!isInteractive}
                  onOpacityChange={value => {
                    if (card.isMask) {
                      handleMaskOpacityChange(value);
                    } else {
                      setCardOpacity(card.id, value);
                    }
                  }}
                  moreMenuContent={
                    !card.isMask && isInteractive ? (
                      <>
                        <DropdownMenuItem
                          disabled={!canDeleteCurrentFrame}
                          onClick={e => {
                            e.stopPropagation();
                            handleDeleteCurrentFrame(card.id);
                          }}
                        >
                          <span>Delete Current Frame</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={e => {
                            e.stopPropagation();
                            handleDeleteAllFrames(card.id);
                          }}
                        >
                          <span>Delete All Frames ({annotatedFrames})</span>
                        </DropdownMenuItem>
                      </>
                    ) : null
                  }
                />
              </div>
            );
          })}
        </div>
      ))}

      {mappingSource ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ovi-import-label-mapping-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-950 p-4 shadow-xl">
            <h2
              id="ovi-import-label-mapping-title"
              className="text-base font-semibold text-white"
            >
              Create Import Label Mapping
            </h2>
            <p className="mt-2 text-xs leading-5 text-gray-300">
              Map labels from "{mappingSource.label}" to the four OVI regions. OVI Labs will create
              a new shared segmentation named Ovi Lab and leave the source segmentation unchanged.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              {OVI_SEGMENTATION_LABELS.map(label => (
                <div
                  key={label.segmentIndex}
                  className="flex flex-col gap-1"
                >
                  <label className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
                    {label.name}
                  </label>
                  <Select
                    value={labelMapping[label.segmentIndex] || ''}
                    onValueChange={value =>
                      setLabelMapping(prev => ({
                        ...prev,
                        [label.segmentIndex]: value,
                      }))
                    }
                  >
                    <SelectTrigger
                      aria-label={label.name}
                      className="h-8 w-full border-gray-700 bg-gray-900 text-xs text-white"
                    >
                      <SelectValue placeholder="Select source label" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(mappingSource.segments).map((segment: any) => (
                        <SelectItem
                          key={segment.segmentIndex}
                          value={String(segment.segmentIndex)}
                        >
                          {segment.label || `Segment ${segment.segmentIndex}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
                onClick={() => setMappingSource(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-cyan-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-cyan-400"
                onClick={() => void handleCreateImportCopy()}
              >
                Create Import Copy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default SegmentationLabelsList;
