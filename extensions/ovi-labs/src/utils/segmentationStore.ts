/**
 * Segmentation Store
 *
 * Manages segmentation state for the Segmentation Panel using pub-sub pattern.
 * Tracks active model, labels, visibility, and opacity settings.
 */

import { annotation } from '@cornerstonejs/tools';
import { getRenderingEngines } from '@cornerstonejs/core';

// Segmentation label definitions (matching SEGMENTATION_LABELS in RoiViewerPanel)
export const SEGMENTATION_LABELS = [
  { id: 'uterineCavity', name: 'Uterine cavity', color: '#22D3EE' },
  { id: 'endometrium', name: 'Endometrium', color: '#F472B6' },
  { id: 'myometrium', name: 'Myometrium', color: '#FBBF24' },
  { id: 'junctionalZone', name: 'Junctional zone', color: '#60A5FA' },
] as const;

export type ModelType = 'manual' | 'threshold' | 'medsam' | 'unet_uterine';

// Represents a single annotation on a specific time frame
export interface AnnotationReference {
  annotationUID: string;
  referencedImageId?: string; // Identifies the specific time frame/slice
}

export interface SegmentationLabel {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  opacity: number;
  annotations: AnnotationReference[]; // Multiple annotations, one per time frame
  method: ModelType;
}

// For backward compatibility - get the first annotation UID
export const getFirstAnnotationUID = (label: SegmentationLabel): string | undefined => {
  return label.annotations?.[0]?.annotationUID;
};

export interface SegmentationState {
  activeModel: ModelType;
  labels: SegmentationLabel[];
  labelsByModel: Record<ModelType, SegmentationLabel[]>;
}

// Initial state
let currentState: SegmentationState = {
  activeModel: 'manual',
  labels: [],
  labelsByModel: {
    manual: [],
    threshold: [],
    medsam: [],
    unet_uterine: [],
  },
};

type Subscriber = (state: SegmentationState) => void;
const subscribers: Set<Subscriber> = new Set();

// Notify all subscribers
const notifySubscribers = (): void => {
  subscribers.forEach(subscriber => subscriber(currentState));
};

// Get current state
export const getSegmentationState = (): SegmentationState => currentState;

// Trigger viewport render after annotation changes
const triggerRender = () => {
  try {
    const renderingEngines = getRenderingEngines();
    renderingEngines.forEach(engine => {
      engine.renderViewports(engine.getViewports().map(vp => vp.id));
    });
  } catch (e) {
    console.warn('Failed to trigger render:', e);
  }
};

const applyModelVisibility = (model: ModelType): void => {
  const labelsByModel = currentState.labelsByModel;
  (Object.keys(labelsByModel) as ModelType[]).forEach(method => {
    labelsByModel[method].forEach(label => {
      label.annotations.forEach(ref => {
        if (method === model && label.visible) {
          showContour(ref.annotationUID, label.color, label.opacity);
        } else {
          setContourVisibility(ref.annotationUID, false);
        }
      });
    });
  });
};

// Set active model and update contour visibility accordingly
export const setActiveModel = (model: ModelType): void => {
  currentState = {
    ...currentState,
    activeModel: model,
    labels: currentState.labelsByModel[model] || [],
  };

  applyModelVisibility(model);
  triggerRender();
  notifySubscribers();
};

// Helper to set contour visibility on the actual annotation
const setContourVisibility = (annotationUID: string, visible: boolean): void => {
  try {
    const annotationObj = annotation.state.getAnnotation(annotationUID);
    if (annotationObj) {
      // Set visibility on the annotation object
      annotationObj.isVisible = visible;

      // Also use style API to control visibility via opacity
      // When hidden, set fully transparent color
      if (!visible) {
        annotation.config.style.setAnnotationStyles(annotationUID, {
          color: 'transparent',
          colorHighlighted: 'transparent',
          colorSelected: 'transparent',
        });
      }
    }
  } catch (e) {
    console.warn('Failed to set contour visibility:', e);
  }
};

// Helper to show contour with proper visibility and opacity
const showContour = (annotationUID: string, color: string, opacity: number): void => {
  try {
    const annotationObj = annotation.state.getAnnotation(annotationUID);
    if (annotationObj) {
      // Ensure annotation is visible
      annotationObj.isVisible = true;

      // Set color with opacity
      setContourOpacity(annotationUID, color, opacity);
    }
  } catch (e) {
    console.warn('Failed to show contour:', e);
  }
};

