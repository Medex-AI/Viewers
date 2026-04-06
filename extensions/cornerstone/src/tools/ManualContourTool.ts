import { getEnabledElement, eventTarget, EVENTS, getEnabledElements } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import {
  PlanarFreehandROITool,
  annotation,
  cursors,
  drawing,
  Enums,
  state,
  utilities,
} from '@cornerstonejs/tools';

interface ContourAnnotation {
  annotationUID?: string;
  metadata?: any;
  data: {
    labelColor?: string;
    fillColor?: string;
    fillOpacity?: number;
    renderFill?: boolean;
    contour?: {
      polyline: Types.Point3[];
      closed: boolean;
    };
    handles: {
      points: Types.Point3[];
      activeHandleIndex: number | null;
    };
  };
  invalidated?: boolean;
  isLocked?: boolean;
  isVisible?: boolean;
}

const getRuntimeActiveLabelId = () =>
  typeof window !== 'undefined'
    ? (window as Window & { __oviActiveManualContourLabelId?: string }).__oviActiveManualContourLabelId
    : undefined;

const setContourDebugInfo = (message: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  (window as Window & { __oviContourDebugInfo?: string }).__oviContourDebugInfo = message;
};

const describeAnnotation = (annotationToDescribe?: ContourAnnotation | null) => {
  if (!annotationToDescribe) {
    return 'none';
  }

  return `${annotationToDescribe.annotationUID || 'no-uid'}:${annotationToDescribe.data?.labelId || 'no-label'}`;
};

const isStylusTouchInteraction = (evt: any) => {
  const event = evt?.detail?.event;
  const touches = event?.touches || [];
  const changedTouches = event?.changedTouches || [];

  return (
    Array.from(touches).some((touch: Touch & { touchType?: string }) => touch?.touchType === 'stylus') ||
    Array.from(changedTouches).some(
      (touch: Touch & { touchType?: string }) => touch?.touchType === 'stylus'
    )
  );
};

class ManualContourTool extends PlanarFreehandROITool {
  static toolName = 'ManualContour';
  _handleEditData?: {
    annotation: ContourAnnotation;
    handleIndex: number;
    viewportIdsToRender: string[];
  };
  _hoveredHandle?: {
    annotationUID: string;
    handleIndex: number;
  };
  _contourMoveData?: {
    annotation: ContourAnnotation;
    viewportIdsToRender: string[];
  };
  _dragHandleCallback: (evt: any) => void;
  _endHandleCallback: (evt: any) => void;
  _activateHandleEdit: (element: HTMLElement) => void;
  _deactivateHandleEdit: (element: HTMLElement) => void;
  _dragContourMoveCallback: (evt: any) => void;
  _endContourMoveCallback: (evt: any) => void;
  _activateContourMove: (element: HTMLElement) => void;
  _deactivateContourMove: (element: HTMLElement) => void;
  _rightClickCallback: (evt: any) => void;
  _rightClickElementListeners: Map<HTMLElement, (evt: MouseEvent) => void>;
  _elementEnabledHandler: (evt: any) => void;
  _elementDisabledHandler: (evt: any) => void;

