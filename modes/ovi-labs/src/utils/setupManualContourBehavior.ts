import {
  eventTarget,
  getEnabledElement,
  getEnabledElementByIds,
  utilities as csUtils,
  Enums as CoreEnums,
} from '@cornerstonejs/core';
import { annotation, Enums, utilities } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';
import ManualContourLabelMenu from '../components/ManualContourLabelMenu';
import {
  ensureOviSegmentationForViewport,
  getOviSegmentationIdForDisplaySet,
  getOviSegmentIndexForLabelId,
  readActiveSegmentationFrames,
  syncDerivedContoursFromSegmentation,
  writeMaskToActiveSegmentation,
  writeContourToActiveSegmentation,
  OVI_SEGMENTATION_LABELS,
} from '../../../../extensions/ovi-labs/src/utils/oviSegmentation';
import {
  deleteSegmentationFrame,
  loadSegmentationFrames,
  saveSegmentationFrame,
} from '../../../../extensions/ovi-labs/src/utils/segmentationPersistence';
import {
  getContrastColor,
  hexToRgba255,
  lightenHexColor,
} from '../../../../extensions/ovi-labs/src/utils/colorUtils';

const TOOL_NAME = 'ManualContour';
const BRUSH_TOOL_NAME = 'CircularBrush';
const ERASER_TOOL_NAME = 'CircularEraser';
const TOOL_GROUP_ID = 'default';
const CONTOUR_LINE_WIDTH = '2';
const DEFAULT_FILL_OPACITY = 0.2;
const LABELS = OVI_SEGMENTATION_LABELS.map(({ id, name, color }) => ({
  id,
  label: name,
  color,
}));
const ERASER_LABEL = { id: 'eraser', label: 'Eraser', color: '#FFFFFF' };
const LABEL_OPTIONS = [ERASER_LABEL, ...LABELS];
const BRUSH_TOOL_NAMES = [BRUSH_TOOL_NAME, ERASER_TOOL_NAME];
const DEFAULT_BRUSH_SIZE = 3;
const BRUSH_SIZE_MIN = 0.5;
const BRUSH_SIZE_MAX = 99.5;
const { segmentation: segmentationUtils } = utilities as typeof utilities & {
  segmentation?: {
    getBrushSizeForToolGroup?: (toolGroupId: string) => number;
    setBrushSizeForToolGroup?: (toolGroupId: string, brushSize: number, toolName?: string) => void;
    invalidateBrushCursor?: (toolGroupId: string) => void;
  };
};

let activeLabelId = LABELS[0].id;
let isManualContourActive = false;
let activeViewportHintTargets: HTMLElement[] = [];
let currentBrushSize = DEFAULT_BRUSH_SIZE;
let brushCursorOverlay: HTMLDivElement | null = null;
let gestureHudOverlay: HTMLDivElement | null = null;
let currentCanvasPxPerMm: number | null = null;
let lastNonEraserLabelId = LABELS[0].id;
let currentBrushPointerType: string | null = null;
let saveTimeoutBySegmentationId = new Map<string, number>();
let restoredSegmentationKeys = new Set<string>();

const OVI_CANVAS_SCALE_EVENT = 'ovi-canvas-scale-change';
const OVI_ACTIVE_LABEL_EVENT = 'ovi-set-active-label';

const pushOviBrushDebug = (message: string, details?: Record<string, unknown>) => {
  if (typeof window === 'undefined') {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    message,
    ...(details || {}),
  };

  const debugWindow = window as Window & {
    __oviBrushDebugLog?: Array<Record<string, unknown>>;
    __oviBrushDebugLast?: Record<string, unknown>;
  };

  debugWindow.__oviBrushDebugLog = debugWindow.__oviBrushDebugLog || [];
  debugWindow.__oviBrushDebugLog.push(payload);
  debugWindow.__oviBrushDebugLast = payload;
  console.debug('[OVI Brush Debug]', payload);
};

const computeCanvasPxPerMm = (element: HTMLElement): number | null => {
  try {
    const enabledEl = getEnabledElement(element);
    const camera = (enabledEl?.viewport as any)?.getCamera?.();
    if (!camera?.parallelScale || !element.clientHeight) {
      return null;
    }
    return element.clientHeight / (camera.parallelScale * 2);
  } catch {
    return null;
  }
};
const isTouchCapableDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

const shouldUseNativeBrushCursor = () => {
  // Temporary demo workaround:
  // on tablet + stylus we force the non-native OVI brush cursor path because
  // the native Cornerstone brush cursor does not currently behave correctly.
  // The proper fix should map stylus behavior to the same hover/cursor lifecycle
  // as desktop pointer hover instead of branching cursor implementations here.
  return !(isTouchCapableDevice() && currentBrushPointerType === 'pen');
};

const getLabelConfig = labelId => LABEL_OPTIONS.find(label => label.id === labelId) || LABELS[0];

export const getActiveManualContourLabelId = () => activeLabelId;

const isEraserLabelId = (labelId?: string) => labelId === ERASER_LABEL.id;

export const setActiveManualContourLabelId = (
  labelId: string,
  servicesManager?: AppTypes.ServicesManager,
  sourceToolName = TOOL_NAME
) => {
  if (!labelId) {
    return;
  }

  if (servicesManager) {
    return updateActiveLabel(labelId, servicesManager, sourceToolName);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(OVI_ACTIVE_LABEL_EVENT, {
        detail: {
          labelId,
          sourceToolName,
          _isFromTool: true,
        },
      })
    );
  }

  return undefined;
};

const setGlobalActiveManualContourLabelId = (labelId: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  (window as Window & { __oviActiveManualContourLabelId?: string }).__oviActiveManualContourLabelId =
    labelId;
};

const clampBrushSize = (value: number) =>
  Math.min(BRUSH_SIZE_MAX, Math.max(BRUSH_SIZE_MIN, Number(value) || DEFAULT_BRUSH_SIZE));

const getBrushSize = () => {
  const brushSize = segmentationUtils?.getBrushSizeForToolGroup?.(TOOL_GROUP_ID);
  if (typeof brushSize === 'number' && !Number.isNaN(brushSize)) {
    currentBrushSize = clampBrushSize(brushSize);
  }

  return currentBrushSize;
};

const setBrushSize = (value: number) => {
  const brushSize = clampBrushSize(value);
  currentBrushSize = brushSize;
  BRUSH_TOOL_NAMES.forEach(toolName => {
    segmentationUtils?.setBrushSizeForToolGroup?.(TOOL_GROUP_ID, brushSize, toolName);
  });
};

const ensureBrushCursorOverlay = () => {
  if (shouldUseNativeBrushCursor()) {
    return null;
  }

  if (typeof document === 'undefined') {
    return null;
  }

  if (!brushCursorOverlay) {
    brushCursorOverlay = document.createElement('div');
    brushCursorOverlay.className = 'ovi-brush-cursor-overlay';
    brushCursorOverlay.style.position = 'fixed';
    brushCursorOverlay.style.pointerEvents = 'none';
    brushCursorOverlay.style.borderRadius = '9999px';
    brushCursorOverlay.style.borderStyle = 'solid';
    brushCursorOverlay.style.borderWidth = '2px';
    brushCursorOverlay.style.boxSizing = 'border-box';
    brushCursorOverlay.style.transform = 'translate(-50%, -50%)';
    brushCursorOverlay.style.outline = 'none';
    brushCursorOverlay.style.boxShadow = 'none';
    brushCursorOverlay.style.background = 'transparent';
    brushCursorOverlay.style.zIndex = '2147483647';
    brushCursorOverlay.style.display = 'none';
    document.body.appendChild(brushCursorOverlay);
  }

  return brushCursorOverlay;
};

const hideBrushCursorOverlay = () => {
  if (shouldUseNativeBrushCursor()) {
    return;
  }

  if (brushCursorOverlay) {
    brushCursorOverlay.style.display = 'none';
  }
};