// Helper to set contour opacity via style
const setContourOpacity = (annotationUID: string, color: string, opacity: number): void => {
  try {
    // Convert opacity (0-1) to hex alpha (00-FF)
    const alpha = Math.round(opacity * 255)
      .toString(16)
      .padStart(2, '0');
    const colorWithAlpha = `${color}${alpha}`;

    annotation.config.style.setAnnotationStyles(annotationUID, {
      color: colorWithAlpha,
      colorHighlighted: colorWithAlpha,
      colorSelected: colorWithAlpha,
    });
  } catch (e) {
    console.warn('Failed to set contour opacity:', e);
  }
};

// Set label visibility - syncs with actual contours (all time frames)
export const setLabelVisibility = (labelId: string, visible: boolean): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const labelIndex = labelsForModel.findIndex(l => l.id === labelId);
  if (labelIndex === -1) return;

  const label = labelsForModel[labelIndex];
  const updatedLabel = { ...label, visible };
  const updatedLabels = [...labelsForModel];
  updatedLabels[labelIndex] = updatedLabel;

  currentState = {
    ...currentState,
    labels: updatedLabels,
    labelsByModel: {
      ...currentState.labelsByModel,
      [activeModel]: updatedLabels,
    },
  };

  // Update actual contour visibility for all time frames (only if model is manual)
  if (label.annotations.length > 0 && currentState.activeModel === activeModel) {
    label.annotations.forEach(ref => {
      if (visible) {
        // Restore visibility and color with opacity when showing
        showContour(ref.annotationUID, label.color, label.opacity);
      } else {
        // Hide by setting transparent color
        setContourVisibility(ref.annotationUID, false);
      }
    });
    triggerRender();
  }

  notifySubscribers();
};

// Set label opacity - syncs with actual contours (all time frames)
export const setLabelOpacity = (labelId: string, opacity: number): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const labelIndex = labelsForModel.findIndex(l => l.id === labelId);
  if (labelIndex === -1) return;

  const label = labelsForModel[labelIndex];
  const updatedLabel = { ...label, opacity };
  const updatedLabels = [...labelsForModel];
  updatedLabels[labelIndex] = updatedLabel;

  currentState = {
    ...currentState,
    labels: updatedLabels,
    labelsByModel: {
      ...currentState.labelsByModel,
      [activeModel]: updatedLabels,
    },
  };

  // Update actual contour opacity for all time frames
  if (label.annotations.length > 0 && currentState.activeModel === activeModel) {
    label.annotations.forEach(ref => {
      setContourOpacity(ref.annotationUID, label.color, opacity);
    });
    triggerRender();
  }

  notifySubscribers();
};

// Helper to remove a single annotation
const removeAnnotation = (annotationUID: string): void => {
  try {
    const annotationObj = annotation.state.getAnnotation(annotationUID);
    if (annotationObj) {
      // Deselect if selected
      try {
        annotation.selection.setAnnotationSelected(annotationUID, false);
      } catch {
        // Ignore selection errors
      }
      // Remove from the annotation state
      annotation.state.removeAnnotation(annotationUID);
    }
  } catch (e) {
    console.warn('Failed to remove annotation:', e);
  }
};

// Delete all time points for a label - removes all contours across all frames
export const deleteAllTimePoints = (labelId: string): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const label = labelsForModel.find(l => l.id === labelId);
  if (!label) return;

  // Remove all annotations for this label
  label.annotations.forEach(ref => {
    removeAnnotation(ref.annotationUID);
  });

  // Remove label from state
  const updatedLabels = labelsForModel.filter(l => l.id !== labelId);
  currentState = {
    ...currentState,
    labels: updatedLabels,
    labelsByModel: {
      ...currentState.labelsByModel,
      [activeModel]: updatedLabels,
    },
  };

  // Force immediate viewport update
  setTimeout(() => {
    triggerRender();
  }, 10);

  notifySubscribers();
};