  constructor(toolProps = {}) {
    const initialProps = {
      ...toolProps,
      configuration: {
        calculateStats: false,
        allowOpenContours: false,
        ...(toolProps as any).configuration,
      },
    };

    super(initialProps);

    this.configuration.calculateStats = false;
    this.configuration.allowOpenContours = false;
    this.configuration.showHandles = false;
    this.configuration.drawHandles = false;
    this.configuration.handleRadius = 4;

    registerPencilCursor();

    this._rightClickElementListeners = new Map();
    const baseAddNewAnnotation = this.addNewAnnotation.bind(this);
    const baseToolSelectedCallback = this.toolSelectedCallback.bind(this);
    const baseHandleSelectedCallback = this.handleSelectedCallback.bind(this);
    const baseMouseMoveCallback = this.mouseMoveCallback.bind(this);
    const baseRenderAnnotation = this.renderAnnotation.bind(this);

    this.addNewAnnotation = evt => {
      const selected = annotation.selection.getAnnotationsSelected?.() || [];
      setContourDebugInfo(
        `addNew active=${getRuntimeActiveLabelId() || 'none'} selected=${selected.join(',') || 'none'}`
      );
      return baseAddNewAnnotation(evt);
    };

    this.toolSelectedCallback = (evt, selectedAnnotation, interactionType, canvasCoords) => {
      if (interactionType === 'Touch' && isStylusTouchInteraction(evt)) {
        const selected = annotation.selection.getAnnotationsSelected?.() || [];
        selected.forEach(uid => annotation.selection.setAnnotationSelected(uid, false));
        setContourDebugInfo(
          `toolSelected->addNew active=${getRuntimeActiveLabelId() || 'none'} picked=${describeAnnotation(
            selectedAnnotation as ContourAnnotation
          )} interaction=${interactionType}`
        );
        return this.addNewAnnotation(evt);
      }

      setContourDebugInfo(
        `toolSelected active=${getRuntimeActiveLabelId() || 'none'} picked=${describeAnnotation(
          selectedAnnotation as ContourAnnotation
        )} interaction=${interactionType || 'unknown'}`
      );
      return baseToolSelectedCallback(evt, selectedAnnotation, interactionType, canvasCoords);
    };

    this.handleSelectedCallback = (evt, selectedAnnotation, handle, interactionType) => {
      if (interactionType === 'Touch' && isStylusTouchInteraction(evt)) {
        const selected = annotation.selection.getAnnotationsSelected?.() || [];
        selected.forEach(uid => annotation.selection.setAnnotationSelected(uid, false));
        setContourDebugInfo(
          `handleSelected->addNew active=${getRuntimeActiveLabelId() || 'none'} picked=${describeAnnotation(
            selectedAnnotation as ContourAnnotation
          )} interaction=${interactionType}`
        );
        return this.addNewAnnotation(evt);
      }

      setContourDebugInfo(
        `handleSelected active=${getRuntimeActiveLabelId() || 'none'} picked=${describeAnnotation(
          selectedAnnotation as ContourAnnotation
        )} handle=${handle?.index ?? 'unknown'} interaction=${interactionType || 'unknown'}`
      );
      return baseHandleSelectedCallback(evt, selectedAnnotation, handle, interactionType);
    };

    this._dragHandleCallback = evt => {
      const eventDetail = evt.detail;
      const { currentPoints, element } = eventDetail || {};
      const worldPos = currentPoints?.world;
      const { annotation: activeAnnotation, handleIndex, viewportIdsToRender } =
        this._handleEditData || {};

      if (!element || !activeAnnotation || handleIndex === undefined || !worldPos) {
        return;
      }

      const contourPoints = activeAnnotation.data?.contour?.polyline;
      if (!contourPoints || !contourPoints[handleIndex]) {
        return;
      }

      this.createMemo(element, activeAnnotation as any);

      // Calculate delta from current position
      const currentPoint = contourPoints[handleIndex];
      const delta: Types.Point3 = [
        worldPos[0] - currentPoint[0],
        worldPos[1] - currentPoint[1],
        worldPos[2] - currentPoint[2],
      ];

      const isClosed = activeAnnotation.data?.contour?.closed || false;

      // Apply soft radius effect - move nearby points with falloff
      applySoftDrag(contourPoints, handleIndex, delta, SOFT_DRAG_RADIUS, isClosed);

      activeAnnotation.data.handles.points = contourPoints;
      activeAnnotation.invalidated = true;

      utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
      if (activeAnnotation.invalidated) {
        annotation.state.triggerAnnotationModified(
          activeAnnotation as any,
          element,
          Enums.ChangeTypes.HandlesUpdated
        );
      }
    };

    this._endHandleCallback = evt => {
      const eventDetail = evt.detail;
      const { element } = eventDetail || {};

      if (element) {
        this._deactivateHandleEdit(element);
      }

      this.isDrawing = false;
      this.doneEditMemo();
      this._handleEditData = null;
    };

    this._activateHandleEdit = element => {
      state.isInteractingWithTool = true;
      element.addEventListener(Enums.Events.MOUSE_UP, this._endHandleCallback);
      element.addEventListener(Enums.Events.MOUSE_DRAG, this._dragHandleCallback);
      element.addEventListener(Enums.Events.MOUSE_CLICK, this._endHandleCallback);
      element.addEventListener(Enums.Events.TOUCH_END, this._endHandleCallback);
      element.addEventListener(Enums.Events.TOUCH_DRAG, this._dragHandleCallback);
      element.addEventListener(Enums.Events.TOUCH_TAP, this._endHandleCallback);
    };

    this._deactivateHandleEdit = element => {
      state.isInteractingWithTool = false;
      element.removeEventListener(Enums.Events.MOUSE_UP, this._endHandleCallback);
      element.removeEventListener(Enums.Events.MOUSE_DRAG, this._dragHandleCallback);
      element.removeEventListener(Enums.Events.MOUSE_CLICK, this._endHandleCallback);
      element.removeEventListener(Enums.Events.TOUCH_END, this._endHandleCallback);
      element.removeEventListener(Enums.Events.TOUCH_DRAG, this._dragHandleCallback);
      element.removeEventListener(Enums.Events.TOUCH_TAP, this._endHandleCallback);
    };

    this._dragContourMoveCallback = evt => {
      const eventDetail = evt.detail;
      const { deltaPoints, element } = eventDetail || {};
      const deltaWorld = deltaPoints?.world;
      const { annotation: activeAnnotation, viewportIdsToRender } = this._contourMoveData || {};

      if (!element || !activeAnnotation || !deltaWorld) {
        return;
      }

      const contourPoints = activeAnnotation.data?.contour?.polyline;
      if (!contourPoints?.length) {
        return;
      }

      this.createMemo(element, activeAnnotation as any);
      for (let i = 0; i < contourPoints.length; i += 1) {
        const point = contourPoints[i];
        contourPoints[i] = [
          point[0] + deltaWorld[0],
          point[1] + deltaWorld[1],
          point[2] + deltaWorld[2],
        ];
      }

      activeAnnotation.data.handles.points = contourPoints;
      activeAnnotation.invalidated = true;

      utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
      if (activeAnnotation.invalidated) {
        annotation.state.triggerAnnotationModified(
          activeAnnotation as any,
          element,
          Enums.ChangeTypes.HandlesUpdated
        );
      }
    };

    this._endContourMoveCallback = evt => {
      const eventDetail = evt.detail;
      const { element } = eventDetail || {};

      if (element) {
        this._deactivateContourMove(element);
      }

      this.isDrawing = false;
      this.doneEditMemo();
      this._contourMoveData = null;
    };

    this._activateContourMove = element => {
      state.isInteractingWithTool = true;
      element.addEventListener(Enums.Events.MOUSE_UP, this._endContourMoveCallback);
      element.addEventListener(Enums.Events.MOUSE_DRAG, this._dragContourMoveCallback);
      element.addEventListener(Enums.Events.MOUSE_CLICK, this._endContourMoveCallback);
      element.addEventListener(Enums.Events.TOUCH_END, this._endContourMoveCallback);
      element.addEventListener(Enums.Events.TOUCH_DRAG, this._dragContourMoveCallback);
      element.addEventListener(Enums.Events.TOUCH_TAP, this._endContourMoveCallback);
    };

    this._deactivateContourMove = element => {
      state.isInteractingWithTool = false;
      element.removeEventListener(Enums.Events.MOUSE_UP, this._endContourMoveCallback);
      element.removeEventListener(Enums.Events.MOUSE_DRAG, this._dragContourMoveCallback);
      element.removeEventListener(Enums.Events.MOUSE_CLICK, this._endContourMoveCallback);
      element.removeEventListener(Enums.Events.TOUCH_END, this._endContourMoveCallback);
      element.removeEventListener(Enums.Events.TOUCH_DRAG, this._dragContourMoveCallback);
      element.removeEventListener(Enums.Events.TOUCH_TAP, this._endContourMoveCallback);
    };

    const getCanvasPointFromMouseEvent = (event: MouseEvent, element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return [
        event.pageX - rect.left - window.pageXOffset,
        event.pageY - rect.top - window.pageYOffset,
      ] as Types.Point2;
    };

    this._rightClickCallback = evt => {
      const event = evt?.detail?.event ?? evt;
      const element = evt?.detail?.element ?? event?.currentTarget;
      const currentPoints = evt?.detail?.currentPoints;
      const canvasCoords =
        currentPoints?.canvas && Array.isArray(currentPoints.canvas)
          ? currentPoints.canvas
          : element && event
            ? getCanvasPointFromMouseEvent(event, element as HTMLElement)
            : null;

      // Check if it's a right-click (button 2)
      if (!event || event.button !== 2) {
        return;
      }

      if (!element || !canvasCoords) {
        return;
      }

      const enabledElement = getEnabledElement(element);
      const { viewport } = enabledElement;
      const annotations = annotation.state.getAnnotations(this.getToolName(), element);

      if (!annotations?.length) {
        return;
      }

      for (const currentAnnotation of annotations as ContourAnnotation[]) {
        if (!currentAnnotation || currentAnnotation.isLocked || !currentAnnotation.isVisible) {
          continue;
        }

        const contourPoints = currentAnnotation.data?.contour?.polyline || [];
        if (contourPoints.length < 3) {
          continue;
        }

        // Check if clicking on a handle (to remove it)
        const handleHit = findNearestHandle(contourPoints, canvasCoords, viewport, HANDLE_PROXIMITY);
        if (handleHit !== null && contourPoints.length > 3) {
          event.preventDefault();
          this.createMemo(element, currentAnnotation as any);
          contourPoints.splice(handleHit, 1);
          currentAnnotation.data.handles.points = contourPoints;
          currentAnnotation.invalidated = true;

          const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
            element,
            this.getToolName()
          );
          utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
          annotation.state.triggerAnnotationModified(
            currentAnnotation as any,
            element,
            Enums.ChangeTypes.HandlesUpdated
          );
          return;
        }

        // Check if clicking on an edge (to add a point)
        const isClosed = currentAnnotation.data?.contour?.closed || false;
        const edgeHit = findNearestEdge(contourPoints, canvasCoords, viewport, HANDLE_PROXIMITY, isClosed);
        if (edgeHit !== null) {
          event.preventDefault();
          this.createMemo(element, currentAnnotation as any);

          const worldPoint = viewport.canvasToWorld(canvasCoords);
          contourPoints.splice(edgeHit.insertIndex, 0, worldPoint);

          currentAnnotation.data.handles.points = contourPoints;
          currentAnnotation.invalidated = true;

          const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
            element,
            this.getToolName()
          );
          utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
          annotation.state.triggerAnnotationModified(
            currentAnnotation as any,
            element,
            Enums.ChangeTypes.HandlesUpdated
          );
          return;
        }
      }
    };

    this.mouseMoveCallback = (evt, filteredAnnotations) => {
      const { element, currentPoints } = evt.detail || {};
      if (!element || !currentPoints?.canvas) {
        return baseMouseMoveCallback(evt, filteredAnnotations);
      }

      // If currently drawing, let the parent handle cursor
      if (this.isDrawing) {
        return baseMouseMoveCallback(evt, filteredAnnotations);
      }

      // Only set cursor if this tool is active
      const isToolActive = this.mode === 'Active';

      this._hoveredHandle = undefined;
      if (isToolActive) {
        // Set crosshair cursor for annotation tool when not over any handle or annotation (only if tool is active)
        const crosshairCursor = cursors.MouseCursor.getDefinedCursor('crosshair');
        if (crosshairCursor) {
          cursors.elementCursor.setElementCursor(element, crosshairCursor);
        }
      }

      return baseMouseMoveCallback(evt, filteredAnnotations);
    };

    this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
      const { viewport } = enabledElement;
      const { element } = viewport;

      const renderStatus = baseRenderAnnotation(enabledElement, svgDrawingHelper);

      let annotations = annotation.state.getAnnotations(this.getToolName(), element);
      if (!annotations?.length) {
        return renderStatus;
      }

      annotations = this.filterInteractableAnnotationsForElement(element, annotations);
      if (!annotations?.length) {
        return renderStatus;
      }

      const styleSpecifier: Record<string, string> = {
        toolGroupId: this.toolGroupId,
        toolName: this.getToolName(),
        viewportId: enabledElement.viewport.id,
      };

      for (const currentAnnotation of annotations as ContourAnnotation[]) {
        const contourPoints = currentAnnotation?.data?.contour?.polyline || [];
        if (!contourPoints.length) {
          continue;
        }

        currentAnnotation.data.handles.points = contourPoints;

        styleSpecifier.annotationUID = currentAnnotation.annotationUID || '';
        const { fillColor, fillOpacity, renderFill } = this.getAnnotationStyle({
          annotation: currentAnnotation as any,
          styleSpecifier,
        }) as {
          fillColor?: string;
          fillOpacity?: number | string;
          renderFill?: boolean;
        };

        const resolvedFillColor = currentAnnotation.data?.fillColor || fillColor;
        const normalizedFillOpacity =
          currentAnnotation.data?.fillOpacity ??
          (typeof fillOpacity === 'string' ? parseFloat(fillOpacity) : fillOpacity) ??
          DEFAULT_FILL_OPACITY;
        const resolvedRenderFill = currentAnnotation.data?.renderFill ?? renderFill ?? true;

        if (
          currentAnnotation.data?.contour?.closed &&
          resolvedRenderFill !== false &&
          normalizedFillOpacity &&
          normalizedFillOpacity > 0 &&
          contourPoints.length >= 3
        ) {
          const canvasPoints = contourPoints.map(point => viewport.worldToCanvas(point));
          drawContourFill(
            svgDrawingHelper,
            currentAnnotation.annotationUID || '',
            canvasPoints,
            resolvedFillColor || currentAnnotation.data?.labelColor,
            normalizedFillOpacity
          );
        }
      }

      return renderStatus;
    };
  }

  private _annotationMatchesActiveLabel(annotationToTest: ContourAnnotation) {
    const activeLabelId = getRuntimeActiveLabelId();
    const annotationLabelId = annotationToTest?.data?.labelId;

    if (!activeLabelId || !annotationLabelId) {
      setContourDebugInfo(
        `labelCheck active=${activeLabelId || 'none'} candidate=${describeAnnotation(annotationToTest)} result=allow`
      );
      return true;
    }

    const matches = annotationLabelId === activeLabelId;
    setContourDebugInfo(
      `labelCheck active=${activeLabelId} candidate=${describeAnnotation(annotationToTest)} result=${matches ? 'allow' : 'reject'}`
    );
    return matches;
  }

  isPointNearTool(element, annotationToTest, canvasCoords, proximity) {
    if (!this._annotationMatchesActiveLabel(annotationToTest as ContourAnnotation)) {
      return false;
    }

    return super.isPointNearTool(element, annotationToTest, canvasCoords, proximity);
  }

  getHandleNearImagePoint(element, annotationToTest, canvasCoords, proximity) {
    if (!this._annotationMatchesActiveLabel(annotationToTest as ContourAnnotation)) {
      return null;
    }

    return super.getHandleNearImagePoint(element, annotationToTest, canvasCoords, proximity);
  }

  private _attachRightClickListener(element: HTMLElement) {
    if (!element || this._rightClickElementListeners.has(element)) {
      return;
    }

    const handler = (evt: MouseEvent) => this._rightClickCallback(evt);
    element.addEventListener('mousedown', handler, true);
    this._rightClickElementListeners.set(element, handler);
  }

  private _detachRightClickListener(element: HTMLElement) {
    const handler = this._rightClickElementListeners.get(element);
    if (!handler) {
      return;
    }

    element.removeEventListener('mousedown', handler, true);
    this._rightClickElementListeners.delete(element);
  }

  private _attachRightClickListeners() {
    getEnabledElements().forEach(enabledElement => {
      const element = enabledElement?.viewport?.element;
      if (element) {
        this._attachRightClickListener(element);
      }
    });
  }

  private _detachRightClickListeners() {
    Array.from(this._rightClickElementListeners.keys()).forEach(element =>
      this._detachRightClickListener(element)
    );
  }

  onSetToolActive() {
    this._attachRightClickListeners();
    this._elementEnabledHandler = evt => {
      const { element } = evt.detail || {};
      if (element) {
        this._attachRightClickListener(element);
      }
    };
    this._elementDisabledHandler = evt => {
      const { element } = evt.detail || {};
      if (element) {
        this._detachRightClickListener(element);
      }
    };
    eventTarget.addEventListener(EVENTS.ELEMENT_ENABLED, this._elementEnabledHandler);
    eventTarget.addEventListener(EVENTS.ELEMENT_DISABLED, this._elementDisabledHandler);

    // Listen for annotation completed to resample newly drawn contours
    eventTarget.addEventListener(
      Enums.Events.ANNOTATION_COMPLETED,
      this._handleAnnotationCompleted
    );
  }

  onSetToolPassive() {
    this._detachRightClickListeners();
    if (this._elementEnabledHandler) {
      eventTarget.removeEventListener(EVENTS.ELEMENT_ENABLED, this._elementEnabledHandler);
    }
    if (this._elementDisabledHandler) {
      eventTarget.removeEventListener(EVENTS.ELEMENT_DISABLED, this._elementDisabledHandler);
    }
    eventTarget.removeEventListener(
      Enums.Events.ANNOTATION_COMPLETED,
      this._handleAnnotationCompleted
    );
  }

  onSetToolDisabled() {
    this._detachRightClickListeners();
    if (this._elementEnabledHandler) {
      eventTarget.removeEventListener(EVENTS.ELEMENT_ENABLED, this._elementEnabledHandler);
    }
    if (this._elementDisabledHandler) {
      eventTarget.removeEventListener(EVENTS.ELEMENT_DISABLED, this._elementDisabledHandler);
    }
    eventTarget.removeEventListener(
      Enums.Events.ANNOTATION_COMPLETED,
      this._handleAnnotationCompleted
    );
  }

  private _handleAnnotationCompleted = (evt: any) => {
    const { annotation: completedAnnotation } = evt.detail || {};

    if (!completedAnnotation || completedAnnotation.metadata?.toolName !== this.getToolName()) {
      return;
    }

    const contourAnnotation = completedAnnotation as ContourAnnotation;
    const contourPoints = contourAnnotation.data?.contour?.polyline || [];
    const isClosed = contourAnnotation.data?.contour?.closed || false;

    if (contourPoints.length > MIN_CONTROL_POINTS) {
      const smoothed = smoothContourGeometry(contourPoints, isClosed);
      const resampled = resampleContourEquidistant(smoothed, TARGET_POINT_SPACING, isClosed);
      const finalized = smoothContourGeometry(resampled, isClosed);

      if (finalized.length >= MIN_CONTROL_POINTS) {
        contourAnnotation.data.contour.polyline = finalized;
        contourAnnotation.data.handles.points = finalized;
        contourAnnotation.invalidated = true;

        // Trigger re-render
        const element = evt.detail?.element;
        if (element) {
          const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
            element,
            this.getToolName()
          );
          utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
        }
      }
    }
  };

}

