import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useSegmentationTableContext,
  useSegmentationExpanded,
  SegmentCard,
  Icons,
  DropdownMenuItem,
} from '@ohif/ui-next';
import { cache, imageLoader, Enums, eventTarget, utilities as csUtils } from '@cornerstonejs/core';
import { useSystem } from '@ohif/core/src';
import { useViewportGrid } from '@ohif/ui-next';

const DEFAULT_SEGMENT_OPACITY = 0.2;

type SegmentAnnotationSummary = {
  totalSlices: number;
  annotatedSlicesByTime?: Record<number, number>;
  annotatedTimes?: number;
  totalTimes?: number;
};

type ViewportNavigationState = {
  currentSlice: number;
  totalSlices: number;
  currentTime?: number;
  totalTimes?: number;
  volumeId?: string;
};

const getAnnotatedSliceCountForCurrentTime = (
  summary: SegmentAnnotationSummary | undefined,
  viewportNavigation: ViewportNavigationState
) => {
  if (!summary) {
    return 0;
  }

  if (summary.totalTimes && summary.totalTimes > 1) {
    return summary.annotatedSlicesByTime?.[viewportNavigation.currentTime || 1] || 0;
  }

  return summary.annotatedSlicesByTime?.[1] || 0;
};

const getScalarData = (image: any): Uint8Array | Uint16Array | Uint32Array | null => {
  try {
    return image?.voxelManager?.getScalarData?.() || null;
  } catch {
    return null;
  }
};

const collectPresentSegmentIndices = (
  scalarData: Uint8Array | Uint16Array | Uint32Array | null
): Set<number> => {
  const present = new Set<number>();
  if (!scalarData) {
    return present;
  }

  for (let i = 0; i < scalarData.length; i += 1) {
    const value = scalarData[i];
    if (value > 0) {
      present.add(value);
    }
  }

  return present;
};

/**
 * Replacement for SegmentationTable.Segments that renders each OHIF segment
 * as an OVI Labs-style card with a color border, visibility toggle, opacity
 * slider, frame navigation, and an icon-more dropdown (Rename / Change Color /
 * Lock / Delete).  Segment names are taken directly from the OHIF segmentation
 * service (i.e. whatever the backend provides).
 *
 * Usage — register as the `panelSegmentation.customSegmentsList` customization
 * and PanelSegmentation will render it instead of SegmentationTable.Segments.
 */