const ensureGestureHudOverlay = () => {
  if (typeof document === 'undefined') {
    return null;
  }

  if (!gestureHudOverlay) {
    gestureHudOverlay = document.createElement('div');
    gestureHudOverlay.className = 'ovi-pencil-gesture-hud';
    gestureHudOverlay.style.position = 'fixed';
    gestureHudOverlay.style.top = '20px';
    gestureHudOverlay.style.left = '50%';
    gestureHudOverlay.style.transform = 'translateX(-50%)';
    gestureHudOverlay.style.padding = '8px 12px';
    gestureHudOverlay.style.borderRadius = '9999px';
    gestureHudOverlay.style.background = 'rgba(15, 23, 42, 0.9)';
    gestureHudOverlay.style.color = '#F8FAFC';
    gestureHudOverlay.style.fontSize = '12px';
    gestureHudOverlay.style.fontWeight = '600';
    gestureHudOverlay.style.pointerEvents = 'none';
    gestureHudOverlay.style.zIndex = '2147483647';
    gestureHudOverlay.style.display = 'none';
    document.body.appendChild(gestureHudOverlay);
  }

  return gestureHudOverlay;
};

const showGestureHud = (message: string) => {
  const hud = ensureGestureHudOverlay();
  if (!hud) {
    return;
  }

  hud.textContent = message;
  hud.style.display = 'block';
  window.setTimeout(() => {
    if (hud.textContent === message) {
      hud.style.display = 'none';
    }
  }, 1200);
};

const restoreViewportCursor = () => {
  if (typeof document === 'undefined') {
    return;
  }

  document.querySelectorAll('[data-viewport-uid]').forEach(viewport => {
    if (viewport instanceof HTMLElement) {
      viewport.style.removeProperty('cursor');
    }
  });
};

const getViewportElementAtPoint = (clientX: number, clientY: number): HTMLElement | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const el = document.elementFromPoint(clientX, clientY);
  if (!el) {
    return null;
  }

  const viewport = el.closest('[data-viewport-uid]');
  return viewport instanceof HTMLElement ? viewport : null;
};

const syncBrushCursorOverlay = (
  element?: HTMLElement,
  canvasPoint?: { x?: number; y?: number } | number[]
) => {
  if (shouldUseNativeBrushCursor()) {
    hideBrushCursorOverlay();
    return;
  }

  const overlay = ensureBrushCursorOverlay();
  if (!overlay || !element || !canvasPoint) {
    hideBrushCursorOverlay();
    return;
  }

  const x = Array.isArray(canvasPoint) ? canvasPoint[0] : canvasPoint.x;
  const y = Array.isArray(canvasPoint) ? canvasPoint[1] : canvasPoint.y;
  if (typeof x !== 'number' || typeof y !== 'number') {
    hideBrushCursorOverlay();
    return;
  }

  if (x < 0 || y < 0 || x > element.clientWidth || y > element.clientHeight) {
    hideBrushCursorOverlay();
    return;
  }

  const pxPerMm = computeCanvasPxPerMm(element) ?? currentCanvasPxPerMm ?? 1;
  currentCanvasPxPerMm = pxPerMm;

  const rect = element.getBoundingClientRect();
  const { color } = getLabelConfig(activeLabelId);
  const diameter = Math.max(8, getBrushSize() * 2 * pxPerMm);

  overlay.style.display = 'block';
  overlay.style.left = `${rect.left + x}px`;
  overlay.style.top = `${rect.top + y}px`;
  overlay.style.width = `${diameter}px`;
  overlay.style.height = `${diameter}px`;
  overlay.style.borderColor = color;
  overlay.style.backgroundColor = 'transparent';
};

const syncBrushCursorOverlayAtClient = (clientX: number, clientY: number) => {
  if (shouldUseNativeBrushCursor()) {
    hideBrushCursorOverlay();
    return;
  }

  const overlay = ensureBrushCursorOverlay();
  if (!overlay) {
    return;
  }

  const viewportEl = getViewportElementAtPoint(clientX, clientY);
  if (!viewportEl) {
    hideBrushCursorOverlay();
    return;
  }

  const pxPerMm = computeCanvasPxPerMm(viewportEl) ?? currentCanvasPxPerMm ?? 1;
  currentCanvasPxPerMm = pxPerMm;

  const { color } = getLabelConfig(activeLabelId);
  const diameter = Math.max(8, getBrushSize() * 2 * pxPerMm);

  overlay.style.display = 'block';
  overlay.style.left = `${clientX}px`;
  overlay.style.top = `${clientY}px`;
  overlay.style.width = `${diameter}px`;
  overlay.style.height = `${diameter}px`;
  overlay.style.borderColor = color;
  overlay.style.backgroundColor = 'transparent';
};

const getToolbarButtonElements = (toolNames: string[]) => {
  if (typeof window === 'undefined') {
    return [];
  }

  return toolNames
    .flatMap(toolName => {
      const toolRoot = window.document.querySelector(`[data-tool="${toolName}"]`);
      if (!(toolRoot instanceof HTMLElement)) {
        return [];
      }

      const innerButton = toolRoot.querySelector('button');
      return [innerButton instanceof HTMLElement ? innerButton : toolRoot];
    })
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
};

const updateToolButtonColor = (
  toolNames: string[],
  color: string,
  isActive: boolean
) => {
  const foregroundColor = getContrastColor(color);
  const buttonElements = getToolbarButtonElements(toolNames);

  buttonElements.forEach(buttonElement => {
    if (isActive) {
      buttonElement.style.setProperty('border', `2px solid ${color}`, 'important');
      buttonElement.style.setProperty('box-shadow', 'none', 'important');
      buttonElement.style.setProperty('background-color', color, 'important');
      buttonElement.style.setProperty('color', foregroundColor, 'important');
    } else {
      buttonElement.style.removeProperty('border');
      buttonElement.style.removeProperty('box-shadow');
      buttonElement.style.removeProperty('background-color');
      buttonElement.style.removeProperty('color');
    }

    buttonElement.querySelectorAll('svg').forEach(icon => {
      if (!(icon instanceof SVGElement || icon instanceof HTMLElement)) {
        return;
      }

      if (isActive) {
        icon.style.setProperty('color', foregroundColor, 'important');
      } else {
        icon.style.removeProperty('color');
      }
    });
  });
};

const syncToolbarButtonColors = servicesManager => {
  const { color } = getLabelConfig(activeLabelId);
  const toolGroupService = servicesManager?.services?.toolGroupService;
  const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);

  updateToolButtonColor([TOOL_NAME], color, activeTool === TOOL_NAME);
  updateToolButtonColor([BRUSH_TOOL_NAME, ERASER_TOOL_NAME, 'Brush'], color, BRUSH_TOOL_NAMES.includes(activeTool));
};

const applyToolGroupStyle = labelId => {
  const { color } = getLabelConfig(labelId);
  const highlightColor = lightenHexColor(color);
  const toolGroupStyles = annotation.config.style.getToolGroupToolStyles(TOOL_GROUP_ID) || {};
  const toolSpecificStyles = toolGroupStyles[TOOL_NAME] || {};

  const brushCursorStyle = {
    color,
    colorHighlighted: color,
    colorSelected: color,
    lineWidth: CONTOUR_LINE_WIDTH,
    fillColor: color,
    fillOpacity: 0,
    renderFill: false,
  };

  annotation.config.style.setToolGroupToolStyles(TOOL_GROUP_ID, {
    ...toolGroupStyles,
    [TOOL_NAME]: {
      ...toolSpecificStyles,
      color,
      colorHighlighted: highlightColor,
      colorSelected: highlightColor,
      lineWidth: CONTOUR_LINE_WIDTH,
      fillColor: color,
      fillOpacity: DEFAULT_FILL_OPACITY,
      renderFill: true,
    },
    [BRUSH_TOOL_NAME]: brushCursorStyle,
    [ERASER_TOOL_NAME]: { ...brushCursorStyle, color: ERASER_LABEL.color, colorHighlighted: ERASER_LABEL.color, colorSelected: ERASER_LABEL.color },
  });

  // Update the toolbar buttons to reflect the shared active annotation color.
  syncToolbarButtonColors(undefined);
};