export default ManualContourTool;

// Constants
const HANDLE_PROXIMITY = 6; // Handle selection range in pixels
const TARGET_POINT_SPACING = 5.0; // Target spacing between control points in world units (mm)
const MIN_CONTROL_POINTS = 4;
const DEFAULT_FILL_OPACITY = 0.2;
const SMOOTHING_ITERATIONS = 2;
const OPEN_CONTOUR_SMOOTHING_WEIGHT = 0.2;
const SOFT_DRAG_RADIUS = 3; // Number of neighboring points affected during drag
const SOFT_DRAG_DECAY = 0.8; // Exponential decay factor for neighbor influence
const PENCIL_CURSOR_NAME = 'ManualContour.Pencil';
let isPencilCursorRegistered = false;

function registerPencilCursor() {
  if (isPencilCursorRegistered) {
    return;
  }

  cursors.registerCursor(
    PENCIL_CURSOR_NAME,
    '<g fill="none" stroke="{{color}}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 54L16 40L44 12C46 10 49 10 51 12L52 13C54 15 54 18 52 20L24 48L10 54Z" />' +
      '<path d="M18 36L28 46" />' +
      '</g>',
    { x: 64, y: 64 }
  );
  isPencilCursorRegistered = true;
}

function drawContourFill(
  svgDrawingHelper,
  annotationUID: string,
  canvasPoints: Types.Point2[],
  fillColor: string,
  fillOpacity: number
) {
  if (!annotationUID || !canvasPoints?.length || !fillColor || fillOpacity <= 0) {
    return;
  }

  const svgNodeHash = `${annotationUID}-fill`;
  const existingPolygon = svgDrawingHelper.getSvgNode(svgNodeHash);
  const points = canvasPoints.map(point => `${point[0]},${point[1]}`).join(' ');
  const attributes = {
    'data-id': svgNodeHash,
    points,
    fill: normalizeColor(fillColor),
    'fill-opacity': `${Math.max(0, Math.min(1, fillOpacity))}`,
    stroke: 'none',
    'pointer-events': 'none',
  };

  if (existingPolygon) {
    drawing.setAttributesIfNecessary(attributes, existingPolygon);
    svgDrawingHelper.setNodeTouched(svgNodeHash);
    return;
  }

  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  drawing.setNewAttributesIfValid(attributes, polygon);
  svgDrawingHelper.appendNode(polygon, svgNodeHash);
}