export const SegmentCardsList = ({ children }: { children?: React.ReactNode }) => {
  const {
    activeSegmentationId,
    disableEditing,
    onSegmentColorClick,
    onToggleSegmentVisibility,
    onToggleSegmentLock,
    onSegmentClick,
    onSegmentEdit,
    onSegmentDelete,
    data,
    fillAlpha,
  } = useSegmentationTableContext('SegmentCardsList');

  // Prefer SegmentationExpanded context (expanded mode); fall back to the
  // active segmentation from the table context (collapsed mode).
  let segmentation: any;
  let representation: any;

  try {
    const info = useSegmentationExpanded('SegmentCardsList');
    segmentation = info.segmentation;
    representation = info.representation;
  } catch {
    const info = data.find(e => e.segmentation.segmentationId === activeSegmentationId);
    segmentation = info?.segmentation;
    representation = info?.representation;
  }

  const { servicesManager } = useSystem();
  const [{ activeViewportId }] = useViewportGrid();
  const { segmentationService, displaySetService, viewportGridService } = servicesManager.services;
  const [segmentOpacities, setSegmentOpacities] = useState<Record<number, number>>({});
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [segmentAnnotations, setSegmentAnnotations] = useState<Record<number, SegmentAnnotationSummary>>(
    {}
  );
  const [viewportNavigation, setViewportNavigation] = useState<ViewportNavigationState>({
    currentSlice: 1,
    totalSlices: 1,
  });

  const readViewportNavigation = useCallback((): ViewportNavigationState => {
    const { cornerstoneViewportService } = servicesManager.services;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    const imageIds = viewport?.getImageIds?.();
    const currentIndex = viewport?.getCurrentImageIdIndex?.();
    const numberOfSlices = viewport?.getNumberOfSlices?.();
    const safeCurrentIndex = typeof currentIndex === 'number' ? currentIndex : 0;
    const currentImageId = imageIds?.[safeCurrentIndex];
    const baseState: ViewportNavigationState = {
      currentSlice: safeCurrentIndex + 1,
      totalSlices:
        typeof numberOfSlices === 'number' && numberOfSlices > 0 ? numberOfSlices : imageIds?.length || 1,
    };

    const { viewports } = viewportGridService.getState();
    const displaySetInstanceUIDs = viewports.get(activeViewportId)?.displaySetInstanceUIDs || [];

    for (const displaySetInstanceUID of displaySetInstanceUIDs) {
      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
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
      const currentSliceIndex = currentImageId
        ? currentTimePointImageIds.indexOf(currentImageId)
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

    return baseState;
  }, [activeViewportId, displaySetService, servicesManager.services, viewportGridService]);

  const stepViewportFrame = useCallback(
    (delta: number) => {
      const { cornerstoneViewportService } = servicesManager.services;
      const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
      const currentIndex = viewport?.getCurrentImageIdIndex?.();
      const totalSlices = viewport?.getNumberOfSlices?.() || viewport?.getImageIds?.()?.length || 0;

      if (!viewport?.element || !totalSlices) {
        return;
      }

      const safeIndex = typeof currentIndex === 'number' ? currentIndex : 0;
      const nextIndex = Math.max(0, Math.min(totalSlices - 1, safeIndex + delta));
      if (nextIndex === safeIndex) {
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
      if (!delta) {
        return;
      }

      const navigation = readViewportNavigation();
      if (!navigation.volumeId || !navigation.totalTimes) {
        return;
      }

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
      if (displaySetService.getDisplaySetByUID(navigation.volumeId)?.dynamicVolumeInfo) {
        displaySetService.getDisplaySetByUID(navigation.volumeId).dynamicVolumeInfo.dimensionGroupNumber =
          nextTime;
      }
      servicesManager.services.cornerstoneViewportService
        ?.getCornerstoneViewport?.(activeViewportId)
        ?.render?.();
      setViewportNavigation(prev => ({
        ...readViewportNavigation(),
        volumeId: navigation.volumeId,
        currentTime: nextTime,
        totalTimes: navigation.totalTimes || prev.totalTimes,
      }));
    },
    [activeViewportId, displaySetService, readViewportNavigation, servicesManager.services]
  );

  const segments = useMemo(
    () => (representation ? (Object.values(representation.segments) as any[]).filter(Boolean) : []),
    [representation]
  );
  const viewportId = representation?.viewportId || activeViewportId;

  const getSegmentOpacity = useCallback(
    (segmentIndex: number) => {
      if (!representation || !segmentation) {
        return fillAlpha ?? DEFAULT_SEGMENT_OPACITY;
      }

      const style = segmentationService.getStyle({
        viewportId,
        segmentationId: segmentation.segmentationId,
        type: representation.type,
        segmentIndex,
      }) as { fillAlpha?: number } | undefined;

      return (
        style?.fillAlpha ??
        representation.styles?.fillAlpha ??
        fillAlpha ??
        DEFAULT_SEGMENT_OPACITY
      );
    },
    [
      fillAlpha,
      representation?.styles?.fillAlpha,
      representation?.type,
      segmentation?.segmentationId,
      segmentationService,
      viewportId,
    ]
  );

  useEffect(() => {
    setViewportNavigation(readViewportNavigation());
  }, [readViewportNavigation]);

  useEffect(() => {
    const { cornerstoneViewportService } = servicesManager.services;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    const element = viewport?.element;

    if (!element) {
      return;
    }

    const updateNavigation = () => {
      setViewportNavigation(readViewportNavigation());
    };

    const updateTimePointNavigation = (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { volumeId?: string; timePointIndex?: number }
        | undefined;

      if (!detail?.volumeId || typeof detail.timePointIndex !== 'number') {
        updateNavigation();
        return;
      }

      const currentNavigation = readViewportNavigation();
      if (currentNavigation.volumeId && currentNavigation.volumeId !== detail.volumeId) {
        return;
      }

      setViewportNavigation({
        ...currentNavigation,
        volumeId: detail.volumeId,
        currentTime: detail.timePointIndex + 1,
      });
    };

    element.addEventListener(Enums.Events.STACK_VIEWPORT_SCROLL, updateNavigation);
    element.addEventListener(Enums.Events.VOLUME_NEW_IMAGE, updateNavigation);
    element.addEventListener(Enums.Events.IMAGE_RENDERED, updateNavigation);
    eventTarget.addEventListener(Enums.Events.DYNAMIC_VOLUME_DIMENSION_GROUP_CHANGED, updateNavigation);
    eventTarget.addEventListener(Enums.Events.DYNAMIC_VOLUME_TIME_POINT_INDEX_CHANGED, updateTimePointNavigation);

    return () => {
      element.removeEventListener(Enums.Events.STACK_VIEWPORT_SCROLL, updateNavigation);
      element.removeEventListener(Enums.Events.VOLUME_NEW_IMAGE, updateNavigation);
      element.removeEventListener(Enums.Events.IMAGE_RENDERED, updateNavigation);
      eventTarget.removeEventListener(
        Enums.Events.DYNAMIC_VOLUME_DIMENSION_GROUP_CHANGED,
        updateNavigation
      );
      eventTarget.removeEventListener(
        Enums.Events.DYNAMIC_VOLUME_TIME_POINT_INDEX_CHANGED,
        updateTimePointNavigation
      );
    };
  }, [activeViewportId, readViewportNavigation, servicesManager.services]);

  useEffect(() => {
    if (!representation || !segmentation) {
      setSegmentOpacities({});
      return;
    }

    const nextOpacities: Record<number, number> = {};
    segments.forEach(segment => {
      nextOpacities[segment.segmentIndex] = getSegmentOpacity(segment.segmentIndex);
    });
    setSegmentOpacities(nextOpacities);
  }, [getSegmentOpacity, segments]);

  useEffect(() => {
    if (!segmentation?.segmentationId) {
      return;
    }

    const refreshIfMatchingSegmentation = (evt?: { segmentationId?: string }) => {
      if (!evt?.segmentationId || evt.segmentationId === segmentation.segmentationId) {
        setAnnotationRevision(value => value + 1);
      }
    };

    const subscriptions = [
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
        refreshIfMatchingSegmentation
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_MODIFIED,
        refreshIfMatchingSegmentation
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
        refreshIfMatchingSegmentation
      ),
    ];

    return () => {
      subscriptions.forEach(subscription => subscription.unsubscribe());
    };
  }, [segmentation?.segmentationId, segmentationService]);

  useEffect(() => {
    let cancelled = false;

    const loadAnnotationSummary = async () => {
      if (!representation || !segmentation) {
        if (!cancelled) {
          setSegmentAnnotations({});
        }
        return;
      }

      const labelmapData = segmentation.representationData?.Labelmap as
        | { imageIds?: string[]; referencedImageIds?: string[] }
        | undefined;

      const segmentIndices = Object.keys(segmentation.segments).map(Number).filter(Boolean);
      const baseSummary = Object.fromEntries(
        segmentIndices.map(index => [
          index,
          {
            totalSlices: 0,
            annotatedSlicesByTime: {},
          },
        ])
      ) as Record<number, SegmentAnnotationSummary>;

      if (!labelmapData) {
        if (!cancelled) {
          setSegmentAnnotations(baseSummary);
        }
        return;
      }

      const dynamicInfo = segmentationService.getDynamicSegmentationInfo(segmentation.segmentationId);
      const totalTimes = dynamicInfo?.numTimePoints && dynamicInfo.numTimePoints > 1
        ? dynamicInfo.numTimePoints
        : undefined;
      const referencedImageIds = labelmapData.referencedImageIds || [];
      const framesPerTimePoint =
        totalTimes && referencedImageIds.length && referencedImageIds.length % totalTimes === 0
          ? referencedImageIds.length / totalTimes
          : undefined;

      const working = new Map<
        number,
        { timeIndices: Set<number>; sliceIndicesByTime: Map<number, Set<number>> }
      >();
      segmentIndices.forEach(index => {
        working.set(index, { timeIndices: new Set<number>(), sliceIndicesByTime: new Map() });
      });

      if (segmentationService.hasDynamicSegmentation(segmentation.segmentationId)) {
        const snapshots = await segmentationService.getDynamicSegmentationFrameSnapshots(
          segmentation.segmentationId
        );

        snapshots.forEach((snapshot, snapshotIndex) => {
          const presentIndices = collectPresentSegmentIndices(snapshot.maskData);
          const sliceIndex =
            framesPerTimePoint && framesPerTimePoint > 0
              ? snapshotIndex % framesPerTimePoint
              : snapshotIndex;
          const timeIndex =
            totalTimes && framesPerTimePoint && framesPerTimePoint > 0
              ? Math.floor(snapshotIndex / framesPerTimePoint)
              : null;

          presentIndices.forEach(segmentIndex => {
            const summary = working.get(segmentIndex);
            if (!summary) {
              return;
            }

            if (timeIndex !== null) {
              summary.timeIndices.add(timeIndex);
              const slicesForTime = summary.sliceIndicesByTime.get(timeIndex) || new Set<number>();
              slicesForTime.add(sliceIndex);
              summary.sliceIndicesByTime.set(timeIndex, slicesForTime);
            } else {
              const defaultSlices = summary.sliceIndicesByTime.get(0) || new Set<number>();
              defaultSlices.add(sliceIndex);
              summary.sliceIndicesByTime.set(0, defaultSlices);
            }
          });
        });
      } else {
        const imageIds = labelmapData.imageIds || [];
        await Promise.all(
          imageIds.map(async (imageId, sliceIndex) => {
            const image = cache.getImage(imageId) || (await imageLoader.loadAndCacheImage(imageId));
            const presentIndices = collectPresentSegmentIndices(getScalarData(image));

            presentIndices.forEach(segmentIndex => {
              const summary = working.get(segmentIndex);
              if (summary) {
                const defaultSlices = summary.sliceIndicesByTime.get(0) || new Set<number>();
                defaultSlices.add(sliceIndex);
                summary.sliceIndicesByTime.set(0, defaultSlices);
              }
            });
          })
        );
      }

      const totalSlices =
        framesPerTimePoint ||
        labelmapData.imageIds?.length ||
        referencedImageIds.length ||
        0;

      const resolved = Object.fromEntries(
        segmentIndices.map(index => {
          const summary = working.get(index);
          const annotatedSlicesByTime = Object.fromEntries(
            Array.from(summary?.sliceIndicesByTime.entries() || []).map(([timeIndex, sliceIndices]) => [
              timeIndex + 1,
              sliceIndices.size,
            ])
          );

          return [
            index,
            {
              totalSlices,
              annotatedSlicesByTime,
              annotatedTimes: totalTimes ? summary?.timeIndices.size || 0 : undefined,
              totalTimes,
            },
          ];
        })
      ) as Record<number, SegmentAnnotationSummary>;

      if (!cancelled) {
        setSegmentAnnotations(resolved);
      }
    };

    void loadAnnotationSummary();

    return () => {
      cancelled = true;
    };
  }, [annotationRevision, representation, segmentation, segmentationService]);

  const segmentNavigationGroups = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(segmentAnnotations).map(([segmentIndex, summary]) => [
          Number(segmentIndex),
          [
            {
              key: 'slices',
              label: `Annotated Slice ${getAnnotatedSliceCountForCurrentTime(
                summary,
                viewportNavigation
              )}/${summary.totalSlices || viewportNavigation.totalSlices}`,
              onStep: stepViewportFrame,
              prevTitle: 'Previous slice',
              nextTitle: 'Next slice',
            },
            ...(summary.totalTimes && summary.totalTimes > 1
              ? [
                  {
                    key: 'time',
                    label: `Annotated Frame ${summary.annotatedTimes || 0}/${summary.totalTimes}`,
                    onStep: stepViewportTime,
                    prevTitle: 'Previous time',
                    nextTitle: 'Next time',
                  },
                ]
              : []),
          ],
        ])
      ) as Record<
        number,
        Array<{
          key: string;
          label: string;
          onStep?: (delta: number) => void;
          prevTitle?: string;
          nextTitle?: string;
        }>
      >,
    [segmentAnnotations, stepViewportFrame, stepViewportTime, viewportNavigation]
  );

  if (!representation || !segmentation) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      {segments.length === 0 && (
        <div
          data-cy="segment-empty-state"
          className="flex items-center justify-center py-4 text-base text-white/30 select-none"
        >
          No Label
        </div>
      )}
      {segments.map(segment => {
        const { segmentIndex, color, visible } = segment as {
          segmentIndex: number;
          color: number[];
          visible: boolean;
        };
        const segFromSeg = segmentation.segments[segmentIndex];
        if (!segFromSeg) {
          return null;
        }
        const { label, locked, active } = segFromSeg;

        return (
          <SegmentCard
            key={segmentIndex}
            label={label}
            colorHex={`rgb(${color[0]},${color[1]},${color[2]})`}
            visible={visible}
            active={active ?? false}
            opacity={segmentOpacities[segmentIndex] ?? DEFAULT_SEGMENT_OPACITY}
            navigationGroups={
              segmentNavigationGroups[segmentIndex] || [
                {
                  key: 'slices',
                  label: `Annotated Slice ${getAnnotatedSliceCountForCurrentTime(
                    segmentAnnotations[segmentIndex],
                    viewportNavigation
                  )}/${segmentAnnotations[segmentIndex]?.totalSlices || viewportNavigation.totalSlices}`,
                  onStep: stepViewportFrame,
                  prevTitle: 'Previous slice',
                  nextTitle: 'Next slice',
                },
              ]
            }
            onSelect={() => onSegmentClick(segmentation.segmentationId, segmentIndex)}
            onToggleVisibility={() =>
              onToggleSegmentVisibility(
                segmentation.segmentationId,
                segmentIndex,
                representation.type
              )
            }
            onOpacityChange={value => {
              setSegmentOpacities(prev => ({
                ...prev,
                [segmentIndex]: value,
              }));

              segmentationService.setStyle(
                {
                  viewportId,
                  segmentationId: segmentation.segmentationId,
                  type: representation.type,
                  segmentIndex,
                },
                { fillAlpha: value }
              );
            }}
            onStepFrame={stepViewportFrame}
            moreMenuContent={
              disableEditing ? null : (
                <>
                  <DropdownMenuItem
                    onClick={e => {
                      e.stopPropagation();
                      onSegmentEdit(segmentation.segmentationId, segmentIndex);
                    }}
                  >
                    <Icons.Rename className="text-foreground" />
                    <span className="pl-2">Rename</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={e => {
                      e.stopPropagation();
                      onSegmentColorClick(segmentation.segmentationId, segmentIndex);
                    }}
                  >
                    <Icons.ColorChange className="text-foreground" />
                    <span className="pl-2">Change Color</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={e => {
                      e.stopPropagation();
                      onToggleSegmentLock(segmentation.segmentationId, segmentIndex);
                    }}
                  >
                    <Icons.Lock className="text-foreground" />
                    <span className="pl-2">{locked ? 'Unlock' : 'Lock'}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={e => {
                      e.stopPropagation();
                      onSegmentDelete(segmentation.segmentationId, segmentIndex);
                    }}
                  >
                    <Icons.Delete className="text-red-600" />
                    <span className="pl-2 text-red-600">Delete</span>
                  </DropdownMenuItem>
                </>
              )
            }
          />
        );
      })}
      {children}
    </div>
  );
};
