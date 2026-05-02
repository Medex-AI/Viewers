/**
 * Segmentation Store
 *
 * Manages segmentation state for the Segmentation Panel using pub-sub pattern.
 * Tracks active model, labels, visibility, and opacity settings.
 */

import { annotation } from '@cornerstonejs/tools';
import { getRenderingEngines } from '@cornerstonejs/core';
import {
  OVI_SEGMENTATION_LABELS,
  clearOviSegmentPixels,
  setOviSegmentOpacity,
  setOviSegmentVisibility,
  syncAllDerivedContoursFromSegmentation,
  syncDerivedContoursFromSegmentation,
} from './oviSegmentation';

export const SEGMENTATION_LABELS = OVI_SEGMENTATION_LABELS.map(({ id, name, color }) => ({
  id,
  name,
  color,
})) as const;

// Use string instead of fixed union to support dynamic models from backend
export type ModelType = string;

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
  labelsByModel: Record<string, SegmentationLabel[]>; // Dynamic models support
}

// Helper to ensure model exists in labelsByModel
const ensureModelInState = (model: string): void => {
  if (!currentState.labelsByModel[model]) {
    currentState.labelsByModel[model] = [];
  }
};

// Initial state - only manual is guaranteed
let currentState: SegmentationState = {
  activeModel: 'manual',
  labels: [],
  labelsByModel: {
    manual: [],
  },
};
const DEFAULT_LABEL_OPACITY = 0.2;

const applyHiddenDerivedContourStyle = (annotationUID: string): void => {
  annotation.config.style.setAnnotationStyles(annotationUID, {
    color: 'transparent',
    colorHighlighted: 'transparent',
    colorSelected: 'transparent',
    fillColor: 'transparent',
    fillOpacity: 0,
    renderFill: false,
  });
};

const isDerivedContourAnnotation = (annotationObj: any): boolean =>
  annotationObj?.data?.derivedFromSegmentation === true;