const applyAnnotationStyle = (annotationUID, labelId) => {
  const { color } = getLabelConfig(labelId);
  const highlightColor = lightenHexColor(color);
  annotation.config.style.setAnnotationStyles(annotationUID, {
    color,
    colorHighlighted: highlightColor,
    colorSelected: highlightColor,
    lineWidth: CONTOUR_LINE_WIDTH,
    fillColor: color,
    fillOpacity: DEFAULT_FILL_OPACITY,
    renderFill: true,
  });
};

const updateBrushSegment = async (servicesManager, labelId: string, viewportId?: string) => {
  if (isEraserLabelId(labelId)) {
    pushOviBrushDebug('updateBrushSegment: skipped for eraser', { labelId });
    return;
  }

  const { segmentationService } = servicesManager?.services || {};
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
  const segmentIndex = getOviSegmentIndexForLabelId(labelId);
  const labelConfig = getLabelConfig(labelId);

  if (!context?.viewportId || !context?.segmentationId || !segmentIndex || !segmentationService) {
    pushOviBrushDebug('updateBrushSegment: missing context', {
      labelId,
      requestedViewportId: viewportId,
      segmentIndex,
      hasContext: Boolean(context),
      hasSegmentationService: Boolean(segmentationService),
    });
    return;
  }

  segmentationService.setActiveSegmentation(context.viewportId, context.segmentationId);
  segmentationService.setSegmentColor(
    context.viewportId,
    context.segmentationId,
    segmentIndex,
    hexToRgba255(labelConfig.color)
  );
  segmentationService.setActiveSegment(context.segmentationId, segmentIndex);
  segmentationUtils?.invalidateBrushCursor?.(TOOL_GROUP_ID);
  pushOviBrushDebug('updateBrushSegment: active segment set', {
    labelId,
    labelColor: labelConfig.color,
    requestedViewportId: viewportId,
    viewportId: context.viewportId,
    segmentationId: context.segmentationId,
    segmentIndex,
    activeSegmentation: segmentationService.getActiveSegmentation?.(context.viewportId),
    activeSegmentViewport: segmentationService.getActiveSegment?.(context.viewportId),
    activeSegmentSegmentation: segmentationService.getActiveSegment?.(context.segmentationId),
    resolvedSegmentColor: segmentationService.getSegmentColor?.(
      context.viewportId,
      context.segmentationId,
      segmentIndex
    ),
  });
};

const ensureBrushToolReady = async (
  servicesManager,
  labelId: string,
  sourceToolName: string,
  viewportId?: string
) => {
  pushOviBrushDebug('ensureBrushToolReady: begin', {
    labelId,
    sourceToolName,
    requestedViewportId: viewportId,
    isEraser: isEraserLabelId(labelId),
  });
  if (isEraserLabelId(labelId)) {
    const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);
    pushOviBrushDebug('ensureBrushToolReady: eraser ready', {
      hasSegmentation: Boolean(context),
      requestedViewportId: viewportId,
      viewportId: context?.viewportId,
      segmentationId: context?.segmentationId,
    });
    return {
      canActivate: true,
      toolName: ERASER_TOOL_NAME,
      hasSegmentation: Boolean(context),
    };
  }

  const nextToolName = BRUSH_TOOL_NAMES.includes(sourceToolName) ? BRUSH_TOOL_NAME : sourceToolName;
  const context = await ensureOviSegmentationForViewport(servicesManager, viewportId);

  if (BRUSH_TOOL_NAMES.includes(nextToolName)) {
    if (!context) {
      pushOviBrushDebug('ensureBrushToolReady: no segmentation context', {
        labelId,
        sourceToolName,
        requestedViewportId: viewportId,
        nextToolName,
      });
      return {
        canActivate: false,
        toolName: nextToolName,
        hasSegmentation: false,
      };
    }

    await updateBrushSegment(servicesManager, labelId, viewportId);
  }

  pushOviBrushDebug('ensureBrushToolReady: completed', {
    labelId,
    sourceToolName,
    nextToolName,
    requestedViewportId: viewportId,
    hasSegmentation: Boolean(context),
    viewportId: context?.viewportId,
    segmentationId: context?.segmentationId,
  });
  return {
    canActivate: true,
    toolName: nextToolName,
    hasSegmentation: Boolean(context),
  };
};

