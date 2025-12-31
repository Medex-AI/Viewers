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
    this.configuration.showHandles = true;
    this.configuration.drawHandles = true;
    this.configuration.handleRadius = 4;

    registerPencilCursor();

    this._rightClickElementListeners = new Map();
    const baseMouseMoveCallback = this.mouseMoveCallback.bind(this);
    const baseRenderAnnotation = this.renderAnnotation.bind(this);
    const baseToolSelectedCallback = this.toolSelectedCallback.bind(this);
    const baseHandleSelectedCallback = this.handleSelectedCallback.bind(this);

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

    this.toolSelectedCallback = (evt, selectedAnnotation) => {
      const element = evt.detail?.element;
      const canvasCoords = evt.detail?.currentPoints?.canvas;
      if (!element || !canvasCoords) {
        baseToolSelectedCallback(evt, selectedAnnotation);
        return;
      }

      const annotation = selectedAnnotation as ContourAnnotation;
      const contourPoints = annotation?.data?.contour?.polyline || [];
      const enabledElement = getEnabledElement(element);
      const { viewport } = enabledElement;

      // Check if clicking on a handle
      const handleIndex = findNearestHandle(contourPoints, canvasCoords, viewport, HANDLE_PROXIMITY);

      // If not on a handle, check if near contour for moving
      if (handleIndex === null) {
        const isClosed = annotation.data?.contour?.closed || false;
        const nearContour = isPointNearContour(
          contourPoints,
          canvasCoords,
          viewport,
          HANDLE_PROXIMITY,
          isClosed
        );

        if (nearContour) {
          const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
            element,
            this.getToolName()
          );
          this._contourMoveData = {
            annotation,
            viewportIdsToRender,
          };
          this._activateContourMove(element);
          const grabCursor = cursors.MouseCursor.getDefinedCursor('grab');
          if (grabCursor) {
            cursors.elementCursor.setElementCursor(element, grabCursor);
          }
          evt.preventDefault();
          utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
          return;
        }
      }

      baseToolSelectedCallback(evt, selectedAnnotation);
    };

    this.getHandleNearImagePoint = (element, currentAnnotation, canvasCoords, proximity) => {
      const annotation = currentAnnotation as ContourAnnotation;
      const contourPoints = annotation?.data?.contour?.polyline || [];
      if (!contourPoints.length) {
        annotation.data.handles.activeHandleIndex = null;
        return;
      }

      const enabledElement = getEnabledElement(element);
      const { viewport } = enabledElement;

      const handleIndex = findNearestHandle(contourPoints, canvasCoords, viewport, proximity);

      if (handleIndex === null) {
        annotation.data.handles.activeHandleIndex = null;
        return;
      }

      annotation.data.handles.activeHandleIndex = handleIndex;
      return contourPoints[handleIndex];
    };

    this.handleSelectedCallback = (evt, selectedAnnotation, handle) => {
      const element = evt.detail?.element;
      const annotation = selectedAnnotation as ContourAnnotation;
      const contourPoints = annotation?.data?.contour?.polyline || [];
      if (contourPoints.length) {
        annotation.data.handles.points = contourPoints;
      }
      const handleIndex = annotation?.data?.handles?.activeHandleIndex;

      if (!element || handleIndex === undefined || handleIndex === null) {
        baseHandleSelectedCallback(evt, selectedAnnotation, handle);
        return;
      }

      const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
        element,
        this.getToolName()
      );

      this._handleEditData = {
        annotation,
        handleIndex,
        viewportIdsToRender,
      };

      this._activateHandleEdit(element);

      const crosshairCursor = cursors.MouseCursor.getDefinedCursor('crosshair');
      if (crosshairCursor) {
        cursors.elementCursor.setElementCursor(element, crosshairCursor);
      }

      evt.preventDefault();
      utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
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

      const enabledElement = getEnabledElement(element);
      const { viewport } = enabledElement;
      const canvasCoords = currentPoints.canvas;
      let cursorName = null;
      let shouldRender = false;
      const previousHoveredHandle = this._hoveredHandle;
      this._hoveredHandle = undefined;

      if (filteredAnnotations?.length) {
        for (const currentAnnotation of filteredAnnotations as ContourAnnotation[]) {
          if (!currentAnnotation || currentAnnotation.isLocked || !currentAnnotation.isVisible) {
            continue;
          }

          const contourPoints = currentAnnotation?.data?.contour?.polyline || [];

          // Check if hovering over a handle
          const handleIndex = findNearestHandle(contourPoints, canvasCoords, viewport, HANDLE_PROXIMITY);

          if (handleIndex !== null) {
            cursorName = 'crosshair';
            this._hoveredHandle = {
              annotationUID: currentAnnotation.annotationUID || '',
              handleIndex: handleIndex,
            };
            currentAnnotation.data.handles.activeHandleIndex = handleIndex;
            break;
          }

          currentAnnotation.data.handles.activeHandleIndex = null;

          // Check if near contour edge
          if (contourPoints.length) {
            const isClosed = currentAnnotation.data?.contour?.closed || false;
            const nearContour = isPointNearContour(
              contourPoints,
              canvasCoords,
              viewport,
              HANDLE_PROXIMITY,
              isClosed
            );
            if (nearContour) {
              cursorName = 'grab';
              break;
            }
          }

          const nearTool = this.isPointNearTool(
            element,
            currentAnnotation as any,
            canvasCoords,
            HANDLE_PROXIMITY
          );

          if (nearTool) {
            cursorName = 'grab';
            break;
          }
        }
      }

      // Check if hovered handle changed
      if (
        (previousHoveredHandle?.annotationUID !== this._hoveredHandle?.annotationUID) ||
        (previousHoveredHandle?.handleIndex !== this._hoveredHandle?.handleIndex)
      ) {
        shouldRender = true;
      }

      if (cursorName) {
        const cursor = cursors.MouseCursor.getDefinedCursor(cursorName);
        if (cursor) {
          cursors.elementCursor.setElementCursor(element, cursor);
        }
      } else if (isToolActive) {
        // Set crosshair cursor for annotation tool when not over any handle or annotation (only if tool is active)
        const crosshairCursor = cursors.MouseCursor.getDefinedCursor('crosshair');
        if (crosshairCursor) {
          cursors.elementCursor.setElementCursor(element, crosshairCursor);
        }
      }

      // Trigger render if hovered handle changed
      if (shouldRender) {
        const viewportIdsToRender = utilities.viewportFilters.getViewportIdsWithToolToRender(
          element,
          this.getToolName()
        );
        utilities.triggerAnnotationRenderForViewportIds(viewportIdsToRender);
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

      const styleSpecifier = {
        toolGroupId: this.toolGroupId,
        toolName: this.getToolName(),
        viewportId: enabledElement.viewport.id,
        annotationUID: '',
      };

      for (const currentAnnotation of annotations as ContourAnnotation[]) {
        const contourPoints = currentAnnotation?.data?.contour?.polyline || [];
        if (!contourPoints.length) {
          continue;
        }

        currentAnnotation.data.handles.points = contourPoints;

        // Convert all contour points to canvas points for handles
        const handleCanvasPoints = contourPoints.map((point: Types.Point3) => viewport.worldToCanvas(point));
        const activeHandleIndex = currentAnnotation.data?.handles?.activeHandleIndex;

        styleSpecifier.annotationUID = currentAnnotation.annotationUID;
        const { color, lineWidth } = this.getAnnotationStyle({
          annotation: currentAnnotation as any,
          styleSpecifier,
        });
        const highlightColor = this.getStyle(
          'colorHighlighted',
          styleSpecifier,
          currentAnnotation as any
        );
        const handleRadius = this.configuration.handleRadius || 6;

        // Draw all handles with semi-transparent fill for visibility
        drawing.drawHandles(
          svgDrawingHelper,
          currentAnnotation.annotationUID,
          'contour-handles',
          handleCanvasPoints,
          {
            color,
            lineWidth,
            handleRadius,
            fill: color,
            opacity: 0.6,
          }
        );

        // Highlight hovered handle
        if (
          this._hoveredHandle &&
          this._hoveredHandle.annotationUID === currentAnnotation.annotationUID &&
          this._hoveredHandle.handleIndex >= 0 &&
          this._hoveredHandle.handleIndex < handleCanvasPoints.length
        ) {
          const hoveredHandle = handleCanvasPoints[this._hoveredHandle.handleIndex];
          if (hoveredHandle) {
            drawing.drawHandles(
              svgDrawingHelper,
              currentAnnotation.annotationUID,
              'contour-handles-hovered',
              [hoveredHandle],
              {
                color: highlightColor || color,
                lineWidth: lineWidth + 1,
                handleRadius: handleRadius + 2,
                fill: highlightColor || color,
                opacity: 0.9,
              }
            );
          }
        }

        // Highlight active (being dragged) handle
        if (activeHandleIndex !== null && activeHandleIndex !== undefined) {
          const activeHandle = handleCanvasPoints[activeHandleIndex];
          if (activeHandle) {
            drawing.drawHandles(
              svgDrawingHelper,
              currentAnnotation.annotationUID,
              'contour-handles-active',
              [activeHandle],
              {
                color: highlightColor || color,
                lineWidth: lineWidth + 1,
                handleRadius: handleRadius + 3,
                fill: highlightColor || color,
                opacity: 1.0,
              }
            );
          }
        }
      }

      return renderStatus;
    };
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
      // Resample to equidistant control points with large spacing
      const resampled = resampleContourEquidistant(contourPoints, TARGET_POINT_SPACING, isClosed);
      if (resampled.length >= MIN_CONTROL_POINTS) {
        contourAnnotation.data.contour.polyline = resampled;
        contourAnnotation.data.handles.points = resampled;
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
 * Check if a point is near the contour (for moving the entire contour)
 */
function isPointNearContour(
  contourPoints: Types.Point3[],
  canvasPoint: Types.Point2,
  viewport: any,
  proximity: number,
  isClosed: boolean
): boolean {
  if (!contourPoints?.length) {
    return false;
  }

  // Check proximity to any edge
  const edgeCount = isClosed ? contourPoints.length : contourPoints.length - 1;

  for (let i = 0; i < edgeCount; i++) {
    const p1 = viewport.worldToCanvas(contourPoints[i]);
    const p2 = viewport.worldToCanvas(contourPoints[(i + 1) % contourPoints.length]);

    const distance = distanceToLineSegment(canvasPoint, p1, p2);
    if (distance <= proximity) {
      return true;
    }
  }

  return false;
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