type Subscriber = (state: SegmentationState) => void;
const subscribers: Set<Subscriber> = new Set();
type SegmentationMutationContext = {
  servicesManager?: any;
  viewportId?: string;
};

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
  Object.keys(labelsByModel).forEach(method => {
    const labels = labelsByModel[method] || [];
    labels.forEach(label => {
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
  ensureModelInState(model); // Ensure model exists in state

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
      if (isDerivedContourAnnotation(annotationObj)) {
        annotationObj.isVisible = false;
        if (annotationObj.data) {
          annotationObj.data.fillOpacity = 0;
          annotationObj.data.renderFill = false;
        }
        applyHiddenDerivedContourStyle(annotationUID);
        return;
      }

      // Set visibility on the annotation object
      annotationObj.isVisible = visible;

      // Also use style API to control visibility via opacity
      // When hidden, set fully transparent color
      if (!visible) {
        if (annotationObj.data) {
          annotationObj.data.fillOpacity = 0;
          annotationObj.data.renderFill = false;
        }
        annotation.config.style.setAnnotationStyles(annotationUID, {
          color: 'transparent',
          colorHighlighted: 'transparent',
          colorSelected: 'transparent',
          fillOpacity: 0,
          renderFill: false,
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
      if (isDerivedContourAnnotation(annotationObj)) {
        annotationObj.isVisible = false;
        if (annotationObj.data) {
          annotationObj.data.fillOpacity = 0;
          annotationObj.data.renderFill = false;
        }
        applyHiddenDerivedContourStyle(annotationUID);
        return;
      }

      // Ensure annotation is visible
      annotationObj.isVisible = true;
      if (annotationObj.data) {
        annotationObj.data.fillColor = color;
        annotationObj.data.fillOpacity = opacity;
        annotationObj.data.renderFill = opacity > 0;
      }

      // Restore visible contour styling and use opacity for the interior fill.
      setContourOpacity(annotationUID, color, opacity);
    }
  } catch (e) {
    console.warn('Failed to show contour:', e);
  }
};

// Helper to set contour opacity via style
const setContourOpacity = (annotationUID: string, color: string, opacity: number): void => {
  try {
    const annotationObj = annotation.state.getAnnotation(annotationUID);
    if (isDerivedContourAnnotation(annotationObj)) {
      if (annotationObj?.data) {
        annotationObj.data.fillColor = 'transparent';
        annotationObj.data.fillOpacity = 0;
        annotationObj.data.renderFill = false;
      }
      applyHiddenDerivedContourStyle(annotationUID);
      return;
    }

    if (annotationObj?.data) {
      annotationObj.data.fillColor = color;
      annotationObj.data.fillOpacity = opacity;
      annotationObj.data.renderFill = opacity > 0;
    }
    annotation.config.style.setAnnotationStyles(annotationUID, {
      color,
      colorHighlighted: color,
      colorSelected: color,
      fillColor: color,
      fillOpacity: opacity,
      renderFill: opacity > 0,
    });
  } catch (e) {
    console.warn('Failed to set contour opacity:', e);
  }
};

// Set label visibility - syncs with actual contours (all time frames)
export const setLabelVisibility = (
  labelId: string,
  visible: boolean,
  context: SegmentationMutationContext = {}
): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const label = labelsForModel.find(l => l.id === labelId);
  if (!label) return;

  const updatedLabelsByModel = Object.fromEntries(
    Object.entries(currentState.labelsByModel).map(([modelKey, modelLabels]) => [
      modelKey,
      modelLabels.map(existingLabel =>
        existingLabel.id === labelId ? { ...existingLabel, visible } : existingLabel
      ),
    ])
  );

  currentState = {
    ...currentState,
    labels: updatedLabelsByModel[activeModel] || [],
    labelsByModel: updatedLabelsByModel,
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

  if (context.servicesManager) {
    void setOviSegmentVisibility({
      servicesManager: context.servicesManager,
      viewportId: context.viewportId,
      labelId,
      visible,
    });
  }

  notifySubscribers();
};

// Set label opacity - syncs with actual contours (all time frames)
export const setLabelOpacity = (
  labelId: string,
  opacity: number,
  context: SegmentationMutationContext = {}
): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const label = labelsForModel.find(l => l.id === labelId);
  if (!label) return;

  const updatedLabelsByModel = Object.fromEntries(
    Object.entries(currentState.labelsByModel).map(([modelKey, modelLabels]) => [
      modelKey,
      modelLabels.map(existingLabel =>
        existingLabel.id === labelId ? { ...existingLabel, opacity } : existingLabel
      ),
    ])
  );

  currentState = {
    ...currentState,
    labels: updatedLabelsByModel[activeModel] || [],
    labelsByModel: updatedLabelsByModel,
  };

  // Update actual contour opacity for all time frames
  if (label.annotations.length > 0 && currentState.activeModel === activeModel) {
    label.annotations.forEach(ref => {
      setContourOpacity(ref.annotationUID, label.color, opacity);
    });
    triggerRender();
  }

  if (context.servicesManager) {
    void setOviSegmentOpacity({
      servicesManager: context.servicesManager,
      viewportId: context.viewportId,
      labelId,
      opacity,
    });
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
export const deleteAllTimePoints = (
  labelId: string,
  context: SegmentationMutationContext = {}
): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const label = labelsForModel.find(l => l.id === labelId);
  if (!label) return;

  if (context.servicesManager) {
    void clearOviSegmentPixels({
      servicesManager: context.servicesManager,
      viewportId: context.viewportId,
      labelId,
    }).then(() =>
      syncAllDerivedContoursFromSegmentation({
        servicesManager: context.servicesManager,
        viewportId: context.viewportId,
      })
    );
  } else {
    // Remove all annotations for this label
    label.annotations.forEach(ref => {
      removeAnnotation(ref.annotationUID);
    });
  }

  // Remove label from state
  const updatedLabelsByModel = Object.fromEntries(
    Object.entries(currentState.labelsByModel).map(([modelKey, modelLabels]) => [
      modelKey,
      modelLabels.filter(existingLabel => existingLabel.id !== labelId),
    ])
  );
  currentState = {
    ...currentState,
    labels: updatedLabelsByModel[activeModel] || [],
    labelsByModel: updatedLabelsByModel,
  };

  // Force immediate viewport update
  setTimeout(() => {
    triggerRender();
  }, 10);

  notifySubscribers();
};

// Delete current time point for a label - removes only the contour on the specified frame
export const deleteCurrentTimePoint = (
  labelId: string,
  referencedImageId: string,
  context: SegmentationMutationContext = {}
): void => {
  const activeModel = currentState.activeModel;
  const labelsForModel = currentState.labelsByModel[activeModel] || [];
  const labelIndex = labelsForModel.findIndex(l => l.id === labelId);
  if (labelIndex === -1) return;

  const label = labelsForModel[labelIndex];

  // Find the annotation for this specific time frame
  const annotationRef = label.annotations.find(ref => ref.referencedImageId === referencedImageId);
  if (!annotationRef) return;

  if (context.servicesManager) {
    void clearOviSegmentPixels({
      servicesManager: context.servicesManager,
      viewportId: context.viewportId,
      labelId,
      referencedImageId,
    }).then(() =>
      syncDerivedContoursFromSegmentation({
        servicesManager: context.servicesManager,
        viewportId: context.viewportId,
        referencedImageId,
      })
    );
  } else {
    // Remove the annotation
    removeAnnotation(annotationRef.annotationUID);
  }

  const updatedAnnotations = label.annotations.filter(ref => ref.referencedImageId !== referencedImageId);
  const updatedLabelsByModel = Object.fromEntries(
    Object.entries(currentState.labelsByModel).map(([modelKey, modelLabels]) => [
      modelKey,
      updatedAnnotations.length === 0
        ? modelLabels.filter(existingLabel => existingLabel.id !== labelId)
        : modelLabels.map(existingLabel =>
            existingLabel.id === labelId
              ? { ...existingLabel, annotations: updatedAnnotations }
              : existingLabel
          ),
    ])
  );
  currentState = {
    ...currentState,
    labels: updatedLabelsByModel[activeModel] || [],
    labelsByModel: updatedLabelsByModel,
  };

  // Force immediate viewport update
  setTimeout(() => {
    triggerRender();
  }, 10);

  notifySubscribers();
};

// Backward compatibility - delete all time points
export const deleteLabel = deleteAllTimePoints;

// Sync labels from ManualContour annotations
// Derived contours now mirror a single canonical OHIF labelmap, so we flatten
// any model-specific contour metadata into one shared anatomical label set.
export const syncLabelsFromAnnotations = (contours: any[]): void => {
  const labelsById = new Map<string, AnnotationReference[]>();

  for (const contour of contours) {
    const labelId = contour?.data?.labelId;
    if (!labelId) continue;

    const labelDef = SEGMENTATION_LABELS.find(l => l.id === labelId);
    if (!labelDef) continue;

    const referencedImageId = contour.metadata?.referencedImageId;
    const annotationRef: AnnotationReference = {
      annotationUID: contour.annotationUID,
      referencedImageId,
    };

    if (!labelsById.has(labelId)) {
      labelsById.set(labelId, []);
    }

    const existingRefs = labelsById.get(labelId)!;
    const existingForFrame = existingRefs.find(ref => ref.referencedImageId === referencedImageId);
    if (!existingForFrame) {
      existingRefs.push(annotationRef);
    }
  }

  const buildLabelsForModel = (modelType: string): SegmentationLabel[] =>
    Array.from(labelsById.entries())
      .map(([labelId, annotationRefs]) => {
        const labelDef = SEGMENTATION_LABELS.find(l => l.id === labelId);
        if (!labelDef) {
          return null;
        }

        const firstContour = contours.find(c => c.annotationUID === annotationRefs[0]?.annotationUID);
        const existingLabel =
          currentState.labelsByModel[modelType]?.find(l => l.id === labelId) ||
          currentState.labels.find(l => l.id === labelId);

        return {
          id: labelId,
          name: labelDef.name,
          color: firstContour?.data?.labelColor || labelDef.color,
          visible: existingLabel?.visible ?? true,
          opacity: existingLabel?.opacity ?? firstContour?.data?.fillOpacity ?? DEFAULT_LABEL_OPACITY,
          annotations: annotationRefs,
          method: modelType,
        };
      })
      .filter((label): label is SegmentationLabel => Boolean(label))
      .sort((a, b) => {
        const indexA = SEGMENTATION_LABELS.findIndex(l => l.id === a.id);
        const indexB = SEGMENTATION_LABELS.findIndex(l => l.id === b.id);
        return indexA - indexB;
      });

  const modelNames = new Set([
    ...Object.keys(currentState.labelsByModel),
    currentState.activeModel,
    'manual',
  ]);
  const newLabelsByModel: Record<string, SegmentationLabel[]> = {};
  modelNames.forEach(modelType => {
    newLabelsByModel[modelType] = buildLabelsForModel(modelType);
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
      manual: [], // Only manual is guaranteed
    },
  };
  notifySubscribers();
};