const setPrimaryTool = (servicesManager, toolName: string) => {
  const toolGroupService = servicesManager?.services?.toolGroupService;
  const toolGroup = toolGroupService?.getToolGroup?.(TOOL_GROUP_ID);
  if (!toolGroup) {
    pushOviBrushDebug('setPrimaryTool: missing toolGroup', { toolName });
    return;
  }

  try {
    // Deactivate the currently active primary tool first
    const activeToolName = toolGroup.getActivePrimaryMouseButtonTool?.();
    if (activeToolName && activeToolName !== toolName) {
      toolGroup.setToolPassive(activeToolName);
    }
    toolGroup.setToolActive(toolName, {
      bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
    });
    pushOviBrushDebug('setPrimaryTool: activated', { toolName, toolGroupId: TOOL_GROUP_ID });
  } catch (error) {
    pushOviBrushDebug('setPrimaryTool: activation failed', {
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    console.warn(`Failed to activate ${toolName}:`, error);
  }
};

const updateActiveLabel = async (
  labelId,
  servicesManager,
  sourceToolName = TOOL_NAME,
  viewportId?: string
) => {
  pushOviBrushDebug('updateActiveLabel: begin', {
    labelId,
    sourceToolName,
    requestedViewportId: viewportId,
    previousLabelId: activeLabelId,
  });
  activeLabelId = labelId;
  if (!isEraserLabelId(labelId)) {
    lastNonEraserLabelId = labelId;
  }
  setGlobalActiveManualContourLabelId(labelId);
  // Notify the segmentation panel of the active label change (panel → tool direction is separate)
  window?.dispatchEvent?.(
    new CustomEvent(OVI_ACTIVE_LABEL_EVENT, { detail: { labelId, sourceToolName, _isFromTool: true } })
  );
  applyToolGroupStyle(activeLabelId);

  // Immediately recolor the cursor overlay without waiting for the next mouse move
  if (!shouldUseNativeBrushCursor() && brushCursorOverlay && brushCursorOverlay.style.display !== 'none') {
    const { color } = getLabelConfig(labelId);
    brushCursorOverlay.style.borderColor = color;
    brushCursorOverlay.style.backgroundColor = isEraserLabelId(labelId) ? 'transparent' : `${color}26`;
  }

  const brushToolState = await ensureBrushToolReady(
    servicesManager,
    labelId,
    sourceToolName,
    viewportId
  );
  if (brushToolState.canActivate) {
    setPrimaryTool(servicesManager, brushToolState.toolName);
  }
  pushOviBrushDebug('updateActiveLabel: completed', {
    labelId,
    sourceToolName,
    requestedViewportId: viewportId,
    nextToolName: brushToolState.toolName,
    canActivate: brushToolState.canActivate,
    hasSegmentation: brushToolState.hasSegmentation,
  });

  syncToolbarButtonColors(servicesManager);

  // Deselect all annotations so the tool starts a fresh draw rather than
  // editing the previously selected annotation of a different class.
  try {
    const selected = annotation.selection.getAnnotationsSelected?.() || [];
    selected.forEach(uid => annotation.selection.setAnnotationSelected(uid, false));
  } catch {
    // selection API may not be available in all Cornerstone versions
  }
};

const updateAnnotationLabel = (annotationToUpdate, labelId, element) => {
  if (!annotationToUpdate?.data) {
    return;
  }

  const labelConfig = getLabelConfig(labelId);
  const modelType = annotationToUpdate?.data?.modelType || 'manual';
  annotationToUpdate.data = {
    ...annotationToUpdate.data,
    labelId,
    labelName: labelConfig.label,
    labelColor: labelConfig.color,
    fillColor: labelConfig.color,
    fillOpacity: annotationToUpdate.data?.fillOpacity ?? DEFAULT_FILL_OPACITY,
    renderFill: annotationToUpdate.data?.renderFill ?? true,
    modelType,
    modifiedAt: Date.now(),
  };

  applyAnnotationStyle(annotationToUpdate.annotationUID, labelId);
  if (element) {
    const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
      element,
      TOOL_NAME
    );
    utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
  }
  annotation.state.triggerAnnotationModified(
    annotationToUpdate,
    element,
    Enums.ChangeTypes.LabelChange
  );
};

const getActiveViewportContext = servicesManager => {
  const viewportGridService = servicesManager?.services?.viewportGridService;
  const cornerstoneViewportService = servicesManager?.services?.cornerstoneViewportService;
  const state = viewportGridService?.getState?.();
  const activeViewportId = state?.activeViewportId;
  if (!activeViewportId || !cornerstoneViewportService) {
    return {};
  }

  const viewport = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
  const viewportInfo = cornerstoneViewportService.getViewportInfo?.(activeViewportId);
  return {
    activeViewportId,
    viewport,
    element: viewportInfo?.element,
    viewportInfo,
  };
};

const getViewportIdForElement = (element?: HTMLElement | null) => {
  if (!element) {
    return undefined;
  }

  try {
    const enabledElement = getEnabledElement(element);
    return enabledElement?.viewport?.id;
  } catch {
    return undefined;
  }
};

const installBrushFirstUseGuard = (servicesManager: AppTypes.ServicesManager) => {
  const toolGroupService = servicesManager?.services?.toolGroupService;
  const { segmentationService, uiNotificationService } = servicesManager?.services || {};
  const toolGroup = toolGroupService?.getToolGroup?.(TOOL_GROUP_ID);

  if (!toolGroup || !segmentationService) {
    return;
  }

  BRUSH_TOOL_NAMES.forEach(toolName => {
    const toolInstance = toolGroup.getToolInstance?.(toolName) as
      | {
          preMouseDownCallback?: (evt: any) => boolean;
          __oviOriginalPreMouseDownCallback?: (evt: any) => boolean;
          __oviFirstUseGuardInstalled?: boolean;
        }
      | undefined;

    if (!toolInstance || toolInstance.__oviFirstUseGuardInstalled) {
      return;
    }

    const originalPreMouseDown = toolInstance.preMouseDownCallback?.bind(toolInstance);
    toolInstance.__oviOriginalPreMouseDownCallback = originalPreMouseDown;
    toolInstance.__oviFirstUseGuardInstalled = true;

    toolInstance.preMouseDownCallback = evt => {
      const element = evt?.detail?.element as HTMLElement | undefined;
      const viewportId = getViewportIdForElement(element) || getActiveViewportContext(servicesManager)?.activeViewportId;
      const activeSegmentation = viewportId
        ? segmentationService.getActiveSegmentation?.(viewportId)
        : null;

      if (!activeSegmentation?.segmentationId) {
        pushOviBrushDebug('brush first-use guard: initializing segmentation before draw', {
          toolName,
          viewportId,
          activeLabelId,
        });

        void ensureBrushToolReady(servicesManager, activeLabelId, toolName, viewportId).then(state => {
          pushOviBrushDebug('brush first-use guard: initialization finished', {
            toolName,
            viewportId,
            activeLabelId,
            canActivate: state?.canActivate,
            hasSegmentation: state?.hasSegmentation,
            activeSegmentationAfterInit: viewportId
              ? segmentationService.getActiveSegmentation?.(viewportId)
              : null,
            activeSegmentAfterInit: viewportId
              ? segmentationService.getActiveSegment?.(viewportId)
              : null,
            representationsAfterInit:
              viewportId && segmentationService.getActiveSegmentation?.(viewportId)?.segmentationId
                ? segmentationService.getSegmentationRepresentations?.(viewportId, {
                    segmentationId:
                      segmentationService.getActiveSegmentation?.(viewportId)?.segmentationId,
                    type: Enums.SegmentationRepresentations.Labelmap,
                  })
                : null,
          });

          if (state?.canActivate) {
            setPrimaryTool(servicesManager, state.toolName);
          }
        });

        uiNotificationService?.show?.({
          title: 'OVI Labs Segmentation',
          message: 'Preparing the default 4-class segmentation. Click once more when ready.',
          type: 'info',
          duration: 1800,
        });

        evt?.preventDefault?.();
        return true;
      }

      return originalPreMouseDown ? originalPreMouseDown(evt) : undefined;
    };
  });
};

const getManualContourAnnotations = (frameOfReferenceUID?: string) => {
  const annotationManager = annotation.state.getAnnotationManager();
  if (!annotationManager) {
    return [];
  }

  if (frameOfReferenceUID) {
    return annotationManager.getAnnotations(frameOfReferenceUID, TOOL_NAME) || [];
  }

  const frames = annotationManager.getFramesOfReference() || [];
  return frames.flatMap(frame => annotationManager.getAnnotations(frame, TOOL_NAME) || []);
};

const copyContourPoints = (points: number[][] = []) => points.map(point => [...point]);

const createManualContourAnnotation = ({
  sourceAnnotation,
  referencedImageId,
  frameNumber,
  seriesInstanceUID,
  studyInstanceUID,
}) => {
  const contourPoints = copyContourPoints(sourceAnnotation?.data?.contour?.polyline || []);
  const now = Date.now();
  const metadata = {
    ...(sourceAnnotation?.metadata || {}),
    toolName: TOOL_NAME,
  } as Record<string, any>;
  if (referencedImageId) {
    metadata.referencedImageId = referencedImageId;
  }

  return {
    annotationUID: csUtils.uuidv4(),
    highlighted: false,
    isLocked: false,
    isVisible: true,
    invalidated: true,
    metadata,
    data: {
      ...(sourceAnnotation?.data || {}),
      fillColor: sourceAnnotation?.data?.fillColor || sourceAnnotation?.data?.labelColor,
      fillOpacity: sourceAnnotation?.data?.fillOpacity ?? DEFAULT_FILL_OPACITY,
      renderFill: sourceAnnotation?.data?.renderFill ?? true,
      contour: {
        ...(sourceAnnotation?.data?.contour || {}),
        polyline: contourPoints,
      },
      handles: {
        ...(sourceAnnotation?.data?.handles || {}),
        points: contourPoints,
        activeHandleIndex: null,
      },
      createdAt: now,
      modifiedAt: now,
      frameNumber,
      seriesInstanceUID,
      studyInstanceUID,
    },
  };
};

const getSeriesIdentifiersFromViewport = (servicesManager, viewport, viewportInfo) => {
  const displaySetService = servicesManager?.services?.displaySetService;
  const displaySetOptions = viewportInfo?.getDisplaySetOptions?.();
  const displaySetInstanceUID = displaySetOptions?.[0]?.displaySetInstanceUID;
  if (displaySetInstanceUID && displaySetService?.getDisplaySetByUID) {
    const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);
    return {
      seriesInstanceUID: displaySet?.SeriesInstanceUID,
      studyInstanceUID: displaySet?.StudyInstanceUID,
    };
  }

  const imageId = viewport?.getCurrentImageId?.();
  if (imageId) {
    const instance = DicomMetadataStore.getInstanceByImageId(imageId);
    return {
      seriesInstanceUID: instance?.SeriesInstanceUID,
      studyInstanceUID: instance?.StudyInstanceUID,
    };
  }

  return {};
};

