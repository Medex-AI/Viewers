import { eventTarget } from '@cornerstonejs/core';
import { annotation, Enums } from '@cornerstonejs/tools';
import ManualContourLabelMenu from '../components/ManualContourLabelMenu';

const TOOL_NAME = 'ManualContour';
const TOOL_GROUP_ID = 'default';
const LABELS = [
  { id: 'uterineCavity', label: 'Uterine cavity', color: '#22D3EE' },
  { id: 'endometrium', label: 'Endometrium', color: '#F472B6' },
  { id: 'myometrium', label: 'Myometrium', color: '#FBBF24' },
  { id: 'cervixCavity', label: 'Cervix cavity', color: '#60A5FA' },
];

let activeLabelId = LABELS[0].id;

const getLabelConfig = labelId => LABELS.find(label => label.id === labelId) || LABELS[0];

const lightenHexColor = (hexColor: string, ratio = 0.35) => {
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) {
    return hexColor;
  }

  const num = parseInt(hex, 16);
  const r = Math.min(255, Math.round(((num >> 16) & 0xff) * (1 - ratio) + 255 * ratio));
  const g = Math.min(255, Math.round(((num >> 8) & 0xff) * (1 - ratio) + 255 * ratio));
  const b = Math.min(255, Math.round((num & 0xff) * (1 - ratio) + 255 * ratio));

  return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
};

const updateToolButtonColor = (color: string) => {
  // Update the toolbar button color to match the active label
  if (typeof window === 'undefined') {
    return;
  }

  const toolButton = window.document?.querySelector(`[data-tool="${TOOL_NAME}"]`);
  if (toolButton instanceof HTMLElement) {
    // Find the button element (could be nested)
    const buttonElement = toolButton.querySelector('button') || toolButton;
    if (buttonElement instanceof HTMLElement) {
      // Apply the color as a border and subtle background when active
      buttonElement.style.setProperty('border', `2px solid ${color}`, 'important');
      if (toolButton.getAttribute('data-active') === 'true') {
        buttonElement.style.setProperty('background-color', `${color}20`, 'important');
      }
    }
  }
};

const applyToolGroupStyle = labelId => {
  const { color } = getLabelConfig(labelId);
  const highlightColor = lightenHexColor(color);
  const toolGroupStyles = annotation.config.style.getToolGroupToolStyles(TOOL_GROUP_ID) || {};
  const toolSpecificStyles = toolGroupStyles[TOOL_NAME] || {};

  annotation.config.style.setToolGroupToolStyles(TOOL_GROUP_ID, {
    ...toolGroupStyles,
    [TOOL_NAME]: {
      ...toolSpecificStyles,
      color,
      colorHighlighted: highlightColor,
      colorSelected: highlightColor,
    },
  });

  // Update the toolbar button color
  updateToolButtonColor(color);
};

const applyAnnotationStyle = (annotationUID, labelId) => {
  const { color } = getLabelConfig(labelId);
  const highlightColor = lightenHexColor(color);
  annotation.config.style.setAnnotationStyles(annotationUID, {
    color,
    colorHighlighted: highlightColor,
    colorSelected: highlightColor,
  });
};

const promptForLabel = uiDialogService => {
  if (!uiDialogService) {
    return;
  }

  const panelWidth = 240;
  const margin = 16;
  const defaultPosition =
    typeof window !== 'undefined'
      ? (() => {
          const toolButton = window.document?.querySelector(`[data-tool="${TOOL_NAME}"]`);
          if (toolButton instanceof HTMLElement) {
            const rect = toolButton.getBoundingClientRect();
            const x = Math.min(
              window.innerWidth - panelWidth - margin,
              Math.max(margin, rect.left + rect.width / 2 - panelWidth / 2)
            );
            const y = Math.min(window.innerHeight - margin, rect.bottom + 8);
            return { x, y };
          }

          return {
            x: Math.max(margin, window.innerWidth - panelWidth - margin),
            y: 96,
          };
        })()
      : undefined;

  uiDialogService.hide('manual-contour-label');
  uiDialogService.show({
    id: 'manual-contour-label',
    title: '',
    content: ManualContourLabelMenu,
    unstyled: true,
    showOverlay: false,
    shouldCloseOnOverlayClick: true,
    shouldCloseOnEsc: true,
    containerClassName: 'shadow-none',
    defaultPosition,
    contentProps: {
      labelData: LABELS.map(item => ({ label: item.label, value: item.id })),
      initialLabel: activeLabelId,
      onSelect: value => {
        if (!value) {
          return;
        }
        activeLabelId = value;
        applyToolGroupStyle(activeLabelId);
      },
    },
  });
};

export default function setupManualContourBehavior(servicesManager: AppTypes.ServicesManager) {
  const { uiDialogService } = servicesManager.services;

  applyToolGroupStyle(activeLabelId);

  const onToolActivated = evt => {
    const { toolGroupId, toolName } = evt.detail || {};
    if (toolGroupId === TOOL_GROUP_ID && toolName === TOOL_NAME) {
      promptForLabel(uiDialogService);
      // Update button color when tool is activated
      setTimeout(() => {
        const { color } = getLabelConfig(activeLabelId);
        updateToolButtonColor(color);
      }, 100);
    }
  };

  const onAnnotationAdded = evt => {
    const { annotation: newAnnotation } = evt.detail || {};

    if (newAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    const labelId = newAnnotation.data?.labelId || activeLabelId;
    const labelConfig = getLabelConfig(labelId);

    // Add timestamp for overlap resolution (last-edited wins)
    const now = Date.now();
    newAnnotation.data = {
      ...newAnnotation.data,
      labelId,
      labelName: labelConfig.label,
      labelColor: labelConfig.color,
      createdAt: now,
      modifiedAt: now,
    };

    applyAnnotationStyle(newAnnotation.annotationUID, labelId);

    const frameOfReferenceUID = newAnnotation.metadata?.FrameOfReferenceUID;
    const annotationManager = annotation.state.getAnnotationManager();

    if (!frameOfReferenceUID || !annotationManager) {
      return;
    }

    const existingAnnotations =
      annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];

    existingAnnotations.forEach(existingAnnotation => {
      if (
        existingAnnotation.annotationUID !== newAnnotation.annotationUID &&
        existingAnnotation.data?.labelId === labelId
      ) {
        annotation.state.removeAnnotation(existingAnnotation.annotationUID);
      }
    });
  };

  const onAnnotationModified = evt => {
    const { annotation: modifiedAnnotation } = evt.detail || {};

    if (modifiedAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    // Update modification timestamp when annotation is edited
    if (modifiedAnnotation.data) {
      modifiedAnnotation.data.modifiedAt = Date.now();
    }
  };

  eventTarget.addEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_MODIFIED, onAnnotationModified);

  return () => {
    eventTarget.removeEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_MODIFIED, onAnnotationModified);
  };
}
