import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { DropdownMenuItem, SegmentCard } from '@ohif/ui-next';
import { DicomMetadataStore } from '@ohif/core';
import { annotation } from '@cornerstonejs/tools';
import { getRenderingEngines } from '@cornerstonejs/core';
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

  const uiNotificationService = servicesManager?.services?.uiNotificationService;
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;

  const totalFrameCount = useMemo(() => {
    if (!activeViewportId || !servicesManager) {
      return 0;
    }

    const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
    const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(activeViewportId);
    const imageIds = viewport?.getImageIds?.();

    return imageIds?.length || 0;
  }, [activeViewportId, servicesManager, revision]);

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

  useEffect(() => {
    const unsubscribe = subscribeSegmentationState(state => {
      setLabels(state.labels);
    });
    return unsubscribe;
  }, []);

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
            const annotatedFrames = card.annotations.length;
            const frameText = card.isMask
              ? `Masked Frames ${annotatedFrames}/${totalFrameCount || 0}`
              : `Annotated Frames ${annotatedFrames}/${totalFrameCount || 0}`;
            const isInteractive = card.annotations.length > 0;
            const isActive = card.id === activeLabelId;
            const selectedLabel = labels.find(label => label.id === card.id);
            const canDeleteCurrentFrame =
              !!selectedLabel && !!currentImageId && hasAnnotationOnCurrentFrame(selectedLabel);

            return (
              <SegmentCard
                key={card.id}
                label={card.name}
                colorHex={card.color}
                visible={card.visible}
                active={isActive}
                opacity={card.opacity}
                frameInfo={frameText}
                onStepFrame={stepViewportFrame}
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
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default SegmentationLabelsList;