const getSeriesIdentifiersFromAnnotation = contour => {
  const seriesInstanceUID = contour?.data?.seriesInstanceUID;
  const studyInstanceUID = contour?.data?.studyInstanceUID;
  if (seriesInstanceUID || studyInstanceUID) {
    return { seriesInstanceUID, studyInstanceUID };
  }

  const imageId = contour?.metadata?.referencedImageId;
  if (imageId) {
    const instance = DicomMetadataStore.getInstanceByImageId(imageId);
    return {
      seriesInstanceUID: instance?.SeriesInstanceUID,
      studyInstanceUID: instance?.StudyInstanceUID,
    };
  }

  return {};
};

const resolveReferencedImageId = evt => {
  const element = evt?.detail?.element;
  if (element) {
    const enabledElement = getEnabledElement(element);
    const viewport = enabledElement?.viewport;
    const imageId = viewport?.getCurrentImageId?.();
    return { imageId, viewport };
  }

  const { viewportId, renderingEngineId } = evt?.detail || {};
  if (viewportId && renderingEngineId) {
    const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
    const viewport = enabledElement?.viewport;
    const imageId = viewport?.getCurrentImageId?.();
    return { imageId, viewport };
  }

  return {};
};

const resolveFrameNumber = viewport => {
  const currentIndex = viewport?.getCurrentImageIdIndex?.();
  if (currentIndex !== undefined && currentIndex !== null) {
    return currentIndex + 1;
  }

  const frameNumber =
    viewport?.getFrameNumber?.() ?? viewport?.getCurrentFrameNumber?.() ?? undefined;
  if (typeof frameNumber === 'number' && !Number.isNaN(frameNumber)) {
    return frameNumber;
  }

  return undefined;
};

const getContourFrameKey = contour => {
  const imageId = contour?.metadata?.referencedImageId;
  if (imageId) {
    return { type: 'imageId', value: imageId };
  }

  const frameNumber = contour?.data?.frameNumber || contour?.metadata?.frameNumber;
  if (frameNumber !== undefined) {
    return { type: 'frameNumber', value: frameNumber };
  }

  return { type: 'unknown', value: undefined };
};

const removeManualContourHints = () => {
  activeViewportHintTargets.forEach(target => {
    const hint = target.querySelector('.ovi-manual-contour-hint');
    if (hint) {
      hint.remove();
    }
  });
  activeViewportHintTargets = [];
};

const renderManualContourHints = () => {
  removeManualContourHints();
  if (typeof document === 'undefined' || isTouchCapableDevice()) {
    return;
  }

  const viewports = Array.from(document.querySelectorAll('[data-viewport-uid]'));
  activeViewportHintTargets = viewports.filter(node => node instanceof HTMLElement) as HTMLElement[];

  activeViewportHintTargets.forEach(target => {
    const hint = document.createElement('div');
    hint.className = 'ovi-manual-contour-hint';
    const lineOne = document.createElement('div');
    lineOne.textContent = 'Right-click: add/remove point';
    const lineTwo = document.createElement('div');
    lineTwo.textContent = 'Cmd/Ctrl+V: paste previous contour';
    hint.append(lineOne, lineTwo);
    target.appendChild(hint);
  });
};

const isManualContourToolActive = servicesManager => {
  const toolGroupService = servicesManager?.services?.toolGroupService;
  const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);
  return activeTool === TOOL_NAME;
};

export const showManualContourLabelMenu = ({
  uiDialogService,
  annotation: targetAnnotation,
  element,
  defaultPosition: positionOverride,
  servicesManager,
  sourceToolName = TOOL_NAME,
}) => {
  if (!uiDialogService) {
    return;
  }

  const panelWidth = 240;
  const margin = 16;
  const defaultPosition =
    positionOverride ||
    (typeof window !== 'undefined'
      ? (() => {
          const menuAnchorToolName =
            BRUSH_TOOL_NAMES.includes(sourceToolName) || isEraserLabelId(activeLabelId)
              ? BRUSH_TOOL_NAME
              : TOOL_NAME;
          const toolButton =
            window.document?.querySelector(`[data-tool="${menuAnchorToolName}"]`) ||
            window.document?.querySelector(`[data-tool="${sourceToolName}"]`) ||
            window.document?.querySelector(`[data-tool="Brush"]`);
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
      : undefined);

  // Seed the canvas scale from the active viewport so the preview is correct on first open
  if (currentCanvasPxPerMm === null && servicesManager) {
    const activeCtx = getActiveViewportContext(servicesManager);
    if (activeCtx?.element instanceof HTMLElement) {
      const seeded = computeCanvasPxPerMm(activeCtx.element);
      if (seeded !== null) {
        currentCanvasPxPerMm = seeded;
      }
    }
  }

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
      labelData: LABEL_OPTIONS.map(item => ({ label: item.label, value: item.id, color: item.color })),
      initialLabel:
        targetAnnotation?.data?.labelId && !isEraserLabelId(targetAnnotation?.data?.labelId)
          ? targetAnnotation.data.labelId
          : activeLabelId,
      brushSize: getBrushSize(),
      canvasPxPerMm: currentCanvasPxPerMm,
      showBrushSizeControl: BRUSH_TOOL_NAMES.includes(sourceToolName),
      onBrushSizeChange: value => setBrushSize(value),
      onSelect: value => {
        if (!value) {
          return;
        }
        void updateActiveLabel(
          value,
          servicesManager,
          sourceToolName,
          getActiveViewportContext(servicesManager)?.activeViewportId
        );
        if (targetAnnotation && !isEraserLabelId(value)) {
          updateAnnotationLabel(targetAnnotation, value, element);
        }
      },
    },
  });
};

