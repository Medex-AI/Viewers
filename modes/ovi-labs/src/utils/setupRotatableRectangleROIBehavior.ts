import { eventTarget, getEnabledElementByIds, metaData } from '@cornerstonejs/core';
import { annotation, Enums } from '@cornerstonejs/tools';

const TOOL_NAME = 'RotatableRectangleROI';
const TOOL_GROUP_ID = 'default';
const MEDEX_ORANGE = 'rgb(237, 137, 54)';

export default function setupRotatableRectangleROIBehavior() {
  const toolGroupStyles = annotation.config.style.getToolGroupToolStyles(TOOL_GROUP_ID) || {};
  const toolSpecificStyles = toolGroupStyles[TOOL_NAME] || {};

  annotation.config.style.setToolGroupToolStyles(TOOL_GROUP_ID, {
    ...toolGroupStyles,
    [TOOL_NAME]: {
      ...toolSpecificStyles,
      color: MEDEX_ORANGE,
      colorHighlighted: MEDEX_ORANGE,
      colorSelected: MEDEX_ORANGE,
      textBoxColor: MEDEX_ORANGE,
      textBoxColorHighlighted: MEDEX_ORANGE,
      textBoxColorSelected: MEDEX_ORANGE,
      textBoxVisibility: true,
    },
  });

  const onAnnotationAdded = evt => {
    const { annotation: newAnnotation } = evt.detail || {};

    if (newAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    const { viewportId, renderingEngineId } = evt.detail || {};

    if (viewportId && renderingEngineId) {
      const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
      const viewport = enabledElement?.viewport;
      const imageIds = viewport?.getImageIds?.();

      if (Array.isArray(imageIds) && imageIds.length > 1) {
        const [firstImageId] = imageIds;
        const lastImageId = imageIds[imageIds.length - 1];

        newAnnotation.metadata.referencedImageId = firstImageId;
        delete newAnnotation.metadata.referencedImageURI;
        newAnnotation.metadata.multiSliceReference = {
          referencedImageId: lastImageId,
        };

        // Store SeriesInstanceUID to ensure ROI is unique per series
        const instance = metaData.get('instance', firstImageId);
        if (instance?.SeriesInstanceUID) {
          newAnnotation.metadata.SeriesInstanceUID = instance.SeriesInstanceUID;
        }
      }
    }

    annotation.config.style.setAnnotationStyles(newAnnotation.annotationUID, {
      color: MEDEX_ORANGE,
      colorHighlighted: MEDEX_ORANGE,
      colorSelected: MEDEX_ORANGE,
      textBoxColor: MEDEX_ORANGE,
      textBoxColorHighlighted: MEDEX_ORANGE,
      textBoxColorSelected: MEDEX_ORANGE,
      textBoxVisibility: true,
    });

    const frameOfReferenceUID = newAnnotation.metadata?.FrameOfReferenceUID;
    const newSeriesInstanceUID = newAnnotation.metadata?.SeriesInstanceUID;
    const annotationManager = annotation.state.getAnnotationManager();

    if (!frameOfReferenceUID || !annotationManager) {
      return;
    }

    const existingAnnotations =
      annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];

    // Only remove existing ROIs from the SAME series (not all ROIs in the frame of reference)
    existingAnnotations.forEach(existingAnnotation => {
      if (existingAnnotation.annotationUID === newAnnotation.annotationUID) {
        return;
      }

      const existingSeriesUID = existingAnnotation.metadata?.SeriesInstanceUID;

      // Remove if:
      // 1. Both have SeriesInstanceUID and they match (same series, replace old ROI)
      // 2. New annotation has no SeriesInstanceUID (legacy behavior)
      // 3. Existing annotation has no SeriesInstanceUID and neither does the new one
      const shouldRemove =
        !newSeriesInstanceUID ||
        !existingSeriesUID ||
        existingSeriesUID === newSeriesInstanceUID;

      if (shouldRemove) {
        annotation.state.removeAnnotation(existingAnnotation.annotationUID);
      }
    });
  };

  eventTarget.addEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);

  return () => {
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
  };
}