function normalizeColor(color: string): string {
  if (!color) {
    return color;
  }

  if (color.startsWith('#') && (color.length === 9 || color.length === 5)) {
    return color.slice(0, color.length - (color.length === 9 ? 2 : 1));
  }

  return color;
}

/**
 * Find the nearest handle (control point) to a canvas position
 * @returns The index of the nearest handle, or null if none found
 */
function findNearestHandle(
  contourPoints: Types.Point3[],
  canvasPoint: Types.Point2,
  viewport: any,
  proximity: number
): number | null {
  if (!contourPoints?.length) {
    return null;
  }

  let nearestIndex: number | null = null;
  let nearestDistance = proximity;

  for (let i = 0; i < contourPoints.length; i++) {
    const canvas = viewport.worldToCanvas(contourPoints[i]);
    const dx = canvas[0] - canvasPoint[0];
    const dy = canvas[1] - canvasPoint[1];
    const distance = Math.hypot(dx, dy);

    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  return nearestIndex;
}

/**
 * Find the nearest edge to add a new point
 * @returns Object with insertIndex for the new point, or null if none found
 */
function findNearestEdge(
  contourPoints: Types.Point3[],
  canvasPoint: Types.Point2,
  viewport: any,
  proximity: number,
  isClosed: boolean
): { insertIndex: number } | null {
  if (!contourPoints?.length) {
    return null;
  }

  let nearestEdge: { insertIndex: number } | null = null;
  let nearestDistance = proximity;

  const edgeCount = isClosed ? contourPoints.length : contourPoints.length - 1;

  for (let i = 0; i < edgeCount; i++) {
    const p1 = viewport.worldToCanvas(contourPoints[i]);
    const p2 = viewport.worldToCanvas(contourPoints[(i + 1) % contourPoints.length]);

    const distance = distanceToLineSegment(canvasPoint, p1, p2);
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearestEdge = { insertIndex: i + 1 };
    }
  }

  return nearestEdge;
}

