import { eventTarget, getEnabledElementByIds } from '@cornerstonejs/core';
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
      textBoxVisibility: false,
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
      }
    }

    annotation.config.style.setAnnotationStyles(newAnnotation.annotationUID, {
      color: MEDEX_ORANGE,
      colorHighlighted: MEDEX_ORANGE,
      colorSelected: MEDEX_ORANGE,
      textBoxVisibility: false,
    });

    const frameOfReferenceUID = newAnnotation.metadata?.FrameOfReferenceUID;
    const annotationManager = annotation.state.getAnnotationManager();

    if (!frameOfReferenceUID || !annotationManager) {
      return;
    }

    const existingAnnotations =
      annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];

    existingAnnotations.forEach(existingAnnotation => {
      if (existingAnnotation.annotationUID !== newAnnotation.annotationUID) {
        annotation.state.removeAnnotation(existingAnnotation.annotationUID);
      }
    });
  };

  eventTarget.addEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);

  return () => {
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
  };
}