export default function setupManualContourBehavior(servicesManager: AppTypes.ServicesManager) {
  const { uiDialogService, segmentationService } = servicesManager.services;
  let syncTimeoutId: number | null = null;

  setBrushSize(getBrushSize());
  setGlobalActiveManualContourLabelId(activeLabelId);
  applyToolGroupStyle(activeLabelId);
  syncToolbarButtonColors(servicesManager);
  installBrushFirstUseGuard(servicesManager);

  const queueCurrentFrameContourSync = (viewportId?: string, referencedImageId?: string) => {
    if (syncTimeoutId !== null) {
      window.clearTimeout(syncTimeoutId);
    }

    syncTimeoutId = window.setTimeout(() => {
      void syncDerivedContoursFromSegmentation({
        servicesManager,
        viewportId,
        referencedImageId,
      });
      syncTimeoutId = null;
    }, 30);
  };

  const persistManualSegmentation = async (segmentationId: string) => {
    const activeContext = getActiveViewportContext(servicesManager);
    const activeViewportId = activeContext?.activeViewportId;
    const currentImageId = activeContext?.viewport?.getCurrentImageId?.();
    const instance = currentImageId ? DicomMetadataStore.getInstanceByImageId(currentImageId) : null;
    const studyInstanceUID = instance?.StudyInstanceUID;
    const seriesInstanceUID = instance?.SeriesInstanceUID;

    if (!activeViewportId || !studyInstanceUID || !seriesInstanceUID) {
      return;
    }

    const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
    if (!activeSegmentation || activeSegmentation.segmentationId !== segmentationId) {
      return;
    }

    const frames = await readActiveSegmentationFrames({
      servicesManager,
      viewportId: activeViewportId,
    });

    const labelMap = Object.fromEntries(
      OVI_SEGMENTATION_LABELS.map(label => [
        label.segmentIndex,
        {
          labelId: label.id,
          labelName: label.name,
          labelColor: label.color,
        },
      ])
    );

    for (const frame of frames) {
      if (!frame.referencedImageId) {
        continue;
      }

      const hasData = frame.scalarData.some(value => value !== 0);
      if (!hasData) {
        await deleteSegmentationFrame({
          studyInstanceUID,
          seriesInstanceUID,
          model: 'manual',
          frameKey: frame.referencedImageId,
        });
        continue;
      }

      await saveSegmentationFrame({
        studyInstanceUID,
        seriesInstanceUID,
        model: 'manual',
        frameKey: frame.referencedImageId,
        frameNumber: frame.frameIndex + 1,
        width: frame.width,
        height: frame.height,
        maskData: new Uint8Array(frame.scalarData),
        labelMap,
        updatedAt: Date.now(),
      });
    }
  };

  const restoreManualSegmentation = async (segmentationId: string) => {
    const activeContext = getActiveViewportContext(servicesManager);
    const activeViewportId = activeContext?.activeViewportId;
    const currentImageId = activeContext?.viewport?.getCurrentImageId?.();
    const instance = currentImageId ? DicomMetadataStore.getInstanceByImageId(currentImageId) : null;
    const studyInstanceUID = instance?.StudyInstanceUID;
    const seriesInstanceUID = instance?.SeriesInstanceUID;
    const displaySetInstanceUID =
      activeContext?.viewportInfo?.getDisplaySetOptions?.()?.[0]?.displaySetInstanceUID;
    const expectedSegmentationId = displaySetInstanceUID
      ? getOviSegmentationIdForDisplaySet(displaySetInstanceUID)
      : null;

    if (
      !activeViewportId ||
      !studyInstanceUID ||
      !seriesInstanceUID ||
      !expectedSegmentationId ||
      segmentationId !== expectedSegmentationId
    ) {
      return;
    }

    const restoreKey = `${studyInstanceUID}:${seriesInstanceUID}:${segmentationId}`;
    if (restoredSegmentationKeys.has(restoreKey)) {
      return;
    }

    const frames = await loadSegmentationFrames(seriesInstanceUID, studyInstanceUID, 'manual');
    restoredSegmentationKeys.add(restoreKey);
    if (!frames.length) {
      return;
    }

    for (const frame of frames) {
      await writeMaskToActiveSegmentation({
        servicesManager,
        viewportId: activeViewportId,
        referencedImageId: frame.frameKey,
        maskData: frame.maskData,
      });

      await syncDerivedContoursFromSegmentation({
        servicesManager,
        viewportId: activeViewportId,
        referencedImageId: frame.frameKey,
      });
    }
  };

  const onToolActivated = evt => {
    const { toolGroupId, toolName } = evt.detail || {};
    if (toolGroupId !== TOOL_GROUP_ID) {
      return;
    }
    pushOviBrushDebug('onToolActivated', {
      toolGroupId,
      toolName,
      activeLabelId,
    });

    if (toolName === TOOL_NAME) {
      void ensureOviSegmentationForViewport(servicesManager);
      hideBrushCursorOverlay();
      restoreViewportCursor();
      isManualContourActive = true;
      // Sync panel to current active label
      window?.dispatchEvent?.(
        new CustomEvent(OVI_ACTIVE_LABEL_EVENT, { detail: { labelId: activeLabelId, sourceToolName: TOOL_NAME, _isFromTool: true } })
      );
      showManualContourLabelMenu({
        uiDialogService,
        servicesManager,
        sourceToolName: TOOL_NAME,
      });
      renderManualContourHints();
      setTimeout(() => syncToolbarButtonColors(servicesManager), 100);
      return;
    }

    if (BRUSH_TOOL_NAMES.includes(toolName)) {
      // Eraser clears panel selection; brush restores the last label
      const effectiveLabelId = toolName === ERASER_TOOL_NAME ? ERASER_LABEL.id : activeLabelId;
      const viewportId = getActiveViewportContext(servicesManager)?.activeViewportId;
      window?.dispatchEvent?.(
        new CustomEvent(OVI_ACTIVE_LABEL_EVENT, { detail: { labelId: effectiveLabelId, sourceToolName: toolName, _isFromTool: true } })
      );
      ensureBrushToolReady(servicesManager, activeLabelId, toolName, viewportId).then(() => {
        // Retry invalidating the cursor color after setup completes,
        // in case _hoverData was already set from a mouse move.
        segmentationUtils?.invalidateBrushCursor?.(TOOL_GROUP_ID);
      });
      isManualContourActive = false;
      removeManualContourHints();
      showManualContourLabelMenu({
        uiDialogService,
        servicesManager,
        sourceToolName: toolName,
      });
      setTimeout(() => syncToolbarButtonColors(servicesManager), 100);
      return;
    }

    if (toolName === 'MaskContour') {
      // Sync panel to show mask card as active
      window?.dispatchEvent?.(
        new CustomEvent(OVI_ACTIVE_LABEL_EVENT, { detail: { labelId: 'mask', sourceToolName: 'MaskContour', _isFromTool: true } })
      );
    }

    hideBrushCursorOverlay();
    restoreViewportCursor();
    uiDialogService.hide('manual-contour-label');
    setTimeout(() => syncToolbarButtonColors(servicesManager), 100);

    if (isManualContourActive) {
      isManualContourActive = false;
      removeManualContourHints();
    }
  };

  const onAnnotationAdded = evt => {
    const { annotation: newAnnotation } = evt.detail || {};

    if (newAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    const labelId = newAnnotation.data?.labelId || activeLabelId;
    const labelConfig = getLabelConfig(labelId);
    const resolvedContext = resolveReferencedImageId(evt);
    const activeContext = resolvedContext.viewport ? resolvedContext : getActiveViewportContext(servicesManager);
    const imageId = resolvedContext.imageId || activeContext?.viewport?.getCurrentImageId?.();
    const frameNumber = activeContext?.viewport ? resolveFrameNumber(activeContext.viewport) : undefined;
    const seriesInfo = getSeriesIdentifiersFromViewport(
      servicesManager,
      activeContext?.viewport,
      activeContext?.viewportInfo
    );

    // Add timestamp for overlap resolution (last-edited wins)
    const now = Date.now();
    newAnnotation.data = {
      ...newAnnotation.data,
      labelId,
      labelName: labelConfig.label,
      labelColor: labelConfig.color,
      fillColor: newAnnotation.data?.fillColor || labelConfig.color,
      fillOpacity: newAnnotation.data?.fillOpacity ?? DEFAULT_FILL_OPACITY,
      renderFill: newAnnotation.data?.renderFill ?? true,
      createdAt: now,
      modifiedAt: now,
      frameNumber: newAnnotation.data?.frameNumber ?? frameNumber,
      seriesInstanceUID: newAnnotation.data?.seriesInstanceUID ?? seriesInfo.seriesInstanceUID,
      studyInstanceUID: newAnnotation.data?.studyInstanceUID ?? seriesInfo.studyInstanceUID,
    };
    if (!newAnnotation.metadata?.referencedImageId && imageId) {
      newAnnotation.metadata = {
        ...newAnnotation.metadata,
        referencedImageId: imageId,
      };
    }

    applyAnnotationStyle(newAnnotation.annotationUID, labelId);
  };

  const logBrushPointerState = (
    viewportElement: HTMLElement | null,
    clientPoint?: { x: number; y: number },
    pointerType?: string
  ) => {
    const toolGroupService = servicesManager?.services?.toolGroupService;
    const { segmentationService } = servicesManager?.services || {};
    const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);
    if (!BRUSH_TOOL_NAMES.includes(activeTool)) {
      return;
    }

    const activeContext = getActiveViewportContext(servicesManager);
    const viewportId = activeContext?.activeViewportId;
    const activeSegmentation = viewportId
      ? segmentationService?.getActiveSegmentation?.(viewportId)
      : null;

    pushOviBrushDebug('brush pointer down', {
      activeTool,
      activeLabelId,
      viewportId,
      clientPoint,
      pointerType,
      elementPresent: Boolean(viewportElement),
      activeSegmentation,
      activeSegmentViewport: viewportId
        ? segmentationService?.getActiveSegment?.(viewportId)
        : null,
      activeSegmentSegmentation: activeSegmentation?.segmentationId
        ? segmentationService?.getActiveSegment?.(activeSegmentation.segmentationId)
        : null,
    });
  };

  const onNativePointerDown = (evt: PointerEvent) => {
    if (evt.pointerType !== 'mouse' && evt.pointerType !== 'pen') {
      return;
    }
    currentBrushPointerType = evt.pointerType;

    const viewportElement = getViewportElementAtPoint(evt.clientX, evt.clientY);
    if (!viewportElement) {
      return;
    }

    logBrushPointerState(
      viewportElement,
      {
        x: evt.clientX,
        y: evt.clientY,
      },
      evt.pointerType
    );
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

    if (
      !modifiedAnnotation.metadata?.referencedImageId ||
      !modifiedAnnotation.data?.frameNumber ||
      !modifiedAnnotation.data?.seriesInstanceUID
    ) {
      const activeContext = getActiveViewportContext(servicesManager);
      const imageId = activeContext?.viewport?.getCurrentImageId?.();
      const frameNumber = activeContext?.viewport ? resolveFrameNumber(activeContext.viewport) : undefined;
      const seriesInfo = getSeriesIdentifiersFromViewport(
        servicesManager,
        activeContext?.viewport,
        activeContext?.viewportInfo
      );
      if (!modifiedAnnotation.metadata?.referencedImageId && imageId) {
        modifiedAnnotation.metadata = {
          ...modifiedAnnotation.metadata,
          referencedImageId: imageId,
        };
      }
      if (!modifiedAnnotation.data?.frameNumber && frameNumber !== undefined) {
        modifiedAnnotation.data.frameNumber = frameNumber;
      }
      if (!modifiedAnnotation.data?.seriesInstanceUID && seriesInfo.seriesInstanceUID) {
        modifiedAnnotation.data.seriesInstanceUID = seriesInfo.seriesInstanceUID;
      }
      if (!modifiedAnnotation.data?.studyInstanceUID && seriesInfo.studyInstanceUID) {
        modifiedAnnotation.data.studyInstanceUID = seriesInfo.studyInstanceUID;
      }
    }
  };

  const onAnnotationCompleted = evt => {
    const completedAnnotation = evt.detail?.annotation;
    if (completedAnnotation?.metadata?.toolName !== TOOL_NAME) {
      return;
    }

    const referencedImageId = completedAnnotation.metadata?.referencedImageId;
    const viewportContext = getActiveViewportContext(servicesManager);
    const viewportId = viewportContext?.activeViewportId;
    const segmentIndex = getOviSegmentIndexForLabelId(completedAnnotation.data?.labelId || activeLabelId);
    const contourPoints =
      completedAnnotation.data?.contour?.polyline || completedAnnotation.data?.handles?.points;

    if (!referencedImageId || !contourPoints?.length) {
      return;
    }

    void writeContourToActiveSegmentation({
      servicesManager,
      viewportId,
      referencedImageId,
      worldPolyline: contourPoints,
      segmentIndex,
    }).then(() => {
      annotation.state.removeAnnotation(completedAnnotation.annotationUID);
      queueCurrentFrameContourSync(viewportId, referencedImageId);
    });
  };

  const onMouseMove = evt => {
    const { element, currentPoints } = evt.detail || {};
    const toolGroupService = servicesManager?.services?.toolGroupService;
    const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);

    if (!BRUSH_TOOL_NAMES.includes(activeTool)) {
      if (!shouldUseNativeBrushCursor() && element instanceof HTMLElement) {
        element.style.removeProperty('cursor');
      }
      hideBrushCursorOverlay();
      return;
    }

    if (!shouldUseNativeBrushCursor() && element instanceof HTMLElement) {
      element.style.setProperty('cursor', 'none', 'important');
    }

    syncBrushCursorOverlay(element, currentPoints?.canvas);
  };

  const onPointerMove = (evt: PointerEvent) => {
    const { pointerType } = evt;
    if (pointerType !== 'pen' && pointerType !== 'mouse') {
      return;
    }
    currentBrushPointerType = pointerType;

    const toolGroupService = servicesManager?.services?.toolGroupService;
    const activeTool = toolGroupService?.getActivePrimaryMouseButtonTool?.(TOOL_GROUP_ID);
    if (!BRUSH_TOOL_NAMES.includes(activeTool)) {
      hideBrushCursorOverlay();
      return;
    }

    // Ensure CSS cursor is hidden on the viewport element for mouse pointer
    if (!shouldUseNativeBrushCursor() && pointerType === 'mouse') {
      const viewportEl = getViewportElementAtPoint(evt.clientX, evt.clientY);
      if (viewportEl) {
        viewportEl.style.setProperty('cursor', 'none', 'important');
      }
    }

    syncBrushCursorOverlayAtClient(evt.clientX, evt.clientY);
  };

  const onPointerLeave = (evt: PointerEvent) => {
    if (evt.pointerType !== 'pen') {
      return;
    }

    currentBrushPointerType = null;

    hideBrushCursorOverlay();
  };

  const onPenUp = (evt: PointerEvent) => {
    if (evt.pointerType !== 'pen') {
      return;
    }

    currentBrushPointerType = null;

    hideBrushCursorOverlay();
  };

  const onCameraModified = (evt: any) => {
    const element = evt.detail?.element;
    if (!(element instanceof HTMLElement)) {
      return;
    }

    const newScale = computeCanvasPxPerMm(element);
    if (newScale !== null && newScale !== currentCanvasPxPerMm) {
      currentCanvasPxPerMm = newScale;
      window?.dispatchEvent?.(
        new CustomEvent(OVI_CANVAS_SCALE_EVENT, { detail: { canvasPxPerMm: newScale } })
      );
    }
  };

  // Eagerly create the segmentation when new images are loaded into the viewport,
  // so the brush tool is ready before the user interacts with it.
  const onViewportNewImageSet = () => {
    void ensureOviSegmentationForViewport(servicesManager);
  };

  eventTarget.addEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_MODIFIED, onAnnotationModified);
  eventTarget.addEventListener(Enums.Events.ANNOTATION_COMPLETED, onAnnotationCompleted);
  eventTarget.addEventListener(Enums.Events.MOUSE_MOVE, onMouseMove);
  eventTarget.addEventListener(CoreEnums.Events.CAMERA_MODIFIED, onCameraModified);
  eventTarget.addEventListener(CoreEnums.Events.VIEWPORT_NEW_IMAGE_SET, onViewportNewImageSet);
  window?.addEventListener?.('pointerdown', onNativePointerDown);
  window?.addEventListener?.('pointermove', onPointerMove);
  window?.addEventListener?.('pointerleave', onPointerLeave);
  window?.addEventListener?.('pointercancel', onPointerLeave);
  window?.addEventListener?.('pointerup', onPenUp);

  const segmentationSubscription = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
    ({ segmentationId }) => {
      const activeContext = getActiveViewportContext(servicesManager);
      const activeViewportId = activeContext?.activeViewportId;
      const activeSegmentation = activeViewportId
        ? segmentationService.getActiveSegmentation(activeViewportId)
        : null;
      const referencedImageId = activeContext?.viewport?.getCurrentImageId?.();

      if (!activeViewportId || !activeSegmentation?.segmentationId) {
        return;
      }

      if (activeSegmentation.segmentationId !== segmentationId) {
        return;
      }

      queueCurrentFrameContourSync(activeViewportId, referencedImageId);

      const existingTimeout = saveTimeoutBySegmentationId.get(segmentationId);
      if (existingTimeout !== undefined) {
        window.clearTimeout(existingTimeout);
      }

      const timeoutId = window.setTimeout(() => {
        saveTimeoutBySegmentationId.delete(segmentationId);
        void persistManualSegmentation(segmentationId);
      }, 500);
      saveTimeoutBySegmentationId.set(segmentationId, timeoutId);
    }
  );

  const segmentationAddedSubscription = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_ADDED,
    ({ segmentationId }) => {
      void restoreManualSegmentation(segmentationId);
    }
  );

  const onKeyDown = (evt: KeyboardEvent) => {
    if (!isManualContourActive && !isManualContourToolActive(servicesManager)) {
      return;
    }

    const isPaste =
      (evt.ctrlKey || evt.metaKey) && evt.key?.toLowerCase?.() === 'v' && !evt.shiftKey;
    if (!isPaste) {
      return;
    }

    const target = evt.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    const { viewport, element } = getActiveViewportContext(servicesManager);
    if (!viewport) {
      return;
    }

    const imageIds = viewport.getImageIds?.() || [];
    let currentIndex = viewport.getCurrentImageIdIndex?.();
    if (currentIndex === undefined) {
      const currentImageIdFallback = viewport.getCurrentImageId?.();
      if (currentImageIdFallback) {
        currentIndex = imageIds.indexOf(currentImageIdFallback);
      }
    }

    const hasImageStack =
      Array.isArray(imageIds) && imageIds.length > 0 && currentIndex !== undefined;
    const currentFrameNumber = resolveFrameNumber(viewport);
    if (!hasImageStack && (currentFrameNumber === undefined || currentFrameNumber <= 1)) {
      return;
    }

    const currentImageId = hasImageStack ? imageIds[currentIndex as number] : undefined;
    const previousImageId = hasImageStack ? imageIds[(currentIndex as number) - 1] : undefined;
    const previousFrameNumber = currentFrameNumber ? currentFrameNumber - 1 : undefined;

    const frameOfReferenceUID = viewport.getFrameOfReferenceUID?.();
    const seriesInfo = getSeriesIdentifiersFromViewport(
      servicesManager,
      viewport,
      getActiveViewportContext(servicesManager)?.viewportInfo
    );
    const annotations = getManualContourAnnotations(frameOfReferenceUID).filter(contour => {
      if (!seriesInfo.seriesInstanceUID) {
        return true;
      }
      const contourSeries = getSeriesIdentifiersFromAnnotation(contour).seriesInstanceUID;
      if (!contourSeries) {
        return true;
      }
      return contourSeries === seriesInfo.seriesInstanceUID;
    });
    if (!annotations.length) {
      return;
    }
    const hasCurrent = annotations.some(contour => {
      if (contour?.data?.labelId !== activeLabelId) {
        return false;
      }
      const key = getContourFrameKey(contour);
      if (key.type === 'imageId') {
        return currentImageId ? key.value === currentImageId : false;
      }
      if (key.type === 'frameNumber') {
        return currentFrameNumber ? key.value === currentFrameNumber : false;
      }
      return false;
    });

    if (hasCurrent) {
      return;
    }

    let sourceAnnotation = annotations.find(contour => {
      if (contour?.data?.labelId !== activeLabelId) {
        return false;
      }
      const key = getContourFrameKey(contour);
      if (key.type === 'imageId') {
        return previousImageId ? key.value === previousImageId : false;
      }
      if (key.type === 'frameNumber') {
        return previousFrameNumber ? key.value === previousFrameNumber : false;
      }
      return false;
    });

    if (!sourceAnnotation && currentFrameNumber) {
      // Fallback: pick the closest prior frame for this label
      const priorByFrame = annotations
        .filter(contour => contour?.data?.labelId === activeLabelId)
        .map(contour => {
          const key = getContourFrameKey(contour);
          if (key.type === 'frameNumber') {
            return { contour, frameNumber: key.value as number };
          }
          if (key.type === 'imageId' && hasImageStack) {
            const index = imageIds.indexOf(key.value as string);
            return index >= 0 ? { contour, frameNumber: index + 1 } : null;
          }
          return null;
        })
        .filter(Boolean)
        .filter(entry => entry.frameNumber < currentFrameNumber)
        .sort((a, b) => b.frameNumber - a.frameNumber);

      sourceAnnotation = priorByFrame[0]?.contour;
    }

    if (!sourceAnnotation) {
      return;
    }

    const newAnnotation = createManualContourAnnotation({
      sourceAnnotation,
      referencedImageId: currentImageId,
      frameNumber: currentFrameNumber,
      seriesInstanceUID: seriesInfo.seriesInstanceUID,
      studyInstanceUID: seriesInfo.studyInstanceUID,
    });

    annotation.state.addAnnotation(newAnnotation);
    isManualContourActive = true;

    if (element) {
      const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
        element,
        TOOL_NAME
      );
      utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
    }

    evt.preventDefault();
  };

  const onPencilDoubleTap = () => {
    const nextLabel = isEraserLabelId(activeLabelId) ? lastNonEraserLabelId : ERASER_LABEL.id;
    void updateActiveLabel(nextLabel, servicesManager, BRUSH_TOOL_NAME);
    showGestureHud(
      isEraserLabelId(nextLabel)
        ? 'Pencil double-tap detected: Eraser'
        : `Pencil double-tap detected: ${getLabelConfig(nextLabel).label}`
    );
  };

  const onExternalActiveLabelChange = (evt: Event) => {
    const detail = (evt as CustomEvent)?.detail || {};
    if (!detail.labelId) {
      return;
    }

    // Skip events dispatched by the tool itself — prevents echo loop
    if (detail._isFromTool) {
      return;
    }

    // Panel mask card clicked → activate MaskContour tool
    if (detail.labelId === 'mask') {
      setPrimaryTool(servicesManager, 'MaskContour');
      return;
    }

    // Use the sourceToolName from the panel — it already checks the active tool
    // (brush stays brush, contour stays contour, mask→contour switches to contour)
    const sourceToolName = detail.sourceToolName || TOOL_NAME;
    void updateActiveLabel(detail.labelId, servicesManager, sourceToolName);
  };

  window?.addEventListener?.('keydown', onKeyDown);
  window?.addEventListener?.('medex-pencil-doubletap', onPencilDoubleTap as EventListener);
  window?.addEventListener?.(OVI_ACTIVE_LABEL_EVENT, onExternalActiveLabelChange as EventListener);

  return () => {
    eventTarget.removeEventListener(Enums.Events.TOOL_ACTIVATED, onToolActivated);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_ADDED, onAnnotationAdded);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_MODIFIED, onAnnotationModified);
    eventTarget.removeEventListener(Enums.Events.ANNOTATION_COMPLETED, onAnnotationCompleted);
    eventTarget.removeEventListener(Enums.Events.MOUSE_MOVE, onMouseMove);
    eventTarget.removeEventListener(CoreEnums.Events.CAMERA_MODIFIED, onCameraModified);
    eventTarget.removeEventListener(CoreEnums.Events.VIEWPORT_NEW_IMAGE_SET, onViewportNewImageSet);
    window?.removeEventListener?.('pointerdown', onNativePointerDown);
    window?.removeEventListener?.('pointermove', onPointerMove);
    window?.removeEventListener?.('pointerleave', onPointerLeave);
    window?.removeEventListener?.('pointercancel', onPointerLeave);
    window?.removeEventListener?.('pointerup', onPenUp);
    window?.removeEventListener?.('keydown', onKeyDown);
    window?.removeEventListener?.('medex-pencil-doubletap', onPencilDoubleTap as EventListener);
    window?.removeEventListener?.(
      OVI_ACTIVE_LABEL_EVENT,
      onExternalActiveLabelChange as EventListener
    );
    segmentationSubscription.unsubscribe();
    segmentationAddedSubscription.unsubscribe();
    if (syncTimeoutId !== null) {
      window.clearTimeout(syncTimeoutId);
      syncTimeoutId = null;
    }
    saveTimeoutBySegmentationId.forEach(timeoutId => window.clearTimeout(timeoutId));
    saveTimeoutBySegmentationId.clear();
    restoredSegmentationKeys.clear();
    currentCanvasPxPerMm = null;
    removeManualContourHints();
    hideBrushCursorOverlay();
    restoreViewportCursor();
    brushCursorOverlay?.remove();
    brushCursorOverlay = null;
    gestureHudOverlay?.remove();
    gestureHudOverlay = null;
  };
}