/**
 * Calculate distance from a point to a line segment
 */
function distanceToLineSegment(
  point: Types.Point2,
  lineStart: Types.Point2,
  lineEnd: Types.Point2
): number {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    // Line segment is a point
    return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  }

  // Calculate parameter t for projection of point onto line
  let t = ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  const projX = lineStart[0] + t * dx;
  const projY = lineStart[1] + t * dy;

  return Math.hypot(point[0] - projX, point[1] - projY);
}

/**
 * Resample contour to have equidistant control points
 * This ensures consistent spacing between points in world coordinates
 */
function resampleContourEquidistant(
  points: Types.Point3[],
  targetSpacing: number,
  isClosed: boolean
): Types.Point3[] {
  if (points.length < 2) {
    return points;
  }

  // Calculate total length of the contour
  let totalLength = 0;
  const segmentLengths: number[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const length = distance3D(points[i], points[i + 1]);
    segmentLengths.push(length);
    totalLength += length;
  }

  // For closed contours, add the closing segment
  if (isClosed && points.length > 2) {
    const closingLength = distance3D(points[points.length - 1], points[0]);
    segmentLengths.push(closingLength);
    totalLength += closingLength;
  }

  // Calculate number of points based on target spacing
  const numPoints = Math.max(MIN_CONTROL_POINTS, Math.round(totalLength / targetSpacing));
  const actualSpacing = totalLength / numPoints;

  // Resample the contour
  const resampled: Types.Point3[] = [];
  resampled.push([...points[0]] as Types.Point3);

  let targetDistance = actualSpacing;
  let segmentIndex = 0;
  let segmentStart = 0;

  const allPoints = isClosed ? [...points, points[0]] : points;

  while (resampled.length < numPoints && segmentIndex < segmentLengths.length) {
    const segmentLength = segmentLengths[segmentIndex];
    const segmentEnd = segmentStart + segmentLength;

    while (targetDistance <= segmentEnd && resampled.length < numPoints) {
      // Interpolate point along this segment
      const t = (targetDistance - segmentStart) / segmentLength;
      const p1 = allPoints[segmentIndex];
      const p2 = allPoints[segmentIndex + 1];

      const newPoint: Types.Point3 = [
        p1[0] + t * (p2[0] - p1[0]),
        p1[1] + t * (p2[1] - p1[1]),
        p1[2] + t * (p2[2] - p1[2]),
      ];

      resampled.push(newPoint);
      targetDistance += actualSpacing;
    }

    segmentStart = segmentEnd;
    segmentIndex++;
  }

  return resampled;
}