// Delete current time point for a label - removes only the contour on the specified frame
export const deleteCurrentTimePoint = (labelId: string, referencedImageId: string): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const labelIndex = labelsForModel.findIndex(l => l.id === labelId);
  if (labelIndex === -1) return;

  const label = labelsForModel[labelIndex];

  // Find the annotation for this specific time frame
  const annotationRef = label.annotations.find(ref => ref.referencedImageId === referencedImageId);
  if (!annotationRef) return;

  // Remove the annotation
  removeAnnotation(annotationRef.annotationUID);

  // Update label's annotations list
  const updatedAnnotations = label.annotations.filter(ref => ref.referencedImageId !== referencedImageId);

  if (updatedAnnotations.length === 0) {
    // No more annotations, remove the label entirely
    const updatedLabels = labelsForModel.filter(l => l.id !== labelId);
    currentState = {
      ...currentState,
      labels: updatedLabels,
      labelsByModel: {
        ...currentState.labelsByModel,
        [activeModel]: updatedLabels,
      },
    };
  } else {
    // Update the label with remaining annotations
    const updatedLabel = { ...label, annotations: updatedAnnotations };
    const updatedLabels = [...labelsForModel];
    updatedLabels[labelIndex] = updatedLabel;
    currentState = {
      ...currentState,
      labels: updatedLabels,
      labelsByModel: {
        ...currentState.labelsByModel,
        [activeModel]: updatedLabels,
      },
    };
  }

  // Force immediate viewport update
  setTimeout(() => {
    triggerRender();
  }, 10);

  notifySubscribers();
};

// Backward compatibility - delete all time points
export const deleteLabel = deleteAllTimePoints;

// Sync labels from ManualContour annotations
// Creates ONE label per labelId (anatomical class), with multiple annotations for different time frames
export const syncLabelsFromAnnotations = (contours: any[]): void => {
  // Group contours by modelType + labelId, keeping ALL time frames (one annotation per frame)
  const labelsByModel: Record<ModelType, Map<string, AnnotationReference[]>> = {
    manual: new Map(),
    threshold: new Map(),
    medsam: new Map(),
    unet_uterine: new Map(),
  };

  for (const contour of contours) {
    const labelId = contour?.data?.labelId;
    if (!labelId) continue;

    const labelDef = SEGMENTATION_LABELS.find(l => l.id === labelId);
    if (!labelDef) continue;

    const modelType = (contour?.data?.modelType as ModelType) || 'manual';
    const referencedImageId = contour.metadata?.referencedImageId;
    const annotationRef: AnnotationReference = {
      annotationUID: contour.annotationUID,
      referencedImageId,
    };

    if (!labelsByModel[modelType].has(labelId)) {
      labelsByModel[modelType].set(labelId, []);
    }

    // Check if we already have an annotation for this frame (shouldn't happen, but be safe)
    const existingRefs = labelsByModel[modelType].get(labelId)!;
    const existingForFrame = existingRefs.find(ref => ref.referencedImageId === referencedImageId);
    if (!existingForFrame) {
      existingRefs.push(annotationRef);
    }
  }

  // Build new labels array
  const newLabelsByModel: Record<ModelType, SegmentationLabel[]> = {
    manual: [],
    threshold: [],
    medsam: [],
    unet_uterine: [],
  };

  (Object.keys(labelsByModel) as ModelType[]).forEach(modelType => {
    for (const [labelId, annotationRefs] of labelsByModel[modelType]) {
      const labelDef = SEGMENTATION_LABELS.find(l => l.id === labelId);
      if (!labelDef) continue;

      const firstContour = contours.find(c => c.annotationUID === annotationRefs[0]?.annotationUID);
      const existingLabel = currentState.labelsByModel[modelType]?.find(l => l.id === labelId);

      newLabelsByModel[modelType].push({
        id: labelId,
        name: labelDef.name,
        color: firstContour?.data?.labelColor || labelDef.color,
        visible: existingLabel?.visible ?? true,
        opacity: existingLabel?.opacity ?? 0.8,
        annotations: annotationRefs,
        method: modelType,
      });
    }

    newLabelsByModel[modelType].sort((a, b) => {
      const indexA = SEGMENTATION_LABELS.findIndex(l => l.id === a.id);
      const indexB = SEGMENTATION_LABELS.findIndex(l => l.id === b.id);
      return indexA - indexB;
    });
  });

  currentState = {
    ...currentState,
    labelsByModel: newLabelsByModel,
    labels: newLabelsByModel[currentState.activeModel] || [],
  };

  applyModelVisibility(currentState.activeModel);
  notifySubscribers();
};

// Subscribe to state changes
export const subscribeSegmentationState = (subscriber: Subscriber): (() => void) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};

// Reset state (useful for mode exit)
export const resetSegmentationState = (): void => {
  currentState = {
    activeModel: 'manual',
    labels: [],
    labelsByModel: {
      manual: [],
      threshold: [],
      medsam: [],
      unet_uterine: [],
    },
  };
  notifySubscribers();
};