function smoothContourGeometry(points: Types.Point3[], isClosed: boolean): Types.Point3[] {
  if (points.length < MIN_CONTROL_POINTS) {
    return points.map(point => [...point] as Types.Point3);
  }

  let smoothed = points.map(point => [...point] as Types.Point3);

  for (let i = 0; i < SMOOTHING_ITERATIONS; i++) {
    smoothed = isClosed
      ? chaikinSmoothClosedContour(smoothed)
      : smoothOpenContour(smoothed, OPEN_CONTOUR_SMOOTHING_WEIGHT);
  }

  return smoothed;
}

function chaikinSmoothClosedContour(points: Types.Point3[]): Types.Point3[] {
  if (points.length < 3) {
    return points.map(point => [...point] as Types.Point3);
  }

  const smoothed: Types.Point3[] = [];

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];

    smoothed.push(interpolatePoint3(current, next, 0.25));
    smoothed.push(interpolatePoint3(current, next, 0.75));
  }

  return smoothed;
}

function smoothOpenContour(points: Types.Point3[], weight: number): Types.Point3[] {
  if (points.length < 3) {
    return points.map(point => [...point] as Types.Point3);
  }

  const smoothed = points.map(point => [...point] as Types.Point3);

  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];

    smoothed[i] = [
      current[0] * (1 - 2 * weight) + (previous[0] + next[0]) * weight,
      current[1] * (1 - 2 * weight) + (previous[1] + next[1]) * weight,
      current[2] * (1 - 2 * weight) + (previous[2] + next[2]) * weight,
    ];
  }

  return smoothed;
}

function interpolatePoint3(p1: Types.Point3, p2: Types.Point3, t: number): Types.Point3 {
  return [
    p1[0] + (p2[0] - p1[0]) * t,
    p1[1] + (p2[1] - p1[1]) * t,
    p1[2] + (p2[2] - p1[2]) * t,
  ];
}

/**
 * Calculate 3D distance between two points
 */
function distance3D(p1: Types.Point3, p2: Types.Point3): number {
  return Math.hypot(
    p2[0] - p1[0],
    p2[1] - p1[1],
    p2[2] - p1[2]
  );
}

/**
 * Apply soft drag effect - moves the center point fully and neighbors with smooth falloff
 */
function applySoftDrag(
  points: Types.Point3[],
  centerIndex: number,
  delta: Types.Point3,
  radius: number,
  isClosed: boolean
): void {
  const total = points.length;
  if (total === 0) {
    return;
  }

  // Move center point fully
  points[centerIndex] = [
    points[centerIndex][0] + delta[0],
    points[centerIndex][1] + delta[1],
    points[centerIndex][2] + delta[2],
  ];

  // Move neighboring points with exponential falloff
  for (let offset = 1; offset <= radius; offset++) {
    // Exponential decay for smoother transition near the moved handle
    const weight = Math.exp(-SOFT_DRAG_DECAY * offset);
    if (weight <= 0) {
      continue;
    }

    // Apply to both sides (before and after center)
    for (const dir of [-1, 1]) {
      let index = centerIndex + offset * dir;

      if (isClosed) {
        index = (index + total) % total;
      } else if (index < 0 || index >= total) {
        continue;
      }

      points[index] = [
        points[index][0] + delta[0] * weight,
        points[index][1] + delta[1] * weight,
        points[index][2] + delta[2] * weight,
      ];
    }
  }
}
